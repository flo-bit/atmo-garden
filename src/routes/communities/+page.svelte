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

	function formatCount(n: number): string {
		if (n < 1000) return String(n);
		if (n < 10_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
		if (n < 1_000_000) return Math.floor(n / 1000) + 'k';
		return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
	}
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
				<li class={c.accentColor}>
					<a
						href={`/c/${short}`}
						class="flex items-center gap-3 py-3 transition-colors hover:bg-base-100/50 dark:hover:bg-base-800/30"
					>
						{#if c.avatar}
							<Avatar src={c.avatar} class="size-12 ring-2 ring-accent-500" />
						{/if}
						<div class="min-w-0 flex-1">
							<div class="font-semibold text-accent-600 dark:text-accent-400">c/{short}</div>
							{#if c.description}
								<div class="text-base-500 dark:text-base-400 truncate text-sm">
									{c.description}
								</div>
							{/if}
						</div>
						<div class="text-base-500 dark:text-base-400 shrink-0 text-right text-xs">
							<div class="text-base-700 dark:text-base-300 font-semibold">
								{formatCount(c.followersCount)}
							</div>
							<div>members</div>
						</div>
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</div>
