import { likePost, unlikePost, createBookmark, deleteBookmark } from '$lib/atproto/server/feed.remote';

/**
 * Toggle like on a post. Mutates the post object directly for optimistic UI.
 * If `post` is part of a Svelte `$state` tree, mutations are reactive.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function toggleLike(post: any) {
	if (!post) return;
	if (!post.viewer) post.viewer = {};

	const currentLikeUri = post.viewer.like;
	const currentlyLiked = !!currentLikeUri;
	const currentCount = post.likeCount ?? 0;

	if (currentlyLiked) {
		post.viewer.like = undefined;
		post.likeCount = currentCount - 1;
		try {
			await unlikePost({ likeUri: currentLikeUri });
		} catch {
			post.viewer.like = currentLikeUri;
			post.likeCount = currentCount;
		}
	} else {
		post.viewer.like = 'pending';
		post.likeCount = currentCount + 1;
		try {
			const result = await likePost({ uri: post.uri, cid: post.cid });
			post.viewer.like = result.uri;
		} catch {
			post.viewer.like = undefined;
			post.likeCount = currentCount;
		}
	}
}

/**
 * Toggle bookmark on a post. Mutates the post object directly.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function toggleBookmark(post: any) {
	if (!post) return;
	if (!post.viewer) post.viewer = {};

	const currentlyBookmarked = !!post.viewer.bookmarked;
	post.viewer.bookmarked = !currentlyBookmarked;
	try {
		if (currentlyBookmarked) {
			await deleteBookmark({ uri: post.uri });
		} else {
			await createBookmark({ uri: post.uri, cid: post.cid });
		}
	} catch {
		post.viewer.bookmarked = currentlyBookmarked;
	}
}
