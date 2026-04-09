<script lang="ts">
	/* eslint-disable svelte/no-navigation-without-resolve */
	import { onMount } from 'svelte';
	import { Avatar } from '@foxui/core';
	import { Loader2 } from '@lucide/svelte';
	import {
		getCommunities,
		getHomeFeed
	} from '$lib/reddit/server/communities.remote';
	import { getQuotedPosts } from '$lib/reddit/server/quoted-posts.remote';
	import RedditPostCard from '$lib/reddit/RedditPostCard.svelte';
	import type { PostWithCommunity } from '$lib/reddit/db';

	type Communities = Awaited<ReturnType<typeof getCommunities>>;

	let loading = $state(true);
	let communities = $state<Communities>([]);
	let feed = $state<PostWithCommunity[]>([]);
	let quoted = $state<Record<string, unknown>>({});

	onMount(async () => {
		try {
			const [c, f] = await Promise.all([
				getCommunities({}),
				getHomeFeed({ limit: 50 })
			]);
			communities = c;
			feed = f;
			if (f.length > 0) {
				const res = await getQuotedPosts({ uris: f.map((p) => p.quoted_post_uri) });
				quoted = res.posts;
			}
		} catch (e) {
			console.error(e);
		} finally {
			loading = false;
		}
	});
</script>

<div class="mx-auto w-full max-w-lg px-4 py-6">
	<h1 class="mb-4 text-2xl font-bold">atmo communities</h1>

	<section class="mb-6">
		<div class="mb-2 flex items-center justify-between">
			<h2 class="text-xs font-semibold uppercase tracking-wide text-base-500 dark:text-base-400">
				Communities
			</h2>
			<a href="/register" class="text-xs text-accent-600 hover:underline dark:text-accent-400">
				+ Register
			</a>
		</div>

		{#if loading && communities.length === 0}
			<div class="text-base-500 dark:text-base-400 text-sm">Loading…</div>
		{:else if communities.length === 0}
			<div class="text-base-500 dark:text-base-400 text-sm">
				No communities registered yet.
				<a href="/register" class="underline">Register the first one.</a>
			</div>
		{:else}
			<div class="flex flex-wrap gap-2">
				{#each communities as c (c.did)}
					<a
						href={`/community/${c.handle}`}
						class="border-base-200 dark:border-base-800 bg-base-50 dark:bg-base-900 hover:bg-base-100 dark:hover:bg-base-800 flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors"
					>
						<Avatar src={c.avatar ?? undefined} class="size-5" />
						<span>{c.display_name ?? c.handle}</span>
					</a>
				{/each}
			</div>
		{/if}
	</section>

	<section>
		<h2 class="mb-3 text-xs font-semibold uppercase tracking-wide text-base-500 dark:text-base-400">
			Latest
		</h2>

		{#if loading}
			<div class="flex items-center justify-center py-12">
				<Loader2 class="text-base-400 animate-spin" size={28} />
			</div>
		{:else if feed.length === 0}
			<p class="text-base-500 dark:text-base-400 py-8 text-center text-sm">
				No submissions yet.
			</p>
		{:else}
			<div class="flex flex-col gap-3">
				{#each feed as p (p.uri)}
					<RedditPostCard row={p} quoted={(quoted[p.quoted_post_uri] ?? undefined) as never} showCommunity />
				{/each}
			</div>
		{/if}
	</section>
</div>
