<script lang="ts">
	import { onMount } from 'svelte';
	import { user } from '$lib/atproto/auth.svelte';
	import { loadFeed } from '$lib/atproto/server/feed.remote';
	import ScrollablePostList from '$lib/components/ScrollablePostList.svelte';
	import type { FeedItem } from '$lib/components/PostList.svelte';

	const LOGGED_IN_FEED = 'at://did:plc:3guzzweuqraryl3rdkimjamk/app.bsky.feed.generator/for-you';
	const PUBLIC_FEED = 'at://did:plc:w4xbfzo7kqfes5zb7r6qv3rw/app.bsky.feed.generator/blacksky-trend';

	let feedUri = $derived(user.did ? LOGGED_IN_FEED : PUBLIC_FEED);

	let items = $state<FeedItem[]>([]);
	let cursor = $state<string | null>(null);
	let loading = $state(true);
	let loadingMore = $state(false);

	async function loadInitial() {
		loading = true;
		try {
			const result = await loadFeed({ feedUri });
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			items = result.posts as any[];
			cursor = result.cursor;
		} catch (e) {
			console.error('Failed to load feed:', e);
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		loadInitial();
	});

	async function loadMore() {
		if (loadingMore || !cursor) return;
		loadingMore = true;
		try {
			const result = await loadFeed({ feedUri, cursor });
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			items = [...items, ...(result.posts as any[])];
			cursor = result.cursor;
		} catch (e) {
			console.error('Failed to load more:', e);
		} finally {
			loadingMore = false;
		}
	}
</script>

<div>
	<div class="mx-auto w-full max-w-lg">
		<ScrollablePostList
			{items}
			{loading}
			{loadingMore}
			hasMore={!!cursor}
			onLoadMore={loadMore}
		/>
	</div>
</div>
