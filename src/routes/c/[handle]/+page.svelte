<script lang="ts">
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import { Avatar, Button } from '@foxui/core';
	import { Loader2, Check, UserPlus } from '@lucide/svelte';
	import { getCommunity, getCommunityPosts } from '$lib/reddit/server/communities.remote';
	import { getQuotedPosts } from '$lib/reddit/server/quoted-posts.remote';
	import { followUser, unfollowUser, getProfile } from '$lib/atproto/server/feed.remote';
	import { user } from '$lib/atproto/auth.svelte';
	import { loginModalState } from '$lib/LoginModal.svelte';
	import RedditPostCard from '$lib/reddit/RedditPostCard.svelte';
	import type { PostWithCommunity } from '$lib/reddit/db';

	type CommunityInfo = Awaited<ReturnType<typeof getCommunity>>;

	type Sort = 'new' | 'top-day' | 'top-week' | 'top-month';
	const SORT_LABELS: Record<Sort, string> = {
		'new': 'New',
		'top-day': 'Today',
		'top-week': 'This week',
		'top-month': 'This month'
	};
	const SORT_OPTIONS: Sort[] = ['new', 'top-day', 'top-week', 'top-month'];

	let loading = $state(true);
	let postsLoading = $state(false);
	let loadError = $state<string | null>(null);
	let community = $state<CommunityInfo>(null);
	let posts = $state<PostWithCommunity[]>([]);
	let quoted = $state<Record<string, unknown>>({});
	let sort = $state<Sort>('new');

	// Follow state — populated after the community loads, if the user is
	// signed in. `followUri` is the AT-URI of the user's follow record
	// (needed to unfollow).
	let followUri = $state<string | null>(null);
	let joinLoading = $state(false);
	const isFollowing = $derived(followUri !== null);

	async function loadPosts(handle: string, nextSort: Sort) {
		postsLoading = true;
		try {
			const rows = await getCommunityPosts({ handle, limit: 50, sort: nextSort });
			posts = rows;
			quoted = {};
			if (rows.length > 0) {
				const res = await getQuotedPosts({ uris: rows.map((r) => r.quoted_post_uri) });
				quoted = res.posts;
			}
		} catch (e) {
			console.error('[community] loadPosts failed', e);
		} finally {
			postsLoading = false;
		}
	}

	async function load(handle: string) {
		loading = true;
		loadError = null;
		community = null;
		posts = [];
		quoted = {};
		followUri = null;
		sort = 'new';
		try {
			const info = await getCommunity({ handle });
			if (!info) {
				loadError = 'Community not found';
				loading = false;
				return;
			}
			community = info;
			await loadPosts(handle, 'new');

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

	function onSortClick(next: Sort) {
		if (next === sort || !community) return;
		sort = next;
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

<div class="mx-auto w-full max-w-lg px-4 py-6 {community?.accentColor ?? ''}">
	{#if loading}
		<div class="flex items-center justify-center py-12">
			<Loader2 class="text-base-400 animate-spin" size={28} />
		</div>
	{:else if loadError}
		<p class="text-sm text-red-500">{loadError}</p>
	{:else if community}
		{@const communityShort = community.handle.split('.')[0]}
		<header class="mb-6 flex items-start gap-4">
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

		<div class="border-base-200 dark:border-base-800 mb-4 rounded-xl border bg-base-50 dark:bg-base-900/50 p-3 text-xs text-base-500 dark:text-base-400">
			Submit to this community by DM'ing <span class="font-mono">@{community.handle}</span> a Bluesky post link with your title.
		</div>

		<div class="mb-2 flex items-center gap-1 text-xs">
			{#each SORT_OPTIONS as option (option)}
				<button
					type="button"
					onclick={() => onSortClick(option)}
					class="rounded-full px-3 py-1 font-medium transition-colors {sort === option
						? 'bg-accent-500 text-white'
						: 'text-base-600 dark:text-base-400 hover:bg-base-200 dark:hover:bg-base-800'}"
				>
					{SORT_LABELS[option]}
				</button>
			{/each}
		</div>

		{#if postsLoading}
			<div class="flex items-center justify-center py-12">
				<Loader2 class="text-base-400 animate-spin" size={24} />
			</div>
		{:else if posts.length === 0}
			<p class="text-base-500 dark:text-base-400 py-8 text-center text-sm">
				{sort === 'new' ? 'No submissions yet.' : 'Nothing in this window.'}
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
		{/if}
	{/if}
</div>
