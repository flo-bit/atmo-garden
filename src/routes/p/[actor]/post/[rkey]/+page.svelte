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
	import { likePost, unlikePost, getPostThread } from '$lib/atproto/server/feed.remote';
	import { getCachedPost, getCachedThread, getThreadAge } from '$lib/cache.svelte';
	import { threadStore } from '$lib/db.svelte';
	import { wireEmbedClicks } from '$lib/components/embed';

	let loading = $state(true);
	let loadingComments = $state(true);
	let error = $state<string | null>(null);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let postView = $state<any>(null);
	let comments = $state<PostData[]>([]);
	// Map postData.id -> raw post view for like actions
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let postViewMap = $state<Record<string, any>>({});

	let likeState = $state<Record<string, string | null>>({});
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

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	function threadToComments(replies: any[]): PostData[] {
		return replies
			.filter((r) => r.$type === 'app.bsky.feed.defs#threadViewPost' && r.post)
			.map((r) => {
				const { postData } = blueskyPostToPostData(r.post);
				const id = postData.id ?? r.post.uri;
				postViewMap[id] = r.post;
				if (r.replies?.length) {
					postData.replies = threadToComments(r.replies);
				}
				return postData;
			});
	}

	function commentActions(comment: PostData) {
		const raw = postViewMap[comment.id ?? ''];
		if (!raw || !user.did) {
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
				count: getLikeCount(raw.uri, comment.likeCount ?? 0),
				active: isLiked(raw.uri, raw.viewer?.like),
				onclick: () => handleLike(raw.uri, raw.cid, raw.viewer?.like)
			}
		};
	}

	onMount(async () => {

		try {
			const did = await actorToDid(page.params.actor);
			const uri = `at://${did}/app.bsky.feed.post/${page.params.rkey}`;

			// Show cached data instantly
			let needsFetch = true;
			const cachedThread = await getCachedThread(uri);
			if (cachedThread) {
				postView = cachedThread.post;
				loading = false;
				if (cachedThread.replies?.length) {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					comments = threadToComments(cachedThread.replies as any[]);
				}
				loadingComments = false;
				// Skip refetch if cache is fresh (< 30s)
				const age = await getThreadAge(uri);
				if (age !== undefined && age < 30_000) needsFetch = false;
			} else {
				const cached = await getCachedPost(uri);
				if (cached) {
					postView = cached;
					loading = false;
				}
			}

			if (!needsFetch) return;

			// Fetch full thread (authenticated if logged in, for viewer state)
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const data = await getPostThread({ uri }) as any;

			if (!data.thread || data.thread.$type !== 'app.bsky.feed.defs#threadViewPost') {
				if (!postView) error = 'Post not found';
				return;
			}

			postView = data.thread.post;
			threadStore.set(uri, data.thread).catch(() => {});

			if (data.thread.replies?.length) {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				comments = threadToComments(data.thread.replies as any[]);
			}
		} catch (e) {
			console.error('Failed to load post:', e);
			if (!postView) error = 'Failed to load post';
		} finally {
			loading = false;
			loadingComments = false;
		}
	});

	function handleClickHandle(handle: string) {
		goto(`/p/${handle}`);
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
		{:else if postView}
			{@const { postData, embeds } = blueskyPostToPostData(postView)}
			<div class="px-4 sm:px-0">
				<Post
					data={postData}
					embeds={wireEmbedClicks(embeds, (handle, rkey) => goto(`/p/${handle}/post/${rkey}`), (handle) => goto(`/p/${handle}`))}
					onclickhandle={handleClickHandle}
					handleHref={(handle) => `/p/${handle}`}
					actions={user.did
						? {
								reply: { count: postData.replyCount },
								repost: { count: postData.repostCount },
								like: {
									count: getLikeCount(postView.uri, postData.likeCount ?? 0),
									active: isLiked(postView.uri, postView.viewer?.like),
									onclick: () => handleLike(postView.uri, postView.cid, postView.viewer?.like)
								}
							}
						: {
								reply: { count: postData.replyCount },
								repost: { count: postData.repostCount },
								like: { count: postData.likeCount }
							}}
				/>
			</div>

			{#if loadingComments}
				<div class="flex justify-center py-6">
					<Loader2 class="text-base-400 animate-spin" size={24} />
				</div>
			{:else if comments.length > 0}
				<div class="px-4 sm:px-0">
					<NestedComments {comments} onclickhandle={handleClickHandle} actions={commentActions} />
				</div>
			{/if}
		{/if}
	</div>
</div>
