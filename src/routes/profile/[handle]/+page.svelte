<script lang="ts">
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import { UserProfile } from '$lib/components';
	import { Bluesky } from '$lib/components/social-icons';
	import { Button } from '@foxui/core';
	import { Loader2, LogOut } from '@lucide/svelte';
	import { user, logout } from '$lib/atproto/auth.svelte';
	import { getAuthorFeed, followUser, unfollowUser, getProfile } from '$lib/atproto/server/feed.remote';
	import ScrollablePostList from '$lib/components/ScrollablePostList.svelte';
	import { type FeedItem } from '$lib/components/PostList.svelte';

	import { UserPlus, UserCheck } from '@lucide/svelte';

	let loading = $state(true);
	let error = $state<string | null>(null);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let profile = $state<any>(null);

	let isOwnProfile = $derived(user.did && profile?.did === user.did);
	let followUri = $state<string | null>(null);
	let isFollowing = $derived(followUri !== null);
	let followsMe = $state(false);
	let isMutual = $derived(isFollowing && followsMe);
	let followLoading = $state(false);

	// Posts state
	let feedItems = $state<FeedItem[]>([]);
	let postsCursor = $state<string | null>(null);
	let postsLoading = $state(true);
	let loadingMore = $state(false);

	async function toggleFollow() {
		if (!profile?.did || followLoading) return;
		followLoading = true;
		try {
			if (isFollowing) {
				await unfollowUser({ followUri: followUri! });
				followUri = null;
			} else {
				const result = await followUser({ did: profile.did });
				followUri = result.uri;
			}
		} catch (e) {
			console.error('Failed to toggle follow:', e);
		} finally {
			followLoading = false;
		}
	}

	function numberToHuman(n: number): string {
		if (n < 1000) return String(n);
		if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
		return `${(n / 1_000_000).toFixed(1)}m`;
	}

	async function loadProfile(actor: string) {
		error = null;
		followUri = null;
		followsMe = false;
		profile = null;
		loading = true;
		feedItems = [];
		postsCursor = null;
		postsLoading = true;

		try {
			const fresh = await getProfile({ actor });
			if (fresh) {
				profile = fresh;
				followUri = fresh.viewer?.following ?? null;
				followsMe = !!fresh.viewer?.followedBy;
			} else {
				error = 'Profile not found';
			}
		} catch (e) {
			console.error('Failed to load profile:', e);
			error = 'Failed to load profile';
		} finally {
			loading = false;
		}

		const feedPromise = (async () => {
			try {
				const result = await getAuthorFeed({ actor });
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				feedItems = result.posts as any[];
				postsCursor = result.cursor;
			} catch (e) {
				console.error('Failed to load author feed:', e);
			} finally {
				postsLoading = false;
			}
		})();

		await feedPromise;
	}

	$effect(() => {
		const actor = page.params.handle;
		if (actor) untrack(() => loadProfile(actor));
	});

	async function loadMore() {
		if (loadingMore || !postsCursor) return;
		loadingMore = true;
		try {
			const result = await getAuthorFeed({
				actor: page.params.handle ?? '',
				cursor: postsCursor
			});
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			feedItems = [...feedItems, ...(result.posts as any[])];
			postsCursor = result.cursor;
		} catch (e) {
			console.error('Failed to load more:', e);
		} finally {
			loadingMore = false;
		}
	}

</script>

<div>
	<div class="mx-auto w-full max-w-lg flex-1">
		{#if loading}
			<div class="flex items-center justify-center py-12">
				<Loader2 class="text-base-400 animate-spin" size={28} />
			</div>
		{:else if error}
			<div class="flex items-center justify-center px-4 py-12">
				<p class="text-sm text-red-500">{error}</p>
			</div>
		{:else if profile}
			<UserProfile
				profile={{
					banner: profile.banner,
					avatar: profile.avatar,
					displayName: profile.displayName,
					handle: profile.handle,
					description: profile.description
				}}
				class=""
			>
				<div class="flex items-center justify-between">
					<div class="flex items-center gap-4 text-sm">
						<button onclick={() => {}} class="hover:underline">
							<span class="text-base-900 dark:text-base-100 font-semibold">{numberToHuman(profile.followsCount ?? 0)}</span>
							<span class="text-base-500 dark:text-base-400"> following</span>
						</button>
						<button onclick={() => {}} class="hover:underline">
							<span class="text-base-900 dark:text-base-100 font-semibold">{numberToHuman(profile.followersCount ?? 0)}</span>
							<span class="text-base-500 dark:text-base-400"> followers</span>
						</button>
						{#if !isOwnProfile && user.did}
							{#if isMutual}
								<span class="bg-accent-100 text-accent-700 dark:bg-accent-900/30 dark:text-accent-400 rounded-full px-2 py-0.5 text-xs font-medium">Mutuals</span>
							{:else if followsMe}
								<span class="bg-base-200 text-base-600 dark:bg-base-800 dark:text-base-400 rounded-full px-2 py-0.5 text-xs font-medium">Follows you</span>
							{/if}
						{/if}
					</div>
					<div class="flex items-center gap-2">
						<Bluesky href={`https://bsky.app/profile/${profile.handle}`} svgClasses="size-5" />
						{#if isOwnProfile}
							<Button variant="ghost" onclick={logout} class="gap-2" size="sm">
								<LogOut size={14} />
								Log out
							</Button>
						{:else if user.did}
							<Button
								variant="primary"
								size="sm"
								onclick={toggleFollow}
								disabled={followLoading}
								class="gap-1.5"
							>
								{#if isFollowing}
									<UserCheck size={14} />
									Following
								{:else}
									<UserPlus size={14} />
									Follow
								{/if}
							</Button>
						{/if}
					</div>
				</div>
			</UserProfile>

			<ScrollablePostList
				items={feedItems}
				loading={postsLoading}
				{loadingMore}
				hasMore={!!postsCursor}
				onLoadMore={loadMore}
				emptyText="No posts yet"
			/>
		{/if}
	</div>
</div>
