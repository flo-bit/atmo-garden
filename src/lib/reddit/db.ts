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
	indexed_at: string;
	last_refreshed_at: string;
};

export type PostWithCommunity = PostRow & {
	community_handle: string;
	community_display_name: string | null;
	community_avatar: string | null;
	community_accent_color: string | null;
};

export async function listCommunities(db: D1Database): Promise<CommunityRow[]> {
	const res = await db
		.prepare(
			'SELECT did, handle, pds, secret_key_ciphertext, secret_key_iv, public_jwk_json, thumbprint, display_name, avatar, description, accent_color, created_at FROM communities ORDER BY created_at DESC'
		)
		.all<CommunityRow>();
	return res.results ?? [];
}

export async function getCommunityByHandle(
	db: D1Database,
	handle: string
): Promise<CommunityRow | null> {
	const res = await db
		.prepare(
			'SELECT did, handle, pds, secret_key_ciphertext, secret_key_iv, public_jwk_json, thumbprint, display_name, avatar, description, accent_color, created_at FROM communities WHERE handle = ?'
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
			'SELECT did, handle, pds, secret_key_ciphertext, secret_key_iv, public_jwk_json, thumbprint, display_name, avatar, description, accent_color, created_at FROM communities WHERE did = ?'
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
			'INSERT INTO communities (did, handle, pds, secret_key_ciphertext, secret_key_iv, public_jwk_json, thumbprint, display_name, avatar, description, accent_color) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
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
			row.accent_color
		)
		.run();
}

export async function updateCommunityProfile(
	db: D1Database,
	did: string,
	data: {
		display_name: string | null;
		avatar: string | null;
		description: string | null;
		accent_color?: string | null;
	}
): Promise<void> {
	if (data.accent_color !== undefined) {
		await db
			.prepare(
				'UPDATE communities SET display_name = ?, avatar = ?, description = ?, accent_color = ? WHERE did = ?'
			)
			.bind(data.display_name, data.avatar, data.description, data.accent_color, did)
			.run();
	} else {
		await db
			.prepare(
				'UPDATE communities SET display_name = ?, avatar = ?, description = ? WHERE did = ?'
			)
			.bind(data.display_name, data.avatar, data.description, did)
			.run();
	}
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
				'INSERT INTO posts (uri, cid, community_did, title, quoted_post_uri, quoted_post_cid, author_did, like_count, reply_count, repost_count, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
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

export async function getRecentPostsForCommunity(
	db: D1Database,
	communityDid: string,
	limit = 50
): Promise<PostRow[]> {
	const res = await db
		.prepare(
			'SELECT * FROM posts WHERE community_did = ? ORDER BY indexed_at DESC LIMIT ?'
		)
		.bind(communityDid, limit)
		.all<PostRow>();
	return res.results ?? [];
}

export async function getCombinedFeed(
	db: D1Database,
	limit = 50
): Promise<PostWithCommunity[]> {
	const res = await db
		.prepare(
			`SELECT p.*, c.handle AS community_handle, c.display_name AS community_display_name, c.avatar AS community_avatar, c.accent_color AS community_accent_color
			 FROM posts p
			 JOIN communities c ON c.did = p.community_did
			 ORDER BY p.indexed_at DESC
			 LIMIT ?`
		)
		.bind(limit)
		.all<PostWithCommunity>();
	return res.results ?? [];
}

// Posts due for metric refresh based on age-decayed cadence.
// Age buckets:
//   <1h          → every 60s (every run)
//   1-12h        → every 5m
//   12-24h       → every 10m
//   1-7d         → every 1h
//   >7d          → every 24h
export async function getPostsDueForRefresh(
	db: D1Database,
	limit = 100
): Promise<{ uri: string }[]> {
	const res = await db
		.prepare(
			`SELECT uri FROM posts
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
		.all<{ uri: string }>();
	return res.results ?? [];
}
