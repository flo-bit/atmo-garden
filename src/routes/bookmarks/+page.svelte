<script lang="ts">
	import { onMount } from 'svelte';
	import { user } from '$lib/atproto/auth.svelte';
	import { ArrowLeft } from '@lucide/svelte';
	import { getBookmarks } from '$lib/atproto/server/feed.remote';
	import { ingestPosts, prefetchThread } from '$lib/cache.svelte';
	import ScrollablePostList, { getCachedList, setCachedList } from '$lib/components/ScrollablePostList.svelte';

	const CACHE_KEY = 'bookmarks';

	let postUris = $state<string[]>([]);
	let cursor = $state<string | null>(null);
	let loading = $state(true);
	let loadingMore = $state(false);

	onMount(async () => {
		if (!user.did) return;

		// Restore from cache for instant display
		const cached = await getCachedList(CACHE_KEY);
		if (cached) {
			postUris = cached.items as string[];
			cursor = cached.cursor;
			loading = false;
		}

		// Fetch fresh in background
		try {
			const result = await getBookmarks({});
			const freshUris = ingestPosts(result.posts);
			for (const uri of freshUris) prefetchThread(uri);
			// Only update visible list if we didn't show cached (avoid layout shift while scrolled)
			if (!cached) {
				postUris = freshUris;
				cursor = result.cursor;
			}
			setCachedList(CACHE_KEY, freshUris, result.cursor);
		} catch (e) {
			console.error('Failed to load bookmarks:', e);
		} finally {
			loading = false;
		}
	});

	async function loadMore() {
		if (loadingMore || !cursor) return;
		loadingMore = true;
		try {
			const result = await getBookmarks({ cursor });
			const newUris = ingestPosts(result.posts);
			for (const uri of newUris) prefetchThread(uri);
			postUris = [...postUris, ...newUris];
			cursor = result.cursor;
			setCachedList(CACHE_KEY, postUris, cursor);
		} catch (e) {
			console.error('Failed to load more bookmarks:', e);
		} finally {
			loadingMore = false;
		}
	}
</script>

<div>
	<div class="mx-auto w-full max-w-lg py-4">
		<div class="mb-2 ml-4 flex items-center gap-2 sm:ml-0">
			<button
				onclick={() => history.back()}
				class="text-base-500 hover:text-base-700 dark:text-base-400 dark:hover:text-base-200 rounded-lg p-1.5 transition-colors"
			>
				<ArrowLeft size={20} />
			</button>
			<h1 class="text-base-900 dark:text-base-100 text-lg font-semibold">Bookmarks</h1>
		</div>

		<ScrollablePostList
			items={postUris}
			{loading}
			{loadingMore}
			hasMore={!!cursor}
			cacheKey={CACHE_KEY}
			onLoadMore={loadMore}
			emptyText="No bookmarks yet"
		/>
	</div>
</div>
