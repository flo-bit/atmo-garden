<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { Search, Loader2 } from '@lucide/svelte';
	import { searchPosts } from '$lib/atproto/server/feed.remote';
	import ScrollablePostList from '$lib/components/ScrollablePostList.svelte';
	import type { FeedItem } from '$lib/components/PostList.svelte';

	let query = $state(page.url.searchParams.get('q') ?? '');
	let inputValue = $state(query);
	let items = $state<FeedItem[]>([]);
	let cursor = $state<string | null>(null);
	let loading = $state(false);
	let loadingMore = $state(false);
	let searched = $state(false);

	async function doSearch(q: string) {
		if (!q.trim()) return;
		query = q.trim();
		searched = true;

		const url = new URL(window.location.href);
		url.searchParams.set('q', query);
		history.replaceState({}, '', url);

		loading = true;
		items = [];
		cursor = null;

		try {
			const result = await searchPosts({ q: query });
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			items = (result.posts as any[]).map((p) => ({ post: p }));
			cursor = result.cursor;
		} catch (e) {
			console.error('Search failed:', e);
		} finally {
			loading = false;
		}
	}

	async function loadMore() {
		if (loadingMore || !cursor || !query) return;
		loadingMore = true;
		try {
			const result = await searchPosts({ q: query, cursor });
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

	function handleSubmit(e: Event) {
		e.preventDefault();
		doSearch(inputValue);
	}

	onMount(() => {
		if (query) doSearch(query);
	});
</script>

<div>
	<div class="mx-auto w-full max-w-lg">
		<form onsubmit={handleSubmit} class="px-4 pt-4 pb-3">
			<div class="relative">
				<Search class="text-base-400 absolute top-1/2 left-3 -translate-y-1/2" size={16} />
				<input
					type="text"
					bind:value={inputValue}
					placeholder="Search posts..."
					class="border-base-200 bg-base-50 text-base-900 placeholder:text-base-400 focus:border-accent-400 focus:ring-accent-400 dark:border-base-700 dark:bg-base-900 dark:text-base-100 dark:placeholder:text-base-500 w-full rounded-full border py-2 pr-4 pl-9 text-sm focus:ring-1 focus:outline-none"
				/>
			</div>
		</form>

		{#if loading}
			<div class="flex items-center justify-center py-12">
				<Loader2 class="text-base-400 animate-spin" size={28} />
			</div>
		{:else if searched && items.length === 0}
			<div class="flex flex-col items-center justify-center py-20">
				<Search class="text-base-300 dark:text-base-600 mb-3" size={40} />
				<p class="text-base-400 text-sm">No results for "{query}"</p>
			</div>
		{:else if items.length > 0}
			<ScrollablePostList
				{items}
				{loadingMore}
				hasMore={!!cursor}
				onLoadMore={loadMore}
				endText="No more results"
			/>
		{:else if !searched}
			<div class="flex flex-col items-center justify-center py-20">
				<Search class="text-base-300 dark:text-base-600 mb-3" size={40} />
				<p class="text-base-400 text-sm">Search for posts on Bluesky</p>
			</div>
		{/if}
	</div>
</div>
