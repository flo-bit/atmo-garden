<script lang="ts">
	/* eslint-disable svelte/no-navigation-without-resolve */
	import { onMount } from 'svelte';
	import { Avatar, Button } from '@foxui/core';
	import { Loader2, Plus, Check, UserPlus } from '@lucide/svelte';
	import { getCommunities } from '$lib/reddit/server/communities.remote';
	import {
		followUser,
		unfollowUser,
		getProfile
	} from '$lib/atproto/server/feed.remote';
	import { user } from '$lib/atproto/auth.svelte';
	import { loginModalState } from '$lib/LoginModal.svelte';

	type Communities = Awaited<ReturnType<typeof getCommunities>>;
	type Community = Communities[number];

	let loading = $state(true);
	let communities = $state<Communities>([]);
	// Per-community join state: followUri (AT-URI of the user's own follow
	// record, null if not following) + a per-row loading flag so multiple
	// buttons can be toggled independently without blocking each other.
	let followStates = $state<Record<string, { followUri: string | null; loading: boolean }>>({});

	onMount(async () => {
		try {
			communities = await getCommunities({});
			// Seed join state for signed-in viewers. Runs in parallel —
			// latency is one getProfile call (we fire them all at once).
			if (user.did && communities.length > 0) {
				const results = await Promise.all(
					communities.map((c) =>
						getProfile({ actor: c.did })
							.then((p) => ({
								did: c.did,
								followUri: p.viewer?.following ?? null
							}))
							.catch(() => ({ did: c.did, followUri: null }))
					)
				);
				const next: typeof followStates = {};
				for (const r of results) {
					next[r.did] = { followUri: r.followUri, loading: false };
				}
				followStates = next;
			}
		} catch (e) {
			console.error('[communities] load failed', e);
		} finally {
			loading = false;
		}
	});

	async function onJoinClick(e: Event, community: Community) {
		e.preventDefault();
		e.stopPropagation();
		if (!user.did) {
			loginModalState.open = true;
			return;
		}
		const current = followStates[community.did] ?? { followUri: null, loading: false };
		if (current.loading) return;
		// Optimistic: flip the button immediately, revert on error.
		const wasFollowing = current.followUri !== null;
		followStates = {
			...followStates,
			[community.did]: { followUri: current.followUri, loading: true }
		};
		try {
			if (wasFollowing && current.followUri) {
				await unfollowUser({ followUri: current.followUri });
				followStates = {
					...followStates,
					[community.did]: { followUri: null, loading: false }
				};
			} else {
				const result = await followUser({ did: community.did });
				followStates = {
					...followStates,
					[community.did]: { followUri: result.uri, loading: false }
				};
			}
		} catch (err) {
			console.error('[communities] toggle join failed', err);
			followStates = {
				...followStates,
				[community.did]: { followUri: current.followUri, loading: false }
			};
		}
	}

	function formatCount(n: number): string {
		if (n < 1000) return String(n);
		if (n < 10_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
		if (n < 1_000_000) return Math.floor(n / 1000) + 'k';
		return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
	}
</script>

<div class="mx-auto w-full max-w-xl px-4 py-6">
	<div class="mb-4 flex items-center justify-between">
		<h1 class="text-2xl font-bold">Communities</h1>
		<a
			href="/register"
			class="bg-accent-600 hover:bg-accent-700 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium text-white transition-colors"
		>
			<Plus size={14} strokeWidth={2.5} />
			New
		</a>
	</div>

	{#if loading}
		<div class="flex items-center justify-center py-12">
			<Loader2 class="text-base-400 animate-spin" size={28} />
		</div>
	{:else if communities.length === 0}
		<p class="text-base-500 dark:text-base-400 py-8 text-center text-sm">
			No communities yet. <a href="/register" class="underline">Create the first one.</a>
		</p>
	{:else}
		<ul class="flex flex-col">
			{#each communities as c (c.did)}
				{@const short = c.handle.split('.')[0]}
				{@const state = followStates[c.did] ?? { followUri: null, loading: false }}
				{@const isFollowing = state.followUri !== null}
				<li
					class="{c.accentColor} my-2 flex items-center gap-3 rounded-2xl px-3 py-2 transition-colors hover:bg-base-100/50 dark:hover:bg-base-800/30"
				>
					<a href={`/c/${short}`} class="flex min-w-0 flex-1 items-center gap-3">
						{#if c.avatar}
							<Avatar src={c.avatar} class="size-12 ring-2 ring-accent-500" />
						{/if}
						<div class="min-w-0 flex-1">
							<div class="text-accent-600 dark:text-accent-400 font-semibold">c/{short}</div>
							{#if c.description}
								<div class="text-base-500 dark:text-base-400 truncate text-sm">
									{c.description}
								</div>
							{/if}
						</div>
					</a>
					<div class="text-base-500 dark:text-base-400 shrink-0 text-right text-xs leading-tight">
						<div>
							<span class="text-base-700 dark:text-base-300 font-semibold">{formatCount(c.followersCount)}</span>
							members
						</div>
						<div>
							<span class="text-base-700 dark:text-base-300 font-semibold">{formatCount(c.postCount)}</span>
							posts
						</div>
					</div>
					<Button
						variant={isFollowing ? 'secondary' : 'primary'}
						size="icon"
						onclick={(e: Event) => onJoinClick(e, c)}
						disabled={state.loading}
						aria-label={isFollowing ? 'Leave community' : 'Join community'}
						class="shrink-0"
					>
						{#if state.loading}
							<Loader2 size={16} class="animate-spin" />
						{:else if isFollowing}
							<Check size={16} />
						{:else}
							<UserPlus size={16} />
						{/if}
					</Button>
				</li>
			{/each}
		</ul>
	{/if}
</div>
