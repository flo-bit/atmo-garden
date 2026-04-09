<script lang="ts" module>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	export type FeedItem = { post: any; reason?: any; reply?: any };
</script>

<script lang="ts">
	/* eslint-disable svelte/no-navigation-without-resolve */
	import { goto } from '$app/navigation';
	import { user } from '$lib/atproto/auth.svelte';
	import { blueskyPostToPostData } from '$lib/components';
	import { Post } from '$lib/components';
	import { wireEmbedClicks } from '$lib/components/embed';
	import { getPostHref } from '$lib/utils/post-href';
	import { toggleLike, toggleBookmark } from '$lib/actions.svelte';

	let {
		items,
		showDividers = true
	}: {
		items: FeedItem[];
		showDividers?: boolean;
	} = $props();

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	function getPost(item: FeedItem): any {
		// Accepts either FeedViewPost ({ post, reason, reply }) or bare PostView
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return (item as any)?.post ?? item;
	}
</script>

<div>
	{#each items as item, i (getPost(item)?.uri + '-' + i)}
		{@const post = getPost(item)}
		{#if post?.uri && post?.author}
			{@const { postData, embeds } = blueskyPostToPostData(post, 'https://bsky.app', item.reason, item.reply)}
			{@const postHref = getPostHref(post)}
			<div
				class="-mx-2 rounded-xl px-6 pt-3 pb-2 transition-colors hover:bg-base-100/50 sm:px-2 dark:hover:bg-base-800/30"
			>
				<Post
					compact={true}
					data={postData}
					embeds={wireEmbedClicks(embeds, (handle, rkey) => goto(`/profile/${handle}/post/${rkey}`), (handle) => goto(`/profile/${handle}`))}
					href={postHref}
					onclickhandle={(handle) => goto(`/profile/${handle}`)}
					handleHref={(handle) => `/profile/${handle}`}
					actions={user.did
						? {
								reply: {
									count: postData.replyCount,
									href: postHref + '#replies'
								},
								repost: {
									count: postData.repostCount
								},
								like: {
									count: post.likeCount ?? 0,
									active: !!post.viewer?.like,
									onclick: () => toggleLike(post)
								},
								bookmark: {
									active: !!post.viewer?.bookmarked,
									onclick: () => toggleBookmark(post)
								}
							}
						: {
								reply: {
									count: postData.replyCount,
									href: postHref + '#replies'
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
			{#if showDividers && i < items.length - 1}
				<hr class="border-base-200 dark:border-base-800 mx-4 sm:mx-0" />
			{/if}
		{/if}
	{/each}
</div>
