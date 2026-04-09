<script lang="ts">
	/* eslint-disable svelte/no-navigation-without-resolve */
	import { onMount } from 'svelte';
	import { Avatar } from '@foxui/core';
	import { Loader2, Plus } from '@lucide/svelte';
	import { getCommunities } from '$lib/reddit/server/communities.remote';

	type Communities = Awaited<ReturnType<typeof getCommunities>>;

	let loading = $state(true);
	let communities = $state<Communities>([]);

	onMount(async () => {
		try {
			communities = await getCommunities({});
		} catch (e) {
			console.error(e);
		} finally {
			loading = false;
		}
	});
</script>

<div class="mx-auto w-full max-w-lg px-4 py-6">
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
		<ul class="divide-base-200 dark:divide-base-800 flex flex-col divide-y">
			{#each communities as c (c.did)}
				{@const short = c.handle.split('.')[0]}
				<li>
					<a
						href={`/c/${short}`}
						class="flex items-center gap-3 py-3 transition-colors hover:bg-base-100/50 dark:hover:bg-base-800/30"
					>
						<Avatar src={c.avatar ?? undefined} class="size-12" />
						<div class="min-w-0 flex-1">
							<div class="font-semibold">c/{short}</div>
							{#if c.description}
								<div class="text-base-500 dark:text-base-400 truncate text-sm">
									{c.description}
								</div>
							{/if}
						</div>
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</div>
