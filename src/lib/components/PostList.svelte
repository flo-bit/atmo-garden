<script lang="ts">
	/* eslint-disable svelte/no-navigation-without-resolve */
	import { goto } from '$app/navigation';
	import { user } from '$lib/atproto/auth.svelte';
	import { blueskyPostToPostData } from '$lib/components';
	import { Post } from '$lib/components';
	import { wireEmbedClicks } from '$lib/components/embed';
	import { postMap } from '$lib/cache.svelte';
	import { getPostHref } from '$lib/utils/post-href';
	import { isLiked, isBookmarked, getLikeCount, toggleLike, toggleBookmark } from '$lib/actions.svelte';
	import type { FeedItem } from '$lib/cache.svelte';

	type PostListItem = FeedItem | string;

	let {
		items,
		showDividers = true
	}: {
		items: PostListItem[];
		showDividers?: boolean;
	} = $props();

	function getUri(item: PostListItem): string {
		return typeof item === 'string' ? item : item.uri;
	}

	function getReason(item: PostListItem) {
		return typeof item === 'string' ? undefined : item.reason;
	}

	function getReply(item: PostListItem) {
		return typeof item === 'string' ? undefined : item.reply;
	}
</script>

<div>
	{#each items as item, i (getUri(item) + '-' + i)}
		{@const uri = getUri(item)}
		{@const post = postMap.get(uri)}
		{#if post?.uri && post?.author}
			{@const { postData, embeds } = blueskyPostToPostData(post, 'https://bsky.app', getReason(item), getReply(item))}
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
