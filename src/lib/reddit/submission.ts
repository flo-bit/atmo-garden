// Parse submission DMs → (title, AT URI of post to quote).

import type { Client } from '@atcute/client';
import type { Did, ResourceUri } from '@atcute/lexicons';
import { resolveHandle } from '$lib/atproto/methods';

// Matches bsky.app post URLs.
const BSKY_POST_URL = /https?:\/\/bsky\.app\/profile\/([^/\s]+)\/post\/([A-Za-z0-9]+)/i;
// Matches at:// URIs.
const AT_URI = /at:\/\/(did:[^/\s]+)\/(app\.bsky\.feed\.post)\/([A-Za-z0-9]+)/i;

export type ParsedSubmission = {
	title: string;
	postUri: ResourceUri;
};

export type DmInput = {
	text: string | undefined;
	// chat message embed (app.bsky.embed.record), when the user "shares" a
	// post into the DM via the Bluesky client — the post is attached as an
	// embed rather than pasted as a URL.
	embed?: {
		$type?: string;
		record?: { uri?: string };
	} | null;
};

/**
 * Extract a valid submission from a DM. Accepts either a message's raw text
 * (which may contain a Bluesky post URL) or an attached record embed
 * (`app.bsky.embed.record`).
 *
 * Returns null if the message doesn't reference a recognizable Bluesky post.
 * Empty title is allowed — the bot turns title-less submissions into reposts
 * instead of quote posts.
 */
export async function parseSubmission(msg: DmInput): Promise<ParsedSubmission | null> {
	const text = msg.text ?? '';

	// 1. Preferred path: the user shared a post via the chat "share to DM"
	// flow, which attaches an app.bsky.embed.record to the message.
	const embedUri = msg.embed?.record?.uri;
	if (embedUri && /^at:\/\/did:[^/]+\/app\.bsky\.feed\.post\//.test(embedUri)) {
		return { title: text.trim(), postUri: embedUri as ResourceUri };
	}

	if (!text) return null;

	// 2. at:// URI pasted in the text.
	const atMatch = text.match(AT_URI);
	if (atMatch) {
		const uri = atMatch[0] as ResourceUri;
		const title = stripRange(text, atMatch.index!, atMatch[0].length);
		return { title, postUri: uri };
	}

	// 3. bsky.app URL pasted in the text.
	const urlMatch = text.match(BSKY_POST_URL);
	if (!urlMatch) return null;

	const handleOrDid = urlMatch[1];
	const rkey = urlMatch[2];

	let did: Did;
	try {
		if (handleOrDid.startsWith('did:')) {
			did = handleOrDid as Did;
		} else {
			did = await resolveHandle({ handle: handleOrDid as `${string}.${string}` });
		}
	} catch {
		return null;
	}

	const postUri = `at://${did}/app.bsky.feed.post/${rkey}` as ResourceUri;
	const title = stripRange(text, urlMatch.index!, urlMatch[0].length);

	return { title, postUri };
}

function stripRange(text: string, start: number, length: number): string {
	const before = text.slice(0, start);
	const after = text.slice(start + length);
	return (before + ' ' + after).replace(/\s+/g, ' ').trim();
}

/**
 * Fetch the CID + current like count of a post at a given AT URI. The
 * CID is required to build a valid `app.bsky.embed.record`. The like
 * count is stored as the baseline at submission time so the Hot sort
 * can compute community lift = current_likes − baseline.
 */
export async function getPostMeta(
	client: Client,
	uri: ResourceUri
): Promise<{ cid: string; likeCount: number } | null> {
	// Pull 1 post from the public appview — faster than getRecord to the PDS.
	const res = await client.get('app.bsky.feed.getPosts', {
		params: { uris: [uri] }
	});
	if (!res.ok || res.data.posts.length === 0) return null;
	const post = res.data.posts[0];
	return { cid: post.cid, likeCount: post.likeCount ?? 0 };
}
