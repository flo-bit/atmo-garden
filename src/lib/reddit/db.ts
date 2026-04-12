// Lightweight typed accessors for the reddit-on-bsky D1 schema.

import type { Did } from '@atcute/lexicons';

export type CommunityRow = {
	did: Did;
	handle: string;
	pds: string;
	secret_key_ciphertext: string;
	secret_key_iv: string;
	public_jwk_json: string;
	thumbprint: string;
	display_name: string | null;
	avatar: string | null;
	description: string | null;
	/**
	 * Read-through cache of the community's accent color. Canonical value
	 * lives on `garden.atmo.community/self`; cron refreshes this column.
	 */
	accent_color: string | null;
	/** Cached followersCount from `app.bsky.actor.getProfile`. */
	followers_count: number | null;
	/**
	 * Cursor for the mention-based submission flow (ISO-8601 datetime).
	 * NULL → never initialized; the next cron tick primes
	 * `app.bsky.notification.updateSeen(now)` and stamps this column so
	 * pre-existing mentions aren't retroactively reposted.
	 */
	last_mention_seen_at: string | null;
	created_at: string;
};

export type PostRow = {
	uri: string;
	cid: string;
	community_did: Did;
	title: string;
	quoted_post_uri: string;
	quoted_post_cid: string | null;
	author_did: string | null;
	like_count: number;
	reply_count: number;
	repost_count: number;
	/**
	 * Snapshot of `like_count` captured at submission time. Used by the
	 * Hot sort to compute community lift = `like_count - baseline`, so
	 * a viral pre-submission post doesn't rocket to the top of Hot the
	 * moment it's forwarded to the community. Nullable only for rows
	 * created during the narrow window between migration + code deploy.
	 */
	like_count_at_submission: number | null;
	indexed_at: string;
	last_refreshed_at: string;
	/**
	 * ISO-8601 timestamp of the first tick that saw the underlying bsky
	 * post as missing from `app.bsky.feed.getPosts`. NULL while the post
	 * is healthy; cleared if the post reappears. After a grace period
	 * (see `sweepDeletedPosts` in bot.ts) the wrapper record + this row
	 * get cleaned up.
	 */
	missing_since: string | null;
	/**
	 * ISO-8601 timestamp set by `markPostRemoved` when a community
	 * creator actively removes a post via the community page's
	 * popover menu. All feed queries filter on `removed_at IS NULL`,
	 * so a removed row disappears from every surface immediately.
	 * `hasSubmission` deliberately does NOT filter removed rows —
	 * keeping them dedup-visible blocks re-submission attempts.
	 */
	removed_at: string | null;
};

export type PostWithCommunity = PostRow & {
	community_handle: string;
	community_display_name: string | null;
	community_avatar: string | null;
	community_accent_color: string | null;
};

export type CommunityListRow = CommunityRow & { post_count: number };

export async function listCommunities(db: D1Database): Promise<CommunityListRow[]> {
	// LEFT JOIN with a grouped subquery so communities with zero posts
	// still appear (COALESCE to 0) without needing a second roundtrip.
	const res = await db
		.prepare(
			`SELECT c.did, c.handle, c.pds, c.secret_key_ciphertext, c.secret_key_iv, c.public_jwk_json, c.thumbprint, c.display_name, c.avatar, c.description, c.accent_color, c.followers_count, c.last_mention_seen_at, c.created_at,
			        COALESCE(pc.n, 0) AS post_count
			 FROM communities c
			 LEFT JOIN (SELECT community_did, COUNT(*) AS n FROM posts GROUP BY community_did) pc
			   ON pc.community_did = c.did
			 ORDER BY c.followers_count DESC NULLS LAST, c.created_at DESC`
		)
		.all<CommunityListRow>();
	return res.results ?? [];
}

export async function getCommunityByHandle(
	db: D1Database,
	handle: string
): Promise<CommunityRow | null> {
	const res = await db
		.prepare(
			'SELECT did, handle, pds, secret_key_ciphertext, secret_key_iv, public_jwk_json, thumbprint, display_name, avatar, description, accent_color, followers_count, last_mention_seen_at, created_at FROM communities WHERE handle = ?'
		)
		.bind(handle)
		.first<CommunityRow>();
	return res ?? null;
}

export async function getCommunityByDid(
	db: D1Database,
	did: string
): Promise<CommunityRow | null> {
	const res = await db
		.prepare(
			'SELECT did, handle, pds, secret_key_ciphertext, secret_key_iv, public_jwk_json, thumbprint, display_name, avatar, description, accent_color, followers_count, last_mention_seen_at, created_at FROM communities WHERE did = ?'
		)
		.bind(did)
		.first<CommunityRow>();
	return res ?? null;
}

export async function insertCommunity(
	db: D1Database,
	row: Omit<CommunityRow, 'created_at'>
): Promise<void> {
	await db
		.prepare(
			'INSERT INTO communities (did, handle, pds, secret_key_ciphertext, secret_key_iv, public_jwk_json, thumbprint, display_name, avatar, description, accent_color, followers_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
		)
		.bind(
			row.did,
			row.handle,
			row.pds,
			row.secret_key_ciphertext,
			row.secret_key_iv,
			row.public_jwk_json,
			row.thumbprint,
			row.display_name,
			row.avatar,
			row.description,
			row.accent_color,
			row.followers_count
		)
		.run();
}

/**
 * Drop a community and all of its cached submission posts. Runs in a single
 * D1 batch so we don't leave orphaned posts behind if the community delete
 * half-fails. Posts go first because of the foreign key on `community_did`.
 */
export async function deleteCommunity(db: D1Database, did: string): Promise<void> {
	await db.batch([
		db.prepare('DELETE FROM posts WHERE community_did = ?').bind(did),
		db.prepare('DELETE FROM communities WHERE did = ?').bind(did)
	]);
}

export async function updateCommunityProfile(
	db: D1Database,
	did: string,
	data: {
		display_name: string | null;
		avatar: string | null;
		description: string | null;
		accent_color: string | null;
		followers_count: number | null;
	}
): Promise<void> {
	await db
		.prepare(
			'UPDATE communities SET display_name = ?, avatar = ?, description = ?, accent_color = ?, followers_count = ? WHERE did = ?'
		)
		.bind(
			data.display_name,
			data.avatar,
			data.description,
			data.accent_color,
			data.followers_count,
			did
		)
		.run();
}

/**
 * Mark a post as removed by a community moderator. Stamps
 * `removed_at = datetime('now')` and leaves every other column
 * alone. Idempotent: re-running on an already-removed row is a
 * no-op (the timestamp gets bumped but no extra state changes).
 *
 * Filters in the feed queries (`getRecentPostsForCommunity`,
 * `getCombinedFeed`, `getPostsDueForRefresh`) hide the row
 * immediately; `hasSubmission` still sees it so re-submission
 * attempts are blocked by the existing dedup.
 */
export async function markPostRemoved(db: D1Database, uri: string): Promise<void> {
	await db
		.prepare("UPDATE posts SET removed_at = datetime('now') WHERE uri = ?")
		.bind(uri)
		.run();
}

/**
 * Advance the mention-notifications cursor. The cron tick passes the
 * latest `indexedAt` it observed (or `now` on first-run initialization);
 * future ticks only process mentions strictly greater than this value.
 */
export async function updateCommunityMentionsSeenAt(
	db: D1Database,
	did: string,
	seenAt: string
): Promise<void> {
	await db
		.prepare('UPDATE communities SET last_mention_seen_at = ? WHERE did = ?')
		.bind(seenAt, did)
		.run();
}

/**
 * Returns true if the community already has a submission post quoting the
 * given URI. Used to dedup before creating the Bluesky record so we never
 * double-post.
 */
export async function hasSubmission(
	db: D1Database,
	communityDid: string,
	quotedPostUri: string
): Promise<boolean> {
	const res = await db
		.prepare('SELECT 1 FROM posts WHERE community_did = ? AND quoted_post_uri = ? LIMIT 1')
		.bind(communityDid, quotedPostUri)
		.first<{ 1: number }>();
	return !!res;
}

export async function insertPost(
	db: D1Database,
	row: Omit<PostRow, 'last_refreshed_at' | 'missing_since' | 'removed_at'>
): Promise<boolean> {
	try {
		await db
			.prepare(
				'INSERT INTO posts (uri, cid, community_did, title, quoted_post_uri, quoted_post_cid, author_did, like_count, reply_count, repost_count, like_count_at_submission, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
			)
			.bind(
				row.uri,
				row.cid,
				row.community_did,
				row.title,
				row.quoted_post_uri,
				row.quoted_post_cid,
				row.author_did,
				row.like_count,
				row.reply_count,
				row.repost_count,
				row.like_count_at_submission,
				row.indexed_at
			)
			.run();
		return true;
	} catch (e) {
		// Unique constraint on (community_did, quoted_post_uri) — dedup hit.
		if (String(e).includes('UNIQUE')) return false;
		throw e;
	}
}

export type PostSort = 'hot' | 'new' | 'top-day' | 'top-week' | 'top-month';

/** Map a sort key to a (where-clause, order-by-clause) pair. */
function sortClauses(sort: PostSort): { where: string; order: string } {
	switch (sort) {
		case 'hot':
			// Community lift ranking:
			//   lift  = current_likes − baseline_at_submission − 1   (clamped ≥ 0)
			//   score = lift^0.25 / (age_hours + 2)^2.5
			//
			// Two things this formula is deliberately tuned for, after
			// the previous `sqrt(lift) / (age+2)^1.8` version kept
			// surfacing days-old viral posts at the top of Hot:
			//
			//   1. `pow(lift, 0.25)` — i.e. sqrt(sqrt(lift)) — is much
			//      more aggressive compression than plain sqrt. It
			//      collapses the gap between "10 new likes" and
			//      "10,000 new likes" from 31× to ~5.6×, so a huge
			//      raw lift can't steamroll a fresh post on raw size
			//      alone. D1's SQLite gates `log10` (which would be
			//      the textbook choice here) but `pow` is on the
			//      allowed list, and sqrt-of-sqrt is close enough.
			//
			//   2. The `(age_hours + 2)^2.5` denominator decays
			//      significantly faster than the HN-canonical 1.8. At
			//      2.5, a 5h-old post with 10k lift scores ~0.077
			//      while a 10-min-old post with 10 lift scores
			//      ~0.250 — i.e. genuine "community just reacted
			//      to this" pops above "random old bsky-viral".
			//
			// The `− 1` floor on lift ensures a single new like
			// doesn't register (zero-engagement posts rank 0 and drop
			// to the bottom instead of leading Hot during quiet
			// periods). COALESCE still handles rows backfilled or
			// created in the migration/deploy gap where
			// `like_count_at_submission` is NULL — those degrade to
			// lift = 0 − 1, clamped to 0.
			//
			// Scoped to the last 7 days: the steep decay already
			// buries anything older but the explicit cutoff keeps
			// the index scan tight for the global feed.
			return {
				where: `AND p.indexed_at > datetime('now', '-7 days')`,
				order: `(pow(MAX(p.like_count - COALESCE(p.like_count_at_submission, p.like_count) - 1, 0), 0.25) / pow((julianday('now') - julianday(p.indexed_at)) * 24.0 + 2.0, 2.5)) DESC, p.indexed_at DESC`
			};
		case 'top-day':
			return {
				where: `AND p.indexed_at > datetime('now', '-1 day')`,
				order: `p.like_count DESC, p.indexed_at DESC`
			};
		case 'top-week':
			return {
				where: `AND p.indexed_at > datetime('now', '-7 days')`,
				order: `p.like_count DESC, p.indexed_at DESC`
			};
		case 'top-month':
			return {
				where: `AND p.indexed_at > datetime('now', '-30 days')`,
				order: `p.like_count DESC, p.indexed_at DESC`
			};
		case 'new':
		default:
			return { where: ``, order: `p.indexed_at DESC` };
	}
}

export async function getRecentPostsForCommunity(
	db: D1Database,
	communityDid: string,
	limit = 50,
	sort: PostSort = 'hot',
	offset = 0
): Promise<PostWithCommunity[]> {
	const { where, order } = sortClauses(sort);
	// Filter out:
	//   - `missing_since IS NOT NULL` → the underlying bsky post is
	//     gone/taken-down, grace-period sweep pending. Don't surface
	//     "(quoted post unavailable)" placeholders.
	//   - `removed_at IS NOT NULL` → a community mod removed this post.
	//     Invisible in every feed but still visible to `hasSubmission`
	//     so the submitter can't re-add it.
	const res = await db
		.prepare(
			`SELECT p.*, c.handle AS community_handle, c.display_name AS community_display_name, c.avatar AS community_avatar, c.accent_color AS community_accent_color
			 FROM posts p
			 JOIN communities c ON c.did = p.community_did
			 WHERE p.community_did = ?
			   AND p.missing_since IS NULL
			   AND p.removed_at IS NULL
			 ${where}
			 ORDER BY ${order}
			 LIMIT ? OFFSET ?`
		)
		.bind(communityDid, limit, offset)
		.all<PostWithCommunity>();
	return res.results ?? [];
}

/**
 * Look up a single post by its AT URI, JOINed with community metadata.
 * Used by the post detail page to show which community surfaced the post
 * (plus its title / timestamp / accent color).
 */
/**
 * Look up a single post by URI, JOINed with community metadata.
 * Does NOT filter on `removed_at` — the `removePost` remote command
 * uses this helper to look up posts it's about to mark removed,
 * so filtering would hide the row it needs to act on. Callers that
 * render to end users should check `removed_at IS NULL` themselves
 * if they care (the post detail page is the one place this matters).
 */
export async function getPostByUri(
	db: D1Database,
	uri: string
): Promise<PostWithCommunity | null> {
	const res = await db
		.prepare(
			`SELECT p.*, c.handle AS community_handle, c.display_name AS community_display_name, c.avatar AS community_avatar, c.accent_color AS community_accent_color
			 FROM posts p
			 JOIN communities c ON c.did = p.community_did
			 WHERE p.uri = ?
			 LIMIT 1`
		)
		.bind(uri)
		.first<PostWithCommunity>();
	return res ?? null;
}

export async function getCombinedFeed(
	db: D1Database,
	limit = 50,
	sort: PostSort = 'hot',
	offset = 0
): Promise<PostWithCommunity[]> {
	const { where, order } = sortClauses(sort);
	// Same filter rationale as `getRecentPostsForCommunity`: drop
	// rows flagged as missing (upstream post gone) OR as removed
	// (community mod action). `sortClauses` returns a fragment
	// starting with `AND` (written for the community-scoped query's
	// `WHERE p.community_did = ?` base), so the missing_since +
	// removed_at filters here provide the base `WHERE` the AND can
	// attach to.
	const res = await db
		.prepare(
			`SELECT p.*, c.handle AS community_handle, c.display_name AS community_display_name, c.avatar AS community_avatar, c.accent_color AS community_accent_color
			 FROM posts p
			 JOIN communities c ON c.did = p.community_did
			 WHERE p.missing_since IS NULL
			   AND p.removed_at IS NULL
			 ${where}
			 ORDER BY ${order}
			 LIMIT ? OFFSET ?`
		)
		.bind(limit, offset)
		.all<PostWithCommunity>();
	return res.results ?? [];
}

// ---------------------------------------------------------------------------
// Jetstream cursor persistence
// ---------------------------------------------------------------------------

/**
 * Read the last jetstream cursor (microseconds since epoch) from the
 * `sync_state` singleton row. Returns null when we've never drained before.
 */
export async function getJetstreamCursor(db: D1Database): Promise<number | null> {
	const res = await db
		.prepare('SELECT jetstream_cursor FROM sync_state WHERE id = 1')
		.first<{ jetstream_cursor: number | null }>();
	return res?.jetstream_cursor ?? null;
}

/**
 * Upsert the jetstream cursor. `INSERT ... ON CONFLICT` keeps the row
 * singleton and always stamps `updated_at`.
 */
export async function saveJetstreamCursor(
	db: D1Database,
	cursor: number
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO sync_state (id, jetstream_cursor, updated_at)
			 VALUES (1, ?, datetime('now'))
			 ON CONFLICT(id) DO UPDATE SET
			   jetstream_cursor = excluded.jetstream_cursor,
			   updated_at = excluded.updated_at`
		)
		.bind(cursor)
		.run();
}

// Posts due for metric refresh based on age-decayed cadence.
// Age buckets:
//   <1h          → every 60s (every run)
//   1-12h        → every 5m
//   12-24h       → every 10m
//   1-7d         → every 1h
//   >7d          → every 24h
//
// Returns both `uri` (the community's quote/repost record) and
// `quoted_post_uri` (the original post being quoted). The cron fetches
// metrics on the quoted post and writes them back to the row keyed by
// `uri` — so `posts.like_count` reflects the ORIGINAL post's popularity,
// which is what the UI and the "top" sort need.
//
// Rows are round-robined across communities using a ROW_NUMBER() window
// partitioned by community_did. Sorting by the partition rank first
// (then by last_refreshed_at within rank) means the tick picks each
// community's most-stale post before any community gets a second slot,
// which stops a single high-volume community from starving smaller ones
// out of the global LIMIT budget.
export async function getPostsDueForRefresh(
	db: D1Database,
	limit = 100
): Promise<{ uri: string; quoted_post_uri: string }[]> {
	const res = await db
		.prepare(
			`WITH due AS (
				SELECT
					uri,
					quoted_post_uri,
					last_refreshed_at,
					ROW_NUMBER() OVER (
						PARTITION BY community_did
						ORDER BY last_refreshed_at ASC
					) AS rank_in_community
				FROM posts
				WHERE
					removed_at IS NULL
					AND (
						(julianday('now') - julianday(indexed_at)) * 24 < 1
						OR ((julianday('now') - julianday(indexed_at)) * 24 < 12 AND (julianday('now') - julianday(last_refreshed_at)) * 1440 >= 5)
						OR ((julianday('now') - julianday(indexed_at)) * 24 < 24 AND (julianday('now') - julianday(last_refreshed_at)) * 1440 >= 10)
						OR ((julianday('now') - julianday(indexed_at)) < 7 AND (julianday('now') - julianday(last_refreshed_at)) * 24 >= 1)
						OR ((julianday('now') - julianday(indexed_at)) >= 7 AND (julianday('now') - julianday(last_refreshed_at)) >= 1)
					)
			)
			SELECT uri, quoted_post_uri FROM due
			ORDER BY rank_in_community ASC, last_refreshed_at ASC
			LIMIT ?`
		)
		.bind(limit)
		.all<{ uri: string; quoted_post_uri: string }>();
	return res.results ?? [];
}

/**
 * Rows past the deletion grace period — used by the cron's
 * `sweepDeletedPosts` step. A row qualifies when `missing_since` is
 * non-NULL (set by the refresh path on the first tick that the quoted
 * bsky post dropped out of `getPosts`) AND the grace period has fully
 * elapsed since that stamp. Ordered oldest-missing-first so chronically
 * dead rows get cleaned up before newly-detected ones when the per-tick
 * cap is hit.
 */
export async function getPostsPastDeletionGrace(
	db: D1Database,
	graceHours: number,
	limit: number
): Promise<{ uri: string; community_did: Did }[]> {
	const res = await db
		.prepare(
			`SELECT uri, community_did
			 FROM posts
			 WHERE missing_since IS NOT NULL
			   AND (julianday('now') - julianday(missing_since)) * 24 >= ?
			 ORDER BY missing_since ASC
			 LIMIT ?`
		)
		.bind(graceHours, limit)
		.all<{ uri: string; community_did: Did }>();
	return res.results ?? [];
}

/**
 * Delete a set of cached submission rows by URI. Used by the sweep
 * after the community-account wrapper records have been deleted from
 * bsky (best-effort — we still drop the D1 row even if the bsky delete
 * fails, to avoid indefinite retries on broken rows).
 */
export async function deletePostsByUris(
	db: D1Database,
	uris: string[]
): Promise<void> {
	if (uris.length === 0) return;
	await db.batch(
		uris.map((uri) => db.prepare('DELETE FROM posts WHERE uri = ?').bind(uri))
	);
}
