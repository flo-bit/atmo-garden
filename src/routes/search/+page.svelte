<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { Search, Loader2 } from '@lucide/svelte';
	import { searchPosts } from '$lib/atproto/server/feed.remote';
	import { prefetchThread, ingestPosts } from '$lib/cache.svelte';
	import ScrollablePostList, { getCachedList, setCachedList } from '$lib/components/ScrollablePostList.svelte';

	let query = $state(page.url.searchParams.get('q') ?? '');
	let inputValue = $state(query);
	let postUris = $state<string[]>([]);
	let cursor = $state<string | null>(null);
	let loading = $state(false);
	let loadingMore = $state(false);
	let searched = $state(false);

	let cacheKey = $derived(`search-${query}`);

	async function doSearch(q: string) {
		if (!q.trim()) return;
		query = q.trim();
		searched = true;

		const url = new URL(window.location.href);
		url.searchParams.set('q', query);
		history.replaceState({}, '', url);

		// Restore from cache
		const cached = await getCachedList(`search-${query}`);
		if (cached) {
			postUris = cached.items as string[];
			cursor = cached.cursor;
			loading = false;
			return; // show cached, no background refresh for search
		}

		loading = true;
		postUris = [];
		cursor = null;

		try {
			const result = await searchPosts({ q: query });
			postUris = ingestPosts(result.posts);
			for (const uri of postUris) prefetchThread(uri);
			cursor = result.cursor;
			setCachedList(`search-${query}`, postUris, cursor);
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
			const newUris = ingestPosts(result.posts);
			for (const uri of newUris) prefetchThread(uri);
			postUris = [...postUris, ...newUris];
			cursor = result.cursor;
			setCachedList(`search-${query}`, postUris, cursor);
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
		{:else if searched && postUris.length === 0}
			<div class="flex flex-col items-center justify-center py-20">
				<Search class="text-base-300 dark:text-base-600 mb-3" size={40} />
				<p class="text-base-400 text-sm">No results for "{query}"</p>
			</div>
		{:else if postUris.length > 0}
			<ScrollablePostList
				items={postUris}
				{loadingMore}
				hasMore={!!cursor}
				cacheKey="search-{query}"
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
