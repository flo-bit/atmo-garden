<script lang="ts">
	import { untrack, onMount, onDestroy } from 'svelte';
	import { page } from '$app/state';
	import { Avatar, Button } from '@foxui/core';
	import { Loader2, Check, UserPlus, Plus } from '@lucide/svelte';
	import { getCommunity, getCommunityPosts } from '$lib/reddit/server/communities.remote';
	import { getQuotedPosts } from '$lib/reddit/server/quoted-posts.remote';
	import { followUser, unfollowUser, getProfile } from '$lib/atproto/server/feed.remote';
	import { user } from '$lib/atproto/auth.svelte';
	import { loginModalState } from '$lib/LoginModal.svelte';
	import RedditPostCard from '$lib/reddit/RedditPostCard.svelte';
	import SubmitModal from '$lib/reddit/SubmitModal.svelte';
	import SortTabs from '$lib/reddit/SortTabs.svelte';
	import type { PostSort, PostWithCommunity } from '$lib/reddit/db';

	type CommunityInfo = Awaited<ReturnType<typeof getCommunity>>;

	let loading = $state(true);
	let postsLoading = $state(false);
	let loadingMore = $state(false);
	let hasMore = $state(true);
	let loadError = $state<string | null>(null);
	let community = $state<CommunityInfo>(null);
	let posts = $state<PostWithCommunity[]>([]);
	let quoted = $state<Record<string, unknown>>({});
	let sort = $state<PostSort>('hot');

	// Follow state — populated after the community loads, if the user is
	// signed in. `followUri` is the AT-URI of the user's follow record
	// (needed to unfollow).
	let followUri = $state<string | null>(null);
	let joinLoading = $state(false);
	const isFollowing = $derived(followUri !== null);

	let submitOpen = $state(false);

	function onSubmitClick() {
		if (!user.did) {
			loginModalState.open = true;
			return;
		}
		submitOpen = true;
	}

	async function loadPosts(handle: string, nextSort: PostSort) {
		postsLoading = true;
		hasMore = true;
		try {
			const rows = await getCommunityPosts({ handle, limit: 50, sort: nextSort });
			posts = rows;
			quoted = {};
			if (rows.length > 0) {
				const res = await getQuotedPosts({ uris: rows.map((r) => r.quoted_post_uri) });
				quoted = res.posts;
			}
			hasMore = rows.length >= 50;
		} catch (e) {
			console.error('[community] loadPosts failed', e);
		} finally {
			postsLoading = false;
		}
	}

	async function loadMorePosts() {
		if (loadingMore || !hasMore || postsLoading || !community) return;
		loadingMore = true;
		try {
			const rows = await getCommunityPosts({
				handle: community.handle,
				limit: 50,
				sort,
				offset: posts.length
			});
			posts = [...posts, ...rows];
			if (rows.length > 0) {
				const res = await getQuotedPosts({ uris: rows.map((r) => r.quoted_post_uri) });
				quoted = { ...quoted, ...res.posts };
			}
			if (rows.length < 50) {
				hasMore = false;
			}
		} catch (e) {
			console.error('[community] loadMorePosts failed', e);
		} finally {
			loadingMore = false;
		}
	}

	function handleScroll() {
		if (!loadingMore && hasMore && !postsLoading) {
			const { scrollTop, scrollHeight, clientHeight } = document.documentElement;
			if (scrollHeight - scrollTop - clientHeight < 2000) {
				loadMorePosts();
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

	async function load(handle: string) {
		loading = true;
		loadError = null;
		community = null;
		posts = [];
		quoted = {};
		hasMore = true;
		followUri = null;
		sort = 'hot';
		try {
			const info = await getCommunity({ handle });
			if (!info) {
				loadError = 'Community not found';
				loading = false;
				return;
			}
			community = info;
			await loadPosts(handle, 'hot');

			// If the viewer is signed in, fetch viewer.following from the
			// community's profile to seed the join-button state.
			if (user.did) {
				try {
					const profile = await getProfile({ actor: info.did });
					followUri = profile.viewer?.following ?? null;
				} catch (e) {
					console.error('[community] getProfile failed', e);
				}
			}
		} catch (e) {
			console.error(e);
			loadError = 'Failed to load community';
		} finally {
			loading = false;
		}
	}

	function onSortChange(next: PostSort) {
		if (!community) return;
		loadPosts(community.handle, next);
	}

	async function onJoinClick() {
		if (!community) return;
		if (!user.did) {
			loginModalState.open = true;
			return;
		}
		if (joinLoading) return;
		joinLoading = true;
		try {
			if (isFollowing && followUri) {
				await unfollowUser({ followUri });
				followUri = null;
			} else {
				const result = await followUser({ did: community.did });
				followUri = result.uri;
			}
		} catch (e) {
			console.error('[community] toggle join failed', e);
		} finally {
			joinLoading = false;
		}
	}

	$effect(() => {
		const handle = page.params.handle;
		if (handle) untrack(() => load(handle));
	});
</script>

<div class="mx-auto w-full max-w-xl px-4 py-6 {community?.accentColor ?? ''}">
	{#if loading}
		<div class="flex items-center justify-center py-12">
			<Loader2 class="text-base-400 animate-spin" size={28} />
		</div>
	{:else if loadError}
		<p class="text-sm text-red-500">{loadError}</p>
	{:else if community}
		{@const communityShort = community.handle.split('.')[0]}
		<header class="mb-4 flex items-start gap-4">
			{#if community.avatar}
				<Avatar src={community.avatar} class="size-24 ring-2 ring-accent-500" />
			{/if}
			<div class="min-w-0 flex-1">
				<div class="flex items-center justify-between gap-2">
					<h1 class="text-xl font-bold">c/{communityShort}</h1>
					<Button
						variant={isFollowing ? 'secondary' : 'primary'}
						size="sm"
						disabled={joinLoading}
						onclick={onJoinClick}
						class="gap-1.5"
					>
						{#if joinLoading}
							<Loader2 size={14} class="animate-spin" />
						{:else if isFollowing}
							<Check size={14} />
							Joined
						{:else}
							<UserPlus size={14} />
							Join
						{/if}
					</Button>
				</div>
				<a
					href={`https://bsky.app/profile/${community.handle}`}
					target="_blank"
					rel="noopener noreferrer"
					class="text-base-500 dark:text-base-400 text-sm hover:underline"
				>
					@{community.handle}
				</a>
				{#if community.description}
					<p class="text-base-600 dark:text-base-400 mt-1 text-sm">
						{community.description}
					</p>
				{/if}
			</div>
		</header>

		{#if community.canSubmit}
			<div class="mb-6">
				<Button variant="primary" onclick={onSubmitClick} class="gap-2 mb-2">
					<Plus size={16} />
					Submit post
				</Button>
				<p class="text-xs text-base-500 dark:text-base-400">
					Or DM <a href={`https://bsky.app/profile/${community.handle}`} target="_blank" rel="noopener noreferrer" class="font-mono text-accent-600 dark:text-accent-400">@{community.handle}</a> a Bluesky post link to submit via chat.
				</p>
			</div>
		{:else}
			<div
				class="mb-6 border-base-200 dark:border-base-800 rounded-xl border bg-base-200 dark:bg-base-950/50 p-3 text-xs text-base-500 dark:text-base-400"
			>
				This community's allowlist doesn't include your account, so you can't submit posts here.
			</div>
		{/if}

		<SortTabs bind:sort onchange={onSortChange} class="mb-3" />

		{#if postsLoading}
			<div class="flex items-center justify-center py-12">
				<Loader2 class="text-base-400 animate-spin" size={24} />
			</div>
		{:else if posts.length === 0}
			<p class="text-base-500 dark:text-base-400 py-8 text-center text-sm">
				{sort === 'new' || sort === 'hot' ? 'No submissions yet.' : 'Nothing in this window.'}
			</p>
		{:else}
			<div class="divide-base-200 dark:divide-base-800 flex flex-col divide-y">
				{#each posts as p (p.uri)}
					<RedditPostCard
						row={p}
						quoted={(quoted[p.quoted_post_uri] ?? undefined) as never}
						accentColor={community.accentColor}
						showCommunity
					/>
				{/each}
			</div>
			{#if loadingMore}
				<div class="flex justify-center py-6">
					<Loader2 class="text-base-400 animate-spin" size={24} />
				</div>
			{/if}
			{#if !hasMore && posts.length > 0}
				<p class="text-base-400 py-6 text-center text-sm">You've reached the end</p>
			{/if}
		{/if}

		<SubmitModal
			bind:open={submitOpen}
			community={{ handle: community.handle, did: community.did }}
			accentColor={community.accentColor}
			onSubmitted={() => {
				if (community) loadPosts(community.handle, sort);
			}}
		/>
	{/if}
</div>
