<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { user } from '$lib/atproto/auth.svelte';
	import { actorToDid } from '$lib/atproto/methods';
	import { blueskyPostToPostData } from '$lib/components';
	import { Post, NestedComments } from '$lib/components';
	import type { PostData } from '$lib/components';
	import { ArrowLeft, Loader2 } from '@lucide/svelte';
	import { getPostThread } from '$lib/atproto/server/feed.remote';
	import { getCachedPost, getCachedThread, getThreadAge, postMap } from '$lib/cache.svelte';
	import { threadStore } from '$lib/db.svelte';
	import { wireEmbedClicks } from '$lib/components/embed';
	import { isLiked, isBookmarked, getLikeCount, toggleLike, toggleBookmark } from '$lib/actions.svelte';

	let loading = $state(true);
	let loadingComments = $state(true);
	let error = $state<string | null>(null);
	let postUri = $state<string | null>(null);
	let comments = $state<PostData[]>([]);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	function threadToComments(replies: any[]): PostData[] {
		return replies
			.filter((r) => r.$type === 'app.bsky.feed.defs#threadViewPost' && r.post)
			.map((r) => {
				postMap.upsert(r.post.uri, r.post);
				const { postData } = blueskyPostToPostData(r.post);
				if (r.replies?.length) {
					postData.replies = threadToComments(r.replies);
				}
				return postData;
			});
	}

	function commentActions(comment: PostData) {
		const uri = comment.id ? `at://${comment.id}` : '';
		// Try to find the post in postMap by scanning for matching id
		// The id from blueskyPostToPostData is the rkey, so we need to find the full uri
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		let raw: any = null;
		// postData.id is the rkey, but we stored posts by full URI
		// We need to look up by iterating or by constructing the URI
		// Since comments are upserted into postMap, we can look up by matching
		for (const feedItem of comments) {
			// This is inefficient but works for now
		}
		// Actually, let's store the uri on the postData
		// For now, use the href which has the handle and rkey
		if (!user.did) {
			return {
				reply: { count: comment.replyCount },
				repost: { count: comment.repostCount },
				like: { count: comment.likeCount }
			};
		}

		// Find the post in postMap - the postData has href like /profile/handle/post/rkey
		// We need the AT URI. Let's check all posts for matching id (rkey)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const postView: any = comment.id ? findPostByRkey(comment.id) : null;
		if (!postView) {
			return {
				reply: { count: comment.replyCount },
				repost: { count: comment.repostCount },
				like: { count: comment.likeCount }
			};
		}
		return {
			reply: { count: comment.replyCount },
			repost: { count: comment.repostCount },
			like: {
				count: getLikeCount(postView.uri),
				active: isLiked(postView.uri),
				onclick: () => toggleLike(postView.uri, postView.cid)
			}
		};
	}

	// Helper: find a post in postMap by its rkey (last segment of URI)
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	function findPostByRkey(rkey: string): any {
		// We stored comment URIs during threadToComments via postMap.upsert
		// The rkey is the last part of the URI
		// This is a simple linear scan - could be optimized with a separate map
		// But for comment trees this is fine
		return _commentPostMap[rkey];
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let _commentPostMap: Record<string, any> = {};

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	function threadToCommentsWithMap(replies: any[]): PostData[] {
		return replies
			.filter((r) => r.$type === 'app.bsky.feed.defs#threadViewPost' && r.post)
			.map((r) => {
				postMap.upsert(r.post.uri, r.post);
				const rkey = r.post.uri.split('/').pop();
				_commentPostMap[rkey] = r.post;
				const { postData } = blueskyPostToPostData(r.post);
				if (r.replies?.length) {
					postData.replies = threadToCommentsWithMap(r.replies);
				}
				return postData;
			});
	}

	onMount(async () => {
		try {
			const did = await actorToDid(page.params.handle ?? '');
			const uri = `at://${did}/app.bsky.feed.post/${page.params.rkey ?? ''}`;
			postUri = uri;

			// Show cached data instantly
			let needsFetch = true;
			const cachedThread = await getCachedThread(uri);
			if (cachedThread) {
				postMap.upsert(uri, cachedThread.post);
				loading = false;
				if (cachedThread.replies?.length) {
					_commentPostMap = {};
					comments = threadToCommentsWithMap(cachedThread.replies);
				}
				loadingComments = false;
				const age = await getThreadAge(uri);
				if (age !== undefined && age < 30_000) needsFetch = false;
			} else {
				const cached = await getCachedPost(uri);
				if (cached) {
					postMap.upsert(uri, cached);
					loading = false;
				}
			}

			if (!needsFetch) return;

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const data = await getPostThread({ uri }) as any;

			if (!data.thread || data.thread.$type !== 'app.bsky.feed.defs#threadViewPost') {
				if (!postMap.has(uri)) error = 'Post not found';
				return;
			}

			postMap.upsert(uri, data.thread.post);
			threadStore.set(uri, data.thread).catch(() => {});

			if (data.thread.replies?.length) {
				_commentPostMap = {};
				comments = threadToCommentsWithMap(data.thread.replies);
			}
		} catch (e) {
			console.error('Failed to load post:', e);
			if (!postUri || !postMap.has(postUri)) error = 'Failed to load post';
		} finally {
			loading = false;
			loadingComments = false;
		}
	});

	function handleClickHandle(handle: string) {
		goto(`/profile/${handle}`);
	}
</script>

<div>
	<div class="mx-auto w-full max-w-xl py-4">
		<button
			onclick={() => history.back()}
			class="text-base-500 hover:text-base-700 dark:text-base-400 dark:hover:text-base-200 mb-2 ml-4 rounded-lg p-1.5 transition-colors sm:ml-0"
		>
			<ArrowLeft size={20} />
		</button>
		{#if loading}
			<div class="flex items-center justify-center py-12">
				<Loader2 class="text-base-400 animate-spin" size={28} />
			</div>
		{:else if error}
			<div class="flex items-center justify-center px-4 py-12">
				<p class="text-sm text-red-500">{error}</p>
			</div>
		{:else if postUri}
			{@const post = postMap.get(postUri)}
			{#if post}
				{@const { postData, embeds } = blueskyPostToPostData(post)}
				<div class="px-4 sm:px-0">
					<Post
						data={postData}
						embeds={wireEmbedClicks(embeds, (handle, rkey) => goto(`/profile/${handle}/post/${rkey}`), (handle) => goto(`/profile/${handle}`))}
						onclickhandle={handleClickHandle}
						handleHref={(handle) => `/profile/${handle}`}
						actions={user.did
							? {
									reply: { count: postData.replyCount },
									repost: { count: postData.repostCount },
									like: {
										count: getLikeCount(post.uri),
										active: isLiked(post.uri),
										onclick: () => toggleLike(post.uri, post.cid)
									},
									bookmark: {
										active: isBookmarked(post.uri),
										onclick: () => toggleBookmark(post.uri, post.cid)
									}
								}
							: {
									reply: { count: postData.replyCount },
									repost: { count: postData.repostCount },
									like: { count: postData.likeCount }
								}}
					/>
				</div>

				<div id="replies">
					{#if loadingComments}
						<div class="flex justify-center py-6">
							<Loader2 class="text-base-400 animate-spin" size={24} />
						</div>
					{:else if comments.length > 0}
						<div class="px-4 sm:px-0">
							<NestedComments {comments} onclickhandle={handleClickHandle} actions={commentActions} />
						</div>
					{/if}
				</div>
			{/if}
		{/if}
	</div>
</div>
