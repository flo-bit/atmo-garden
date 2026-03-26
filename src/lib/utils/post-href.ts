/**
 * Returns the href for a post. If the post is a reply, links to the root post
 * with a highlight param for the clicked reply.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getPostHref(post: any): string {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const record = post.record as any;
	const isReply = !!record?.reply?.root;
	if (isReply) {
		const rootUri = record.reply.root.uri as string;
		const [, , rootDid, , rootRkey] = rootUri.split('/');
		const clickedRkey = post.uri.split('/').pop();
		return `/profile/${rootDid}/post/${rootRkey}?highlight=${post.author.handle}/${clickedRkey}`;
	}
	const rkey = post.uri.split('/').pop();
	return `/profile/${post.author.handle}/post/${rkey}`;
}

/**
 * Returns the href for a post given a URI and handle (when we don't have the full post record).
 */
export function getPostHrefFromUri(uri: string, handle: string): string {
	const rkey = uri.split('/').pop();
	return `/profile/${handle}/post/${rkey}`;
}
