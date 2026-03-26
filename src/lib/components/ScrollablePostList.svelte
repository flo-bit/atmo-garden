<script lang="ts">
	/**
	 * A scrollable post list with:
	 * - Scroll position save/restore (keyed by a cache key)
	 * - Infinite scroll (calls onLoadMore when near bottom)
	 * - Loading/end-of-list indicators
	 */
	import { onMount, onDestroy, tick } from 'svelte';
	import { Loader2 } from '@lucide/svelte';
	import PostList from './PostList.svelte';
	import type { FeedItem } from '$lib/cache.svelte';

	type PostListItem = FeedItem | string;

	let {
		items,
		loading = false,
		loadingMore = false,
		hasMore = true,
		cacheKey,
		onLoadMore,
		emptyText = 'No posts',
		endText = "You've reached the end"
	}: {
		items: PostListItem[];
		loading?: boolean;
		loadingMore?: boolean;
		hasMore?: boolean;
		cacheKey: string;
		onLoadMore?: () => void;
		emptyText?: string;
		endText?: string;
	} = $props();

	// Scroll position cache (module-level, survives navigations)
	const scrollCache = getScrollCache();

	let saveFrozen = false;

	function handleScroll() {
		// Continuously save scroll position (onDestroy is too late — SvelteKit resets scroll during navigation)
		// Don't save during the freeze period after restore (avoids drift from image loading)
		if (window.scrollY > 0 && !saveFrozen) {
			scrollCache.set(cacheKey, window.scrollY);
		}

		// Infinite scroll
		if (!loadingMore && hasMore && onLoadMore) {
			const { scrollTop, scrollHeight, clientHeight } = document.documentElement;
			if (scrollHeight - scrollTop - clientHeight < 2000) {
				onLoadMore();
			}
		}
	}

	let scrollRestored = false;
	const shouldRestore = wasPopstate();

	function tryRestoreScroll() {
		if (scrollRestored || !shouldRestore) return;
		const saved = scrollCache.get(cacheKey);
		if (!saved || items.length === 0) return;
		scrollRestored = true;
		// Freeze saving for 2s after restore to prevent drift from lazy-loading images
		saveFrozen = true;
		setTimeout(() => { saveFrozen = false; }, 2000);
		tick().then(() => {
			window.scrollTo(0, saved);
		});
	}

	onMount(() => {
		tryRestoreScroll();
		window.addEventListener('scroll', handleScroll, { passive: true });
	});

	// Try restore when items arrive async after mount
	$effect(() => {
		if (items.length > 0) tryRestoreScroll(); // eslint-disable-line svelte/no-reactive-reassign
	});

	onDestroy(() => {
		if (typeof window !== 'undefined') {
			window.removeEventListener('scroll', handleScroll);
		}
	});
</script>

<script lang="ts" module>
	import type { FeedItem as FeedItemType } from '$lib/cache.svelte';
	import { stateStore } from '$lib/db.svelte';
	import { browser } from '$app/environment';

	// Scroll positions — in-memory only (no need to persist across sessions)
	const _scrollCache = new Map<string, number>();

	// Track whether the last navigation was a back/forward (popstate)
	let _wasPopstate = false;

	if (browser) {
		window.addEventListener('popstate', () => {
			_wasPopstate = true;
		});
		// Reset after each navigation settles
		const origPushState = history.pushState.bind(history);
		const origReplaceState = history.replaceState.bind(history);
		history.pushState = (...args) => { _wasPopstate = false; return origPushState(...args); };
		history.replaceState = (...args) => { return origReplaceState(...args); };
	}

	export function wasPopstate() {
		return _wasPopstate;
	}

	export function getScrollCache() {
		return _scrollCache;
	}

	/**
	 * Get cached list data for a page key (from Dexie).
	 */
	export async function getCachedList(key: string): Promise<{ items: (FeedItemType | string)[]; cursor: string | null } | undefined> {
		const data = await stateStore.get(`list:${key}`);
		return data ?? undefined;
	}

	/**
	 * Save list data for a page key (to Dexie).
	 */
	export function setCachedList(key: string, items: (FeedItemType | string)[], cursor: string | null) {
		stateStore.set(`list:${key}`, { items, cursor }).catch(() => {});
	}
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
