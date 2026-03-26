<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { UserProfile } from '@foxui/social';
	import { Button } from '@foxui/core';
	import { Loader2, LogOut } from '@lucide/svelte';
	import { user, logout } from '$lib/atproto/auth.svelte';
	import { actorToDid, getDetailedProfile } from '$lib/atproto/methods';
	import { getCachedProfile, cacheProfile } from '$lib/cache.svelte';
	import { Client, simpleFetchHandler } from '@atcute/client';

	let isOwnProfile = $derived(user.did && profile?.did === user.did);

	let loading = $state(true);
	let error = $state<string | null>(null);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let profile = $state<any>(null);

	onMount(async () => {
		const actor = page.params.actor;

		// Show cached profile instantly
		const cached = getCachedProfile(actor);
		if (cached) {
			profile = cached;
			loading = false;
		}

		// Always fetch full profile
		try {
			const did = await actorToDid(actor);
			const client = new Client({
				handler: simpleFetchHandler({ service: 'https://public.api.bsky.app' })
			});
			const fresh = await getDetailedProfile({ did, client });
			if (fresh) {
				profile = fresh;
				cacheProfile(fresh);
			} else if (!cached) {
				error = 'Profile not found';
			}
		} catch (e) {
			console.error('Failed to load profile:', e);
			if (!cached) error = 'Failed to load profile';
		} finally {
			loading = false;
		}
	});
</script>

<div class="flex h-dvh flex-col">
	<div class="mx-auto w-full max-w-xl flex-1 overflow-y-auto">
		{#if loading}
			<div class="flex items-center justify-center py-12">
				<Loader2 class="text-base-400 animate-spin" size={28} />
			</div>
		{:else if error}
			<div class="flex items-center justify-center px-4 py-12">
				<p class="text-sm text-red-500">{error}</p>
			</div>
		{:else if profile}
			<UserProfile
				profile={{
					banner: profile.banner,
					avatar: profile.avatar,
					displayName: profile.displayName,
					handle: profile.handle,
					description: profile.description
				}}
				class=""
			/>
			{#if isOwnProfile}
				<div class="px-4 py-4">
					<Button variant="ghost" onclick={logout} class="gap-2">
						<LogOut size={16} />
						Log out
					</Button>
				</div>
			{/if}
		{/if}
	</div>
</div>
