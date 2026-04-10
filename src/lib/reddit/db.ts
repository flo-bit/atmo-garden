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
			`SELECT c.did, c.handle, c.pds, c.secret_key_ciphertext, c.secret_key_iv, c.public_jwk_json, c.thumbprint, c.display_name, c.avatar, c.description, c.accent_color, c.followers_count, c.created_at,
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
			'SELECT did, handle, pds, secret_key_ciphertext, secret_key_iv, public_jwk_json, thumbprint, display_name, avatar, description, accent_color, followers_count, created_at FROM communities WHERE handle = ?'
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
			'SELECT did, handle, pds, secret_key_ciphertext, secret_key_iv, public_jwk_json, thumbprint, display_name, avatar, description, accent_color, followers_count, created_at FROM communities WHERE did = ?'
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

export async function insertPost(db: D1Database, row: Omit<PostRow, 'last_refreshed_at'>): Promise<boolean> {
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

export async function updatePostMetrics(
	db: D1Database,
	uri: string,
	metrics: { like_count: number; reply_count: number; repost_count: number }
): Promise<void> {
	await db
		.prepare(
			'UPDATE posts SET like_count = ?, reply_count = ?, repost_count = ?, last_refreshed_at = datetime("now") WHERE uri = ?'
		)
		.bind(metrics.like_count, metrics.reply_count, metrics.repost_count, uri)
		.run();
}

export type PostSort = 'hot' | 'new' | 'top-day' | 'top-week' | 'top-month';

/** Map a sort key to a (where-clause, order-by-clause) pair. */
function sortClauses(sort: PostSort): { where: string; order: string } {
	switch (sort) {
		case 'hot':
			// Community lift ranking:
			//   lift = current_likes − baseline_at_submission   (never < 0)
			//   score = log10(lift + 1) / (submission_age_hours + 2)^1.8
			// The `log10` compresses extreme engagement so a post with
			// thousands of new likes doesn't completely drown out smaller
			// genuine community discussions. The HN-style denominator
			// decays with submission age. Scoped to the last 7 days so
			// stale submissions fall out of Hot entirely.
			// COALESCE handles rows in the narrow window between migration
			// and code deploy, and backfilled old rows — both degrade to
			// "baseline = current" = zero lift, ranking them at the bottom.
			return {
				where: `AND p.indexed_at > datetime('now', '-7 days')`,
				order: `(log10(MAX(p.like_count - COALESCE(p.like_count_at_submission, p.like_count), 0) + 1.0) / pow((julianday('now') - julianday(p.indexed_at)) * 24.0 + 2.0, 1.8)) DESC, p.indexed_at DESC`
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
	const res = await db
		.prepare(
			`SELECT p.*, c.handle AS community_handle, c.display_name AS community_display_name, c.avatar AS community_avatar, c.accent_color AS community_accent_color
			 FROM posts p
			 JOIN communities c ON c.did = p.community_did
			 WHERE p.community_did = ?
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
	// sortClauses returns a fragment starting with `AND` since it was
	// written for the community-scoped query that always has a
	// `WHERE p.community_did = ?` clause. For the home feed there's no
	// base WHERE, so we rewrite the leading `AND` to `WHERE`.
	const whereClause = where ? where.replace(/^\s*AND\s+/, 'WHERE ') : '';
	const res = await db
		.prepare(
			`SELECT p.*, c.handle AS community_handle, c.display_name AS community_display_name, c.avatar AS community_avatar, c.accent_color AS community_accent_color
			 FROM posts p
			 JOIN communities c ON c.did = p.community_did
			 ${whereClause}
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
export async function getPostsDueForRefresh(
	db: D1Database,
	limit = 100
): Promise<{ uri: string; quoted_post_uri: string }[]> {
	const res = await db
		.prepare(
			`SELECT uri, quoted_post_uri FROM posts
			 WHERE
				 (julianday('now') - julianday(indexed_at)) * 24 < 1
				 OR ((julianday('now') - julianday(indexed_at)) * 24 < 12 AND (julianday('now') - julianday(last_refreshed_at)) * 1440 >= 5)
				 OR ((julianday('now') - julianday(indexed_at)) * 24 < 24 AND (julianday('now') - julianday(last_refreshed_at)) * 1440 >= 10)
				 OR ((julianday('now') - julianday(indexed_at)) < 7 AND (julianday('now') - julianday(last_refreshed_at)) * 24 >= 1)
				 OR ((julianday('now') - julianday(indexed_at)) >= 7 AND (julianday('now') - julianday(last_refreshed_at)) >= 1)
			 ORDER BY last_refreshed_at ASC
			 LIMIT ?`
		)
		.bind(limit)
		.all<{ uri: string; quoted_post_uri: string }>();
	return res.results ?? [];
}
