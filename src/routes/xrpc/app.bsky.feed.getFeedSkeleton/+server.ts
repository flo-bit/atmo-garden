// Bluesky feed generator: serves the `app.bsky.feed.getFeedSkeleton`
// XRPC endpoint. Handles two kinds of feeds:
//
//   scope = 'all'         — global feeds (all-hot, all-new, top-day,
//                           top-week). Reads from the KV-materialized
//                           sorted list, slices the requested page,
//                           maps to skeleton entries.
//
//   scope = 'following'   — per-viewer personalized feeds
//                           (following-hot, following-new). Reads the
//                           same KV list, filters down to posts
//                           whose community_did is in the viewer's
//                           followed-community set, then slices.
//                           Zero subscriptions → emit an optional
//                           placeholder post followed by the all-<sort>
//                           contents as a fallback.
//
// Both paths are zero-D1 on the hot request path — all reads come
// from Workers KV with an edge-cache tier in front (see
// src/lib/reddit/feed-cache.ts). The cron tick rebuilds the KV
// entries once per minute, so feed freshness is bounded by that.
//
// Following feeds pull the viewer DID from the `Authorization:
// Bearer <jwt>` header's `iss` claim, parsed without signature
// verification. The attack surface is "look at how a different user's
// feed would render" — which an attacker could already compute from
// bsky's public follow graph — so unverified parsing is acceptable
// for MVP. Proper signature verification would require fetching the
// caller's DID doc and running ES256K, worth doing eventually.
//
// Wire shape (per lexicons.atproto.com / app.bsky.feed.getFeedSkeleton):
//
//   GET /xrpc/app.bsky.feed.getFeedSkeleton?feed=<at-uri>&limit=<int>&cursor=<str>
//
//   → 200 { feed: SkeletonFeedPost[], cursor?: string }
//
// Where SkeletonFeedPost is:
//
//   {
//     post: <at-uri>,                  // the post to hydrate + render
//     reason?: {
//       $type: 'app.bsky.feed.defs#skeletonReasonRepost',
//       repost: <at-uri>               // the repost record that surfaced it
//     }
//   }
//
// Post routing for skeleton entries:
//
//   - Community REPOST rows (`uri` → `app.bsky.feed.repost/...`):
//     emit `{ post: quoted_post_uri, reason: skeletonReasonRepost(uri) }`.
//     The user sees the ORIGINAL post in their feed with a
//     "Reposted by c/<community>" header — same UX as normal bsky
//     reposts.
//
//   - Community QUOTE POST rows (`uri` → `app.bsky.feed.post/...`):
//     emit `{ post: uri }`. The community's quote post is itself a
//     valid bsky post with an `app.bsky.embed.record` embed, so the
//     appview hydrates it with the original post rendered inline.

import type { RequestHandler } from './$types';
import { json, error } from '@sveltejs/kit';
import type { PostSort, PostWithCommunity } from '$lib/reddit/db';
import {
	getCachedSortedList,
	getCachedViewerCommunityFollows,
	parseViewerDidFromJwt
} from '$lib/reddit/feed-cache';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

type FeedConfig = {
	sort: PostSort;
	scope: 'all' | 'following';
};

/** Map a known feed rkey → config (sort + scope). */
const FEED_RKEY_TO_CONFIG: Record<string, FeedConfig> = {
	'all-hot': { sort: 'hot', scope: 'all' },
	'all-new': { sort: 'new', scope: 'all' },
	'top-day': { sort: 'top-day', scope: 'all' },
	'top-week': { sort: 'top-week', scope: 'all' },
	'following-hot': { sort: 'hot', scope: 'following' },
	'following-new': { sort: 'new', scope: 'following' }
};

type SkeletonFeedPost = {
	post: string;
	reason?: {
		$type: 'app.bsky.feed.defs#skeletonReasonRepost';
		repost: string;
	};
};

/** Extract the rkey (last path segment) from an at:// feed URI. */
function parseFeedRkey(feedUri: string): string | null {
	const m = feedUri.match(
		/^at:\/\/did:[^/]+\/app\.bsky\.feed\.generator\/([A-Za-z0-9._:~-]+)$/
	);
	return m ? m[1] : null;
}

/** Parse `at://did/<collection>/<rkey>` → collection, used to branch
 *  repost vs quote-post handling. */
function parseCommunityRecord(uri: string): { collection: string } | null {
	const m = uri.match(/^at:\/\/did:[^/]+\/([^/]+)\/[A-Za-z0-9._:~-]+$/);
	return m ? { collection: m[1] } : null;
}

function rowToSkeleton(row: PostWithCommunity): SkeletonFeedPost | null {
	const parsed = parseCommunityRecord(row.uri);
	if (!parsed) return null;

	if (parsed.collection === 'app.bsky.feed.repost') {
		// Straight repost: surface the ORIGINAL post with a
		// skeletonReasonRepost pointing back at the community's
		// repost record. Bsky will render it as "Reposted by <community>".
		return {
			post: row.quoted_post_uri,
			reason: {
				$type: 'app.bsky.feed.defs#skeletonReasonRepost',
				repost: row.uri
			}
		};
	}

	if (parsed.collection === 'app.bsky.feed.post') {
		// Quote post: the community's post IS a valid app.bsky.feed.post
		// with an embed, so surface it directly. The appview will
		// hydrate the embed and render the quoted original inline.
		return { post: row.uri };
	}

	// Unknown collection — skip rather than emit garbage.
	return null;
}

/**
 * Build a response envelope with cursor handling. The cursor is an
 * opaque string per the lexicon spec; we use base-10 offset because
 * everything downstream is offset-paginated. Only emit a cursor
 * when the page was filled — saves one empty paginated round-trip
 * at the end of the feed.
 */
function buildResponse(
	entries: SkeletonFeedPost[],
	offset: number,
	limit: number,
	totalAvailable: number
): { feed: SkeletonFeedPost[]; cursor?: string } {
	const page = entries.slice(0, limit);
	const nextOffset = offset + page.length;
	const nextCursor = nextOffset < totalAvailable && page.length === limit ? String(nextOffset) : undefined;
	return {
		feed: page,
		...(nextCursor ? { cursor: nextCursor } : {})
	};
}

export const GET: RequestHandler = async ({ url, request, platform }) => {
	const env = platform?.env;
	if (!env) error(500, 'Platform env unavailable');

	const feedUri = url.searchParams.get('feed');
	if (!feedUri) error(400, 'missing `feed` parameter');

	const rkey = parseFeedRkey(feedUri);
	const config = rkey ? FEED_RKEY_TO_CONFIG[rkey] : undefined;
	if (!config) {
		// Unknown feed. The getFeedSkeleton lexicon defines a single
		// named error for this case (`errors: [{ name: "UnknownFeed" }]`)
		// and the atproto XRPC error convention is a 400 with a JSON
		// body of `{ error: "<name>", message: "<human>" }` — clients
		// branch on the name to render a "feed unavailable" state.
		return json(
			{ error: 'UnknownFeed', message: `Feed not found: ${feedUri}` },
			{ status: 400 }
		);
	}

	// Clamp limit to [1, MAX_LIMIT] per the lexicon spec.
	const limitRaw = url.searchParams.get('limit');
	const limitParsed = limitRaw ? parseInt(limitRaw, 10) : DEFAULT_LIMIT;
	const limit = Number.isFinite(limitParsed)
		? Math.max(1, Math.min(MAX_LIMIT, limitParsed))
		: DEFAULT_LIMIT;

	// Cursor → offset. Invalid cursors fall back to 0.
	const cursorRaw = url.searchParams.get('cursor');
	const cursorParsed = cursorRaw ? parseInt(cursorRaw, 10) : 0;
	const offset =
		Number.isFinite(cursorParsed) && cursorParsed >= 0 ? cursorParsed : 0;

	// Pull the materialized global sorted list once — both scopes
	// read from the same cached entry.
	const sortedList = await getCachedSortedList(env, config.sort);

	if (config.scope === 'all') {
		const slice = sortedList
			.slice(offset, offset + limit)
			.map(rowToSkeleton)
			.filter((x): x is SkeletonFeedPost => x !== null);
		return json(buildResponse(slice, offset, limit, sortedList.length));
	}

	// ----- scope === 'following' -----

	// Extract viewer DID from the service-auth JWT. Missing / malformed
	// JWT → treat as zero-subscription fallback, which surfaces the
	// placeholder + all-<sort> contents so an unauthenticated client
	// peek at the feed still renders something useful.
	const viewerDid = parseViewerDidFromJwt(request.headers.get('authorization'));

	let filtered: PostWithCommunity[] = [];
	if (viewerDid) {
		const followed = await getCachedViewerCommunityFollows(env, viewerDid);
		if (followed.length > 0) {
			const followedSet = new Set(followed);
			filtered = sortedList.filter((r) => followedSet.has(r.community_did));
		}
	}

	if (filtered.length === 0) {
		// Empty-state: show the placeholder post (if configured) then
		// fall back to the all-<sort> list so the feed always has
		// content. Placeholder absent (env var empty) → just fall back
		// to the all-<sort> contents.
		const placeholderUri = env.FOLLOWING_FEED_PLACEHOLDER_URI ?? '';
		const fallback = sortedList
			.slice(offset, offset + limit)
			.map(rowToSkeleton)
			.filter((x): x is SkeletonFeedPost => x !== null);

		// Only prepend the placeholder on the first page (offset 0) —
		// otherwise subsequent pages would have it re-inserted.
		const entries: SkeletonFeedPost[] =
			offset === 0 && placeholderUri
				? [{ post: placeholderUri }, ...fallback].slice(0, limit)
				: fallback;

		return json(buildResponse(entries, offset, limit, sortedList.length));
	}

	// Normal path: viewer has real subscriptions.
	const slice = filtered
		.slice(offset, offset + limit)
		.map(rowToSkeleton)
		.filter((x): x is SkeletonFeedPost => x !== null);
	return json(buildResponse(slice, offset, limit, filtered.length));
};
