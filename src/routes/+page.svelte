<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Loader2 } from '@lucide/svelte';
	import { getHomeFeed } from '$lib/reddit/server/communities.remote';
	import { getQuotedPosts } from '$lib/reddit/server/quoted-posts.remote';
	import { resolveProfiles } from '$lib/atproto/server/feed.remote';
	import RedditPostCard from '$lib/reddit/RedditPostCard.svelte';
	import SortTabs from '$lib/reddit/SortTabs.svelte';
	import type { PostSort, PostWithCommunity } from '$lib/reddit/db';

	type SubmitterProfile = { handle: string; displayName: string | null; avatar: string | null };

	const PAGE_SIZE = 50;

	let loading = $state(true);
	let loadingMore = $state(false);
	let hasMore = $state(true);
	let feed = $state<PostWithCommunity[]>([]);
	let quoted = $state<Record<string, unknown>>({});
	let submitters = $state<Record<string, SubmitterProfile>>({});
	let sort = $state<PostSort>('hot');

	function uniqueAuthorDids(rows: PostWithCommunity[]): string[] {
		const seen: Record<string, true> = {};
		const out: string[] = [];
		for (const r of rows) {
			if (r.author_did && !seen[r.author_did]) {
				seen[r.author_did] = true;
				out.push(r.author_did);
			}
		}
		return out;
	}

	async function loadFeed(nextSort: PostSort) {
		loading = true;
		hasMore = true;
		feed = [];
		quoted = {};
		submitters = {};
		try {
			const rows = await getHomeFeed({ limit: PAGE_SIZE, sort: nextSort });
			feed = rows;
			if (rows.length > 0) {
				const [quotedRes, profileRes] = await Promise.all([
					getQuotedPosts({ uris: rows.map((p) => p.quoted_post_uri) }),
					resolveProfiles({ dids: uniqueAuthorDids(rows) })
				]);
				quoted = quotedRes.posts;
				submitters = profileRes.profiles;
			}
			hasMore = rows.length >= PAGE_SIZE;
		} catch (e) {
			console.error('[home] loadFeed failed', e);
		} finally {
			loading = false;
		}
	}

	async function loadMore() {
		if (loadingMore || !hasMore || loading) return;
		loadingMore = true;
		try {
			const rows = await getHomeFeed({
				limit: PAGE_SIZE,
				sort,
				offset: feed.length
			});
			feed = [...feed, ...rows];
			if (rows.length > 0) {
				const [quotedRes, profileRes] = await Promise.all([
					getQuotedPosts({ uris: rows.map((p) => p.quoted_post_uri) }),
					resolveProfiles({ dids: uniqueAuthorDids(rows) })
				]);
				quoted = { ...quoted, ...quotedRes.posts };
				submitters = { ...submitters, ...profileRes.profiles };
			}
			if (rows.length < PAGE_SIZE) {
				hasMore = false;
			}
		} catch (e) {
			console.error('[home] loadMore failed', e);
		} finally {
			loadingMore = false;
		}
	}

	function handleScroll() {
		if (loadingMore || !hasMore || loading) return;
		const { scrollTop, scrollHeight, clientHeight } = document.documentElement;
		if (scrollHeight - scrollTop - clientHeight < 2000) {
			loadMore();
		}
	}

	onMount(() => {
		loadFeed('hot');
		window.addEventListener('scroll', handleScroll, { passive: true });
	});

	onDestroy(() => {
		if (typeof window !== 'undefined') {
			window.removeEventListener('scroll', handleScroll);
		}
	});
</script>

<div class="mx-auto w-full max-w-xl px-4 py-6">
	<h1 class="mb-4 text-2xl font-bold">atmo.garden</h1>

	<SortTabs bind:sort onchange={loadFeed} class="mb-3" />

	{#if loading}
		<div class="flex items-center justify-center py-12">
			<Loader2 class="text-base-400 animate-spin" size={28} />
		</div>
	{:else if feed.length === 0}
		<p class="text-base-500 dark:text-base-400 py-8 text-center text-sm">
			{sort === 'new' || sort === 'hot' ? 'No submissions yet.' : 'Nothing in this window.'}
		</p>
	{:else}
		<div class="divide-base-200 dark:divide-base-800 flex flex-col divide-y">
			{#each feed as p (p.uri)}
				<RedditPostCard
					row={p}
					quoted={(quoted[p.quoted_post_uri] ?? undefined) as never}
					submitter={p.author_did ? (submitters[p.author_did] ?? null) : null}
					showCommunity
				/>
			{/each}
		</div>
		{#if loadingMore}
			<div class="flex justify-center py-6">
				<Loader2 class="text-base-400 animate-spin" size={24} />
			</div>
		{/if}
		{#if !hasMore && feed.length > 0}
			<p class="text-base-400 py-6 text-center text-sm">You've reached the end</p>
		{/if}
	{/if}
</div>
