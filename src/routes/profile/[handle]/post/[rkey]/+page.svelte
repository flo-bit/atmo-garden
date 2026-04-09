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
	import { wireEmbedClicks } from '$lib/components/embed';
	import { toggleLike, toggleBookmark } from '$lib/actions.svelte';

	let loading = $state(true);
	let loadingComments = $state(true);
	let error = $state<string | null>(null);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let mainPost = $state<any>(null);
	let comments = $state<PostData[]>([]);

	// Map rkey -> raw post view (for comment like actions)
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let commentPosts: Record<string, any> = $state({});

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	function threadToComments(replies: any[]): PostData[] {
		return replies
			.filter((r) => r.$type === 'app.bsky.feed.defs#threadViewPost' && r.post)
			.map((r) => {
				const rkey = r.post.uri.split('/').pop();
				commentPosts[rkey] = r.post;
				const { postData } = blueskyPostToPostData(r.post);
				if (r.replies?.length) {
					postData.replies = threadToComments(r.replies);
				}
				return postData;
			});
	}

	function commentActions(comment: PostData) {
		if (!user.did) {
			return {
				reply: { count: comment.replyCount },
				repost: { count: comment.repostCount },
				like: { count: comment.likeCount }
			};
		}

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const postView: any = comment.id ? commentPosts[comment.id] : null;
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
				count: postView.likeCount ?? 0,
				active: !!postView.viewer?.like,
				onclick: () => toggleLike(postView)
			}
		};
	}

	onMount(async () => {
		try {
			const did = await actorToDid(page.params.handle ?? '');
			const uri = `at://${did}/app.bsky.feed.post/${page.params.rkey ?? ''}`;

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const data = await getPostThread({ uri }) as any;

			if (!data.thread || data.thread.$type !== 'app.bsky.feed.defs#threadViewPost') {
				error = 'Post not found';
				return;
			}

			mainPost = data.thread.post;

			if (data.thread.replies?.length) {
				commentPosts = {};
				comments = threadToComments(data.thread.replies);
			}
		} catch (e) {
			console.error('Failed to load post:', e);
			error = 'Failed to load post';
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
		{:else if mainPost}
			{@const { postData, embeds } = blueskyPostToPostData(mainPost)}
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
									count: mainPost.likeCount ?? 0,
									active: !!mainPost.viewer?.like,
									onclick: () => toggleLike(mainPost)
								},
								bookmark: {
									active: !!mainPost.viewer?.bookmarked,
									onclick: () => toggleBookmark(mainPost)
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
	</div>
</div>
