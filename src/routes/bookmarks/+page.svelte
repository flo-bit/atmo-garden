<script lang="ts">
	import { onMount } from 'svelte';
	import { user } from '$lib/atproto/auth.svelte';
	import { ArrowLeft } from '@lucide/svelte';
	import { getBookmarks } from '$lib/atproto/server/feed.remote';
	import ScrollablePostList from '$lib/components/ScrollablePostList.svelte';
	import type { FeedItem } from '$lib/components/PostList.svelte';

	let items = $state<FeedItem[]>([]);
	let cursor = $state<string | null>(null);
	let loading = $state(true);
	let loadingMore = $state(false);

	onMount(async () => {
		if (!user.did) {
			loading = false;
			return;
		}

		try {
			const result = await getBookmarks({});
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			items = (result.posts as any[]).map((p) => ({ post: p.post ?? p }));
			cursor = result.cursor;
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
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const newItems = (result.posts as any[]).map((p) => ({ post: p.post ?? p }));
			items = [...items, ...newItems];
			cursor = result.cursor;
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
			{items}
			{loading}
			{loadingMore}
			hasMore={!!cursor}
			onLoadMore={loadMore}
			emptyText="No bookmarks yet"
		/>
	</div>
</div>
