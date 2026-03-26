<script lang="ts">
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import { Hash } from '@lucide/svelte';
	import { searchPosts } from '$lib/atproto/server/feed.remote';
	import { prefetchThread, ingestPosts } from '$lib/cache.svelte';
	import ScrollablePostList, { getCachedList, setCachedList } from '$lib/components/ScrollablePostList.svelte';

	let tag = $derived(page.params.tag);

	let postUris = $state<string[]>([]);
	let cursor = $state<string | null>(null);
	let loading = $state(true);
	let loadingMore = $state(false);

	async function loadTag(t: string) {
		const key = `hashtag-${t}`;
		const cached = await getCachedList(key);
		if (cached) {
			postUris = cached.items as string[];
			cursor = cached.cursor;
			loading = false;
			return;
		}

		loading = true;
		postUris = [];
		cursor = null;
		try {
			const result = await searchPosts({ q: `#${t}` });
			postUris = ingestPosts(result.posts);
			for (const uri of postUris) prefetchThread(uri);
			cursor = result.cursor;
			setCachedList(key, postUris, cursor);
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
			const newUris = ingestPosts(result.posts);
			for (const uri of newUris) prefetchThread(uri);
			postUris = [...postUris, ...newUris];
			cursor = result.cursor;
			setCachedList(`hashtag-${tag}`, postUris, cursor);
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
	<div class="mx-auto w-full max-w-lg">
		<div class="flex items-center gap-2 px-4 pt-4 pb-3">
			<Hash class="text-base-400" size={20} />
			<h1 class="text-base-900 dark:text-base-100 text-lg font-semibold">{tag}</h1>
		</div>

		<ScrollablePostList
			items={postUris}
			{loading}
			{loadingMore}
			hasMore={!!cursor}
			cacheKey={`hashtag-${tag}`}
			onLoadMore={loadMore}
			emptyText={`No posts with #${tag}`}
			endText="No more results"
		/>
	</div>
</div>
