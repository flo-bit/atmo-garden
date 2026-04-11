// Bluesky feed generator: serves the `app.bsky.feed.getFeedSkeleton`
// XRPC endpoint so the two `app.bsky.feed.generator` records published
// by atmo.garden (`all-hot` and `top-day`) can be subscribed to from
// any bsky client.
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
// atmo.garden serves reposts and quote posts differently:
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
//
// Feeds are matched by the rkey of the `feed` query param
// (`all-hot` / `top-day`). We intentionally don't validate the
// authority DID — if someone publishes a generator record on their
// own account that points at our service, they'll get the same
// feed data, but they can't modify it, so it's harmless.

import type { RequestHandler } from './$types';
import { json, error } from '@sveltejs/kit';
import { getCombinedFeed, type PostSort, type PostWithCommunity } from '$lib/reddit/db';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** Map a known feed rkey → the `PostSort` we drive `getCombinedFeed` with. */
const FEED_RKEY_TO_SORT: Record<string, PostSort> = {
	'all-hot': 'hot',
	'top-day': 'top-day'
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

export const GET: RequestHandler = async ({ url, platform }) => {
	const env = platform?.env;
	if (!env?.DB) error(500, 'DB binding unavailable');

	const feedUri = url.searchParams.get('feed');
	if (!feedUri) error(400, 'missing `feed` parameter');

	const rkey = parseFeedRkey(feedUri);
	const sort = rkey ? FEED_RKEY_TO_SORT[rkey] : undefined;
	if (!sort) {
		// Unknown feed. The getFeedSkeleton lexicon defines a single
		// named error for this case (`errors: [{ name: "UnknownFeed" }]`)
		// and the atproto XRPC error convention is a 400 with a JSON
		// body of `{ error: "<name>", message: "<human>" }` — clients
		// branch on the name to render a "feed unavailable" state,
		// which is better UX than silently returning an empty feed.
		return json(
			{ error: 'UnknownFeed', message: `Feed not found: ${feedUri}` },
			{ status: 400 }
		);
	}

	// Clamp limit to the [1, MAX_LIMIT] range per the lexicon spec.
	const limitRaw = url.searchParams.get('limit');
	const limitParsed = limitRaw ? parseInt(limitRaw, 10) : DEFAULT_LIMIT;
	const limit = Number.isFinite(limitParsed)
		? Math.max(1, Math.min(MAX_LIMIT, limitParsed))
		: DEFAULT_LIMIT;

	// Cursor is an opaque string per spec; we use a base-10 offset
	// because `getCombinedFeed` already accepts offset-based pagination
	// and we don't need anything fancier. Invalid cursors fall back
	// to offset 0.
	const cursorRaw = url.searchParams.get('cursor');
	const cursorParsed = cursorRaw ? parseInt(cursorRaw, 10) : 0;
	const offset =
		Number.isFinite(cursorParsed) && cursorParsed >= 0 ? cursorParsed : 0;

	const rows = await getCombinedFeed(env.DB, limit, sort, offset);
	const feed = rows.map(rowToSkeleton).filter((x): x is SkeletonFeedPost => x !== null);

	// Only emit a cursor when we filled the page — saves one empty
	// paginated round-trip for the common "we've reached the end" case.
	const nextCursor = rows.length === limit ? String(offset + rows.length) : undefined;

	return json({
		feed,
		...(nextCursor ? { cursor: nextCursor } : {})
	});
};
