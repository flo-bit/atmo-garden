<script lang="ts">
	import { onMount } from 'svelte';
	import { Loader2 } from '@lucide/svelte';
	import { getHomeFeed } from '$lib/reddit/server/communities.remote';
	import { getQuotedPosts } from '$lib/reddit/server/quoted-posts.remote';
	import RedditPostCard from '$lib/reddit/RedditPostCard.svelte';
	import type { PostWithCommunity } from '$lib/reddit/db';

	let loading = $state(true);
	let feed = $state<PostWithCommunity[]>([]);
	let quoted = $state<Record<string, unknown>>({});

	onMount(async () => {
		try {
			const f = await getHomeFeed({ limit: 50 });
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

<div class="mx-auto w-full max-w-xl px-4 py-6">
	<h1 class="mb-4 text-2xl font-bold">atmo.garden</h1>

	{#if loading}
		<div class="flex items-center justify-center py-12">
			<Loader2 class="text-base-400 animate-spin" size={28} />
		</div>
	{:else if feed.length === 0}
		<p class="text-base-500 dark:text-base-400 py-8 text-center text-sm">
			No submissions yet.
		</p>
	{:else}
		<div class="divide-base-200 dark:divide-base-800 flex flex-col divide-y">
			{#each feed as p (p.uri)}
				<RedditPostCard
					row={p}
					quoted={(quoted[p.quoted_post_uri] ?? undefined) as never}
					showCommunity
				/>
			{/each}
		</div>
	{/if}
</div>
