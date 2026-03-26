<script lang="ts">
	import { onMount } from 'svelte';
	import { user } from '$lib/atproto/auth.svelte';
	import { loadFeed } from '$lib/atproto/server/feed.remote';
	import { prefetchThread, feedCache, prefetchNotifications, setFeedUri, ingestFeedPosts } from '$lib/cache.svelte';
	import ScrollablePostList from '$lib/components/ScrollablePostList.svelte';

	const LOGGED_IN_FEED = 'at://did:plc:3guzzweuqraryl3rdkimjamk/app.bsky.feed.generator/for-you';
	const PUBLIC_FEED = 'at://did:plc:w4xbfzo7kqfes5zb7r6qv3rw/app.bsky.feed.generator/blacksky-trend';

	let feedUri = $derived(user.did ? LOGGED_IN_FEED : PUBLIC_FEED);

	$effect(() => { setFeedUri(feedUri); });

	let loadingMore = $state(false);

	async function loadInitial() {
		try {
			const result = await loadFeed({ feedUri });
			feedCache.posts = ingestFeedPosts(result.posts);
			for (const item of feedCache.posts) prefetchThread(item.uri);
			feedCache.cursor = result.cursor;
			feedCache.loaded = true;
		} catch (e) {
			console.error('Failed to load feed:', e);
			feedCache.loaded = true;
		}
	}

	onMount(() => {
		if (!feedCache.loaded || feedCache.posts.length === 0) {
			loadInitial();
		}

		if (user.did) {
			setTimeout(() => prefetchNotifications(), 1000);
		}
	});

	async function loadMore() {
		if (loadingMore || !feedCache.cursor) return;
		loadingMore = true;
		try {
			const result = await loadFeed({
				feedUri,
				cursor: feedCache.cursor
			});
			const newItems = ingestFeedPosts(result.posts);
			for (const item of newItems) prefetchThread(item.uri);
			feedCache.posts = [...feedCache.posts, ...newItems];
			feedCache.cursor = result.cursor;
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
			items={feedCache.posts}
			loading={!feedCache.loaded}
			{loadingMore}
			hasMore={!!feedCache.cursor}
			cacheKey="feed"
			onLoadMore={loadMore}
		/>
	</div>
</div>
