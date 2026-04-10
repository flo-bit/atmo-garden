<script lang="ts">
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import { Hash } from '@lucide/svelte';
	import { searchPosts } from '$lib/atproto/server/feed.remote';
	import ScrollablePostList from '$lib/components/ScrollablePostList.svelte';
	import type { FeedItem } from '$lib/components/PostList.svelte';

	let tag = $derived(page.params.tag);

	let items = $state<FeedItem[]>([]);
	let cursor = $state<string | null>(null);
	let loading = $state(true);
	let loadingMore = $state(false);

	async function loadTag(t: string) {
		loading = true;
		items = [];
		cursor = null;
		try {
			const result = await searchPosts({ q: `#${t}` });
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			items = (result.posts as any[]).map((p) => ({ post: p }));
			cursor = result.cursor;
		} catch (e) {
			console.error('Failed to load hashtag:', e);
		} finally {
			loading = false;
		}
	}

	async function loadMore() {
		if (loadingMore || !cursor) return;
		loadingMore = true;
		try {
			const result = await searchPosts({ q: `#${tag}`, cursor });
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const newItems = (result.posts as any[]).map((p) => ({ post: p }));
			items = [...items, ...newItems];
			cursor = result.cursor;
		} catch (e) {
			console.error('Failed to load more:', e);
		} finally {
			loadingMore = false;
		}
	}

	$effect(() => {
		const t = tag;
		if (t) untrack(() => loadTag(t));
	});
</script>

<div>
	<div class="mx-auto w-full max-w-xl">
		<div class="flex items-center gap-2 px-4 pt-4 pb-3">
			<Hash class="text-base-400" size={20} />
			<h1 class="text-base-900 dark:text-base-100 text-lg font-semibold">{tag}</h1>
		</div>

		<ScrollablePostList
			{items}
			{loading}
			{loadingMore}
			hasMore={!!cursor}
			onLoadMore={loadMore}
			emptyText={`No posts with #${tag}`}
			endText="No more results"
		/>
	</div>
</div>
