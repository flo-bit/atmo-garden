<script lang="ts">
	import { tick, onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { user } from '$lib/atproto/auth.svelte';
	import { blueskyPostToPostData } from '$lib/components';
	import { Post } from '$lib/components';
	import { Loader2 } from '@lucide/svelte';
	import { loadFeed, likePost, unlikePost } from '$lib/atproto/server/feed.remote';
	import { cachePost, prefetchThread, feedCache, prefetchNotifications, setFeedUri } from '$lib/cache.svelte';

	const LOGGED_IN_FEED = 'at://did:plc:3guzzweuqraryl3rdkimjamk/app.bsky.feed.generator/for-you';
	const PUBLIC_FEED = 'at://did:plc:w4xbfzo7kqfes5zb7r6qv3rw/app.bsky.feed.generator/blacksky-trend';

	let feedUri = $derived(user.did ? LOGGED_IN_FEED : PUBLIC_FEED);

	$effect(() => { setFeedUri(feedUri); });

	let loading = $derived(!feedCache.loaded);
	let loadingMore = $state(false);

	function cachePosts(posts: any[]) { // eslint-disable-line @typescript-eslint/no-explicit-any
		for (const fp of posts) {
			if (fp.post) {
				cachePost(fp.post);
				prefetchThread(fp.post.uri);
			}
		}
	}

	async function loadInitial() {
		try {
			const result = await loadFeed({ feedUri });
			feedCache.posts = JSON.parse(JSON.stringify(result.posts));
			cachePosts(feedCache.posts);
			feedCache.cursor = result.cursor;
			feedCache.loaded = true;
		} catch (e) {
			console.error('Failed to load feed:', e);
			feedCache.loaded = true;
		}
	}

	onMount(async () => {
		if (feedCache.loaded && feedCache.posts.length > 0) {
			await tick();
			window.scrollTo(0, feedCache.scrollY);
		} else {
			loadInitial();
		}

		// Prefetch notifications after a short delay
		if (user.did) {
			setTimeout(() => prefetchNotifications(), 1000);
		}
	});

	onDestroy(() => {
		if (typeof window !== 'undefined') {
			feedCache.scrollY = window.scrollY;
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
			const newPosts = JSON.parse(JSON.stringify(result.posts));
			cachePosts(newPosts);
			feedCache.posts = [...feedCache.posts, ...newPosts];
			feedCache.cursor = result.cursor;
		} catch (e) {
			console.error('Failed to load more:', e);
		} finally {
			loadingMore = false;
		}
	}

	// Track like state: postUri -> likeRecordUri (or null if not liked)
	let likeState = $state<Record<string, string | null>>({});
	// Track like count adjustments: postUri -> delta (+1 or -1)
	let likeCountDelta = $state<Record<string, number>>({});

	function isLiked(postUri: string, viewerLike?: string): boolean {
		if (postUri in likeState) return likeState[postUri] !== null;
		return !!viewerLike;
	}

	function getLikeCount(postUri: string, originalCount: number): number {
		return originalCount + (likeCountDelta[postUri] ?? 0);
	}

	async function handleLike(postUri: string, postCid: string, viewerLike?: string) {
		const currentlyLiked = isLiked(postUri, viewerLike);
		if (currentlyLiked) {
			const likeUri = likeState[postUri] ?? viewerLike;
			if (!likeUri) return;
			likeState[postUri] = null;
			likeCountDelta[postUri] = (likeCountDelta[postUri] ?? 0) - 1;
			try {
				await unlikePost({ likeUri });
			} catch {
				likeState[postUri] = likeUri;
				likeCountDelta[postUri] = (likeCountDelta[postUri] ?? 0) + 1;
			}
		} else {
			likeState[postUri] = 'pending';
			likeCountDelta[postUri] = (likeCountDelta[postUri] ?? 0) + 1;
			try {
				const result = await likePost({ uri: postUri, cid: postCid });
				likeState[postUri] = result.uri;
			} catch {
				likeState[postUri] = null;
				likeCountDelta[postUri] = (likeCountDelta[postUri] ?? 0) - 1;
			}
		}
	}

	function handleScroll() {
		if (loadingMore || !feedCache.cursor) return;
		const { scrollTop, scrollHeight, clientHeight } = document.documentElement;
		if (scrollHeight - scrollTop - clientHeight < 2000) {
			loadMore();
		}
	}

	onMount(() => window.addEventListener('scroll', handleScroll));
	onDestroy(() => {
		if (typeof window !== 'undefined') window.removeEventListener('scroll', handleScroll);
	});
</script>

<div class="flex h-dvh flex-col">
	<div class="mx-auto w-full max-w-lg">
		<!-- Post list -->
		<div>
			{#if loading}
				<div class="flex items-center justify-center py-12">
					<Loader2 class="text-base-400 animate-spin" size={28} />
				</div>
			{:else if feedCache.posts.length === 0}
					<div class="flex h-full items-center justify-center">
						<p class="text-base-500 dark:text-base-400">No posts</p>
					</div>
				{:else}
					<div class="divide-base-200 dark:divide-base-800 divide-y">
						{#each feedCache.posts as feedPost, i (feedPost.post?.uri ? `${feedPost.post.uri}-${i}` : i)}
							{#if feedPost.post}
								{@const { postData, embeds } = blueskyPostToPostData(feedPost.post, 'https://bsky.app', feedPost.reason, feedPost.reply)}
								<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
							<div
								class="px-4 py-4 cursor-pointer sm:px-0"
								onmousedown={(e) => {
									if (e.button !== 0) return;
									if ((e.target as HTMLElement).closest('a, button')) return;
									// eslint-disable-next-line @typescript-eslint/no-explicit-any
									const record = feedPost.post.record as any;
									const isReply = !!record?.reply?.root;
									if (isReply) {
										const rootUri = record.reply.root.uri as string;
										const [, , rootDid, , rootRkey] = rootUri.split('/');
										const clickedRkey = feedPost.post.uri.split('/').pop();
										goto(`/p/${rootDid}/post/${rootRkey}?highlight=${feedPost.post.author.handle}/${clickedRkey}`);
									} else {
										const rkey = feedPost.post.uri.split('/').pop();
										goto(`/p/${feedPost.post.author.handle}/post/${rkey}`);
									}
								}}
							>
									<Post
									compact={true}
										data={postData}
										{embeds}
										onclickhandle={(handle) => goto(`/p/${handle}`)}
										actions={user.did
											? {
													reply: {
														count: postData.replyCount
													},
													repost: {
														count: postData.repostCount
													},
													like: {
														count: getLikeCount(feedPost.post.uri, postData.likeCount ?? 0),
														active: isLiked(feedPost.post.uri, feedPost.post.viewer?.like),
														onclick: () => handleLike(feedPost.post.uri, feedPost.post.cid, feedPost.post.viewer?.like)
													}
												}
											: {
													reply: {
														count: postData.replyCount
													},
													repost: {
														count: postData.repostCount
													},
													like: {
														count: postData.likeCount
													}
												}}
									/>
								</div>
							{/if}
						{/each}
					</div>

					{#if loadingMore}
						<div class="flex justify-center py-6">
							<Loader2 class="text-base-400 animate-spin" size={24} />
						</div>
					{/if}

					{#if !feedCache.cursor && feedCache.posts.length > 0}
						<p class="text-base-400 py-6 text-center text-sm">You've reached the end</p>
					{/if}

					<div class="pb-[max(0.75rem,env(safe-area-inset-bottom))]"></div>
				{/if}
		</div>
	</div>
</div>
