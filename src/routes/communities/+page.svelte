<script lang="ts">
	/* eslint-disable svelte/no-navigation-without-resolve */
	import { onMount, onDestroy } from 'svelte';
	import { Avatar, Button } from '@foxui/core';
	import { Loader2, Plus, Check, UserPlus } from '@lucide/svelte';
	import { getCommunities, getViewerCommunityFollows } from '$lib/reddit/server/communities.remote';
	import {
		followUser,
		unfollowUser,
		getProfile
	} from '$lib/atproto/server/feed.remote';
	import { user } from '$lib/atproto/auth.svelte';
	import { loginModalState } from '$lib/LoginModal.svelte';

	type Communities = Awaited<ReturnType<typeof getCommunities>>;
	type Community = Communities[number];

	const PAGE_SIZE = 30;

	let loading = $state(true);
	let loadingMore = $state(false);
	let hasMore = $state(true);
	let communities = $state<Communities>([]);
	// Set of community DIDs the viewer follows — populated from the
	// edge-cached follow set (same cache the following-feeds use).
	// Scales O(communities) not O(viewer-follows) and is cached for
	// 5 min, so even with 500 communities this is fast (~200 ms on
	// cold miss, instant on warm hit). Loaded once on mount and
	// reused across all paginated batches — no additional follow-state
	// calls needed when scrolling.
	let followedDids = $state(new Set<string>());
	// Per-community loading flag for the join/leave button.
	let joinLoadingMap = $state<Record<string, boolean>>({});

	onMount(async () => {
		try {
			const [rows, followResult] = await Promise.all([
				getCommunities({ limit: PAGE_SIZE }),
				user.did ? getViewerCommunityFollows({}) : Promise.resolve({ dids: [] })
			]);
			communities = rows;
			followedDids = new Set(followResult.dids);
			hasMore = rows.length >= PAGE_SIZE;
		} catch (e) {
			console.error('[communities] load failed', e);
		} finally {
			loading = false;
		}
		window.addEventListener('scroll', handleScroll, { passive: true });
	});

	onDestroy(() => {
		if (typeof window !== 'undefined') {
			window.removeEventListener('scroll', handleScroll);
		}
	});

	async function loadMore() {
		if (loadingMore || !hasMore || loading) return;
		loadingMore = true;
		try {
			const rows = await getCommunities({
				limit: PAGE_SIZE,
				offset: communities.length
			});
			communities = [...communities, ...rows];
			if (rows.length < PAGE_SIZE) hasMore = false;
		} catch (e) {
			console.error('[communities] loadMore failed', e);
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

	async function onJoinClick(e: Event, community: Community) {
		e.preventDefault();
		e.stopPropagation();
		if (!user.did) {
			loginModalState.open = true;
			return;
		}
		if (joinLoadingMap[community.did]) return;
		const wasFollowing = followedDids.has(community.did);
		joinLoadingMap = { ...joinLoadingMap, [community.did]: true };
		try {
			if (wasFollowing) {
				// Lazy-resolve the follow-record URI on unfollow. This
				// is the rare path (following is far more common than
				// unfollowing), so one extra getProfile call is fine.
				const profile = await getProfile({ actor: community.did });
				const followUri = profile.viewer?.following;
				if (followUri) {
					await unfollowUser({ followUri });
				}
				followedDids = new Set([...followedDids].filter((d) => d !== community.did));
			} else {
				await followUser({ did: community.did });
				followedDids = new Set([...followedDids, community.did]);
			}
			// Refresh the edge-cached follow set so the following-feeds
			// pick up the change without waiting for the 5 min TTL.
			fetch('/api/refresh-follows', { method: 'POST' }).catch(() => {});
		} catch (err) {
			console.error('[communities] toggle join failed', err);
		} finally {
			joinLoadingMap = { ...joinLoadingMap, [community.did]: false };
		}
	}

	function formatCount(n: number): string {
		if (n < 1000) return String(n);
		if (n < 10_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
		if (n < 1_000_000) return Math.floor(n / 1000) + 'k';
		return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
	}
</script>

<div class="mx-auto w-full max-w-xl px-4 py-6">
	<div class="mb-4 flex items-center justify-between">
		<h1 class="text-2xl font-bold">Communities</h1>
		<a
			href="/register"
			class="bg-accent-600 hover:bg-accent-700 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium text-white transition-colors"
		>
			<Plus size={14} strokeWidth={2.5} />
			New
		</a>
	</div>

	{#if loading}
		<div class="flex items-center justify-center py-12">
			<Loader2 class="text-base-400 animate-spin" size={28} />
		</div>
	{:else if communities.length === 0}
		<p class="text-base-500 dark:text-base-400 py-8 text-center text-sm">
			No communities yet. <a href="/register" class="underline">Create the first one.</a>
		</p>
	{:else}
		<ul class="flex flex-col">
			{#each communities as c (c.did)}
				{@const short = c.handle.split('.')[0]}
				{@const isFollowing = followedDids.has(c.did)}
				{@const isJoinLoading = !!joinLoadingMap[c.did]}
				<li
					class="{c.accentColor} my-2 flex items-center gap-3 rounded-2xl px-3 py-2 transition-colors hover:bg-base-100/50 dark:hover:bg-base-800/30"
				>
					<a href={`/c/${short}`} class="flex min-w-0 flex-1 items-center gap-3">
						{#if c.avatar}
							<Avatar src={c.avatar} class="size-12 ring-2 ring-accent-500" />
						{/if}
						<div class="min-w-0 flex-1">
							<div class="text-accent-600 dark:text-accent-400 font-semibold">c/{short}</div>
							{#if c.description}
								<div class="text-base-500 dark:text-base-400 truncate text-sm">
									{c.description}
								</div>
							{/if}
						</div>
					</a>
					<div class="text-base-500 dark:text-base-400 shrink-0 text-right text-xs leading-tight">
						<div>
							<span class="text-base-700 dark:text-base-300 font-semibold">{formatCount(c.followersCount)}</span>
							members
						</div>
						<div>
							<span class="text-base-700 dark:text-base-300 font-semibold">{formatCount(c.postCount)}</span>
							posts
						</div>
					</div>
					<Button
						variant={isFollowing ? 'secondary' : 'primary'}
						size="icon"
						onclick={(e: Event) => onJoinClick(e, c)}
						disabled={isJoinLoading}
						aria-label={isFollowing ? 'Leave community' : 'Join community'}
						class="shrink-0"
					>
						{#if isJoinLoading}
							<Loader2 size={16} class="animate-spin" />
						{:else if isFollowing}
							<Check size={16} />
						{:else}
							<UserPlus size={16} />
						{/if}
					</Button>
				</li>
			{/each}
		</ul>
		{#if loadingMore}
			<div class="flex justify-center py-6">
				<Loader2 class="text-base-400 animate-spin" size={24} />
			</div>
		{/if}
		{#if !hasMore && communities.length > 0}
			<p class="text-base-400 py-6 text-center text-sm">You've reached the end</p>
		{/if}
	{/if}
</div>
