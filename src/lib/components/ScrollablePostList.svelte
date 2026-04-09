<script lang="ts">
	/**
	 * A scrollable post list with infinite scroll.
	 */
	import { onMount, onDestroy } from 'svelte';
	import { Loader2 } from '@lucide/svelte';
	import PostList, { type FeedItem } from './PostList.svelte';

	let {
		items,
		loading = false,
		loadingMore = false,
		hasMore = true,
		onLoadMore,
		emptyText = 'No posts',
		endText = "You've reached the end"
	}: {
		items: FeedItem[];
		loading?: boolean;
		loadingMore?: boolean;
		hasMore?: boolean;
		onLoadMore?: () => void;
		emptyText?: string;
		endText?: string;
	} = $props();

	function handleScroll() {
		if (!loadingMore && hasMore && onLoadMore) {
			const { scrollTop, scrollHeight, clientHeight } = document.documentElement;
			if (scrollHeight - scrollTop - clientHeight < 2000) {
				onLoadMore();
			}
		}
	}

	onMount(() => {
		window.addEventListener('scroll', handleScroll, { passive: true });
	});

	onDestroy(() => {
		if (typeof window !== 'undefined') {
			window.removeEventListener('scroll', handleScroll);
		}
	});
</script>

{#if loading}
	<div class="flex items-center justify-center py-12">
		<Loader2 class="text-base-400 animate-spin" size={28} />
	</div>
{:else if items.length === 0}
	<div class="flex h-full items-center justify-center py-12">
		<p class="text-base-500 dark:text-base-400">{emptyText}</p>
	</div>
{:else}
	<PostList {items} />

	{#if loadingMore}
		<div class="flex justify-center py-6">
			<Loader2 class="text-base-400 animate-spin" size={24} />
		</div>
	{/if}

	{#if !hasMore && items.length > 0}
		<p class="text-base-400 py-6 text-center text-sm">{endText}</p>
	{/if}

	<div class="pb-[max(0.75rem,env(safe-area-inset-bottom))]"></div>
{/if}
