// Shared cache layer for the feed pipeline.
//
// All of our feed surfaces — the atmo.garden home page
// (`getHomeFeed`), the bsky feed generator XRPC handler
// (`getFeedSkeleton`), and the following-feed variants — read from
// the same materialized sorted lists stored in Workers KV (binding
// `FEEDS_CACHE`). The cron tick rewrites those lists once per minute
// from `getCombinedFeed`, so the hot path never touches D1.
//
// Two cache tiers:
//
//   1. Workers KV (`env.FEEDS_CACHE`) — global, durable, written by
//      the cron once per minute. Source of truth.
//   2. Workers Cache API (per-colocation edge cache, free) — sits in
//      front of KV for both sorted lists and per-viewer follow
//      intersections. 30 s TTL on lists, 5 min TTL on follow sets.
//
// The following-feed paths also cache each viewer's set of followed
// community DIDs through the same Cache API layer. Invalidation is
// best-effort per-colo via `invalidateViewerCommunityFollows`,
// triggered by the `POST /api/refresh-follows` endpoint the UI hits
// after a user toggles a community follow.
//
// See `scripts/publish-feed-generators.ts` for the feed records this
// cache eventually serves, and the main cron's `rebuildFeedCaches`
// step for how the KV entries get populated.

import type { PostSort, PostWithCommunity } from './db';
import { listCommunities } from './db';

// Cloudflare Workers Cache API — `caches.default` is a CF-specific
// extension not present on the DOM's `CacheStorage` type, AND the
// `caches` global itself isn't defined in vite's Node SSR runtime
// during `pnpm dev`. We cast once at the top and fall back to a
// no-op shim when the global is missing so the module still loads
// in dev — all cache operations become harmless no-ops and every
// request falls through to KV (which DOES work via platformProxy
// against the remote binding). In production on Workers the real
// `caches.default` takes over transparently.
type MinimalCache = {
	match(key: Request): Promise<Response | undefined>;
	put(key: Request, value: Response): Promise<void>;
	delete(key: Request): Promise<boolean>;
};

const noopCache: MinimalCache = {
	async match() {
		return undefined;
	},
	async put() {
		/* no-op */
	},
	async delete() {
		return false;
	}
};

const cfCache: MinimalCache =
	typeof caches !== 'undefined' &&
	(caches as unknown as { default?: MinimalCache }).default
		? (caches as unknown as { default: MinimalCache }).default
		: noopCache;

// ---------------------------------------------------------------------------
// Sorted-list cache (materialized `getCombinedFeed` output per sort)
// ---------------------------------------------------------------------------

/**
 * Upper bound on how many rows per sort we materialize and store in
 * KV. The main page's infinite scroll and every feed generator call
 * share this cap — users can page through the top 1000 per sort, and
 * scrolling past that stops. Bump if users start complaining; lower
 * if KV storage gets tight. 1000 rows × ~500 bytes/row = ~500 KB per
 * sort, well under KV's 25 MB value limit.
 */
export const FEED_CACHE_LIMIT = 1000;

/**
 * KV key naming: one key per sort. Values are JSON-serialized
 * `PostWithCommunity[]` with length ≤ `FEED_CACHE_LIMIT`, in sort
 * order. `missing_since IS NULL` is already applied by the underlying
 * `getCombinedFeed` query so we never surface rows that are pending
 * sweep.
 */
function kvKeyForSort(sort: PostSort): string {
	return `sorted:${sort}`;
}

/**
 * Edge-cache key for the sorted list. Workers Cache API keys are
 * Request objects; the URL doesn't have to resolve — it's purely a
 * deterministic identifier.
 */
function cacheKeyForSort(sort: PostSort): Request {
	return new Request(`https://cache.internal/feeds/sorted/${sort}`);
}

/**
 * Write the materialized sorted list for a given sort into KV. Called
 * by the cron's `rebuildFeedCaches` step. Includes a 5 min
 * `expirationTtl` as a belt-and-suspenders safety net — the cron
 * overwrites every minute, so the TTL only matters if the cron stops
 * running entirely.
 */
export async function writeSortedList(
	env: App.Platform['env'],
	sort: PostSort,
	rows: PostWithCommunity[]
): Promise<void> {
	await env.FEEDS_CACHE.put(kvKeyForSort(sort), JSON.stringify(rows), {
		expirationTtl: 300
	});
}

/**
 * Read a sorted list through the edge cache, falling back to KV,
 * and optionally falling back further to a caller-provided fresh
 * fetch if both cache tiers come up empty.
 *
 * Flow:
 *   1. Check Workers Cache API. Hit with a non-empty list → return it.
 *      (Empty hits still fall through to the KV + fresh-fetch path
 *      so we can recover from a previous cache-miss window that
 *      pinned an empty result.)
 *   2. Miss → fetch from KV.
 *   3. KV also empty AND `fetchFresh` provided → run it once,
 *      write-through to KV so other colos benefit, and use the
 *      result for this request.
 *   4. Populate the edge cache with a 30 s `s-maxage` for the next
 *      request from this colo.
 *
 * The `fetchFresh` callback is the reactive-rebuild hatch: the cron
 * normally re-populates KV every minute, but there are two edge
 * cases where the cache can legitimately be empty:
 *
 *   - Fresh deploy before the first cron tick runs
 *   - KV `expirationTtl` kicks in after the cron fails for 5+ min
 *
 * In both cases, serving an empty feed would be bad UX. The callback
 * runs `getCombinedFeed` directly and fixes itself — one D1 query
 * cost on the rare miss, amortized across future requests.
 *
 * The 30 s edge TTL is chosen to be well under the cron tick
 * frequency, so each colo hits KV at most ~2×/min per sort — ~1.4 M
 * KV reads/month across ~200 colos, cheap.
 */
export async function getCachedSortedList(
	env: App.Platform['env'],
	sort: PostSort,
	fetchFresh?: () => Promise<PostWithCommunity[]>
): Promise<PostWithCommunity[]> {
	const cacheKey = cacheKeyForSort(sort);
	const cached = await cfCache.match(cacheKey);
	if (cached) {
		try {
			const parsed = (await cached.json()) as PostWithCommunity[];
			// Non-empty edge-cache hit wins. If the cached value is
			// empty we drop through to KV + fresh-fetch so we don't
			// stay pinned to "no posts" after a recovery.
			if (parsed.length > 0) return parsed;
		} catch (e) {
			console.error(`[feed-cache] cached list parse failed for ${sort}`, e);
			// fall through to re-fetch
		}
	}

	const raw = await env.FEEDS_CACHE.get(kvKeyForSort(sort));
	let list: PostWithCommunity[] = raw ? (JSON.parse(raw) as PostWithCommunity[]) : [];

	// Reactive rebuild: cron hasn't populated KV yet (or the safety
	// TTL kicked in) AND the caller gave us a way to query D1
	// directly. Run the underlying query once, write the result
	// back to KV so other colos stop seeing empty too, and use it
	// for this request.
	if (list.length === 0 && fetchFresh) {
		try {
			const fresh = await fetchFresh();
			if (fresh.length > 0) {
				list = fresh;
				await writeSortedList(env, sort, list);
			}
		} catch (e) {
			console.error(`[feed-cache] fetchFresh failed for ${sort}`, e);
		}
	}

	await cfCache.put(
		cacheKey,
		new Response(JSON.stringify(list), {
			headers: {
				'content-type': 'application/json',
				'cache-control': 'public, s-maxage=30'
			}
		})
	);
	return list;
}

// ---------------------------------------------------------------------------
// Community-DID list (small, ~100 entries, rarely changes)
// ---------------------------------------------------------------------------

const COMMUNITY_DIDS_KV_KEY = 'communities:dids';
const COMMUNITY_DIDS_CACHE_KEY = new Request('https://cache.internal/communities/dids');

/**
 * Rewrite the list of all known community DIDs into KV. Called by
 * the cron alongside the sorted-list rebuild — the community set
 * changes rarely (new registrations) so hourly-ish staleness is
 * fine, but running it on every tick is also trivially cheap.
 */
export async function writeAllCommunityDids(
	env: App.Platform['env'],
	db: D1Database
): Promise<void> {
	const rows = await listCommunities(db);
	const dids = rows.map((r) => r.did);
	await env.FEEDS_CACHE.put(COMMUNITY_DIDS_KV_KEY, JSON.stringify(dids), {
		expirationTtl: 3600
	});
}

/**
 * Read the list of all known community DIDs, edge-cached. Used by
 * `fetchViewerCommunityRelationships` to know which DIDs to ask bsky
 * about in each `getRelationships` batch.
 */
export async function getAllCommunityDids(env: App.Platform['env']): Promise<string[]> {
	const cached = await cfCache.match(COMMUNITY_DIDS_CACHE_KEY);
	if (cached) {
		try {
			return (await cached.json()) as string[];
		} catch {
			/* fall through */
		}
	}

	const raw = await env.FEEDS_CACHE.get(COMMUNITY_DIDS_KV_KEY);
	const dids: string[] = raw ? (JSON.parse(raw) as string[]) : [];

	await cfCache.put(
		COMMUNITY_DIDS_CACHE_KEY,
		new Response(JSON.stringify(dids), {
			headers: {
				'content-type': 'application/json',
				'cache-control': 'public, s-maxage=300'
			}
		})
	);
	return dids;
}

// ---------------------------------------------------------------------------
// Per-viewer community-follows cache
// ---------------------------------------------------------------------------

const BSKY_APPVIEW_PUBLIC = 'https://public.api.bsky.app';

/**
 * Max DIDs allowed per `app.bsky.graph.getRelationships` call, per
 * the lexicon's `others` array maxLength. Any more and bsky returns
 * 400.
 */
const RELATIONSHIPS_BATCH_SIZE = 30;

function viewerFollowsCacheKey(viewerDid: string): Request {
	// URL-encode the DID so colons etc. don't confuse the cache.
	return new Request(
		`https://cache.internal/follows/${encodeURIComponent(viewerDid)}`
	);
}

/**
 * Call `app.bsky.graph.getRelationships` against the public bsky
 * appview in parallel batches, asking whether `viewerDid` follows
 * each community DID. Returns the subset of community DIDs that
 * `viewerDid` follows.
 *
 * Uses `getRelationships` instead of `getFollows` because we only
 * care about a specific small set of DIDs (the community accounts),
 * not the user's entire follow graph. This is O(communities) instead
 * of O(user's follows) and scales with a stable number (~100).
 */
export async function fetchViewerCommunityRelationships(
	viewerDid: string,
	communityDids: string[]
): Promise<string[]> {
	if (communityDids.length === 0) return [];

	// Chunk into batches of 30.
	const batches: string[][] = [];
	for (let i = 0; i < communityDids.length; i += RELATIONSHIPS_BATCH_SIZE) {
		batches.push(communityDids.slice(i, i + RELATIONSHIPS_BATCH_SIZE));
	}

	const results = await Promise.all(
		batches.map(async (batch) => {
			const url = new URL(
				`${BSKY_APPVIEW_PUBLIC}/xrpc/app.bsky.graph.getRelationships`
			);
			url.searchParams.set('actor', viewerDid);
			// `others` is an array; repeated query params.
			for (const did of batch) url.searchParams.append('others', did);
			try {
				const res = await fetch(url);
				if (!res.ok) {
					console.error(
						'[feed-cache] getRelationships non-ok',
						res.status,
						batch.length
					);
					return [] as string[];
				}
				const body = (await res.json()) as {
					relationships?: Array<
						| { did: string; following?: string; followedBy?: string }
						| { actor: string; notFound: true }
					>;
				};
				const followed: string[] = [];
				for (const rel of body.relationships ?? []) {
					// `following` is set when `viewerDid` follows this DID.
					if ('did' in rel && typeof rel.following === 'string') {
						followed.push(rel.did);
					}
				}
				return followed;
			} catch (e) {
				console.error('[feed-cache] getRelationships threw', e);
				return [];
			}
		})
	);

	// Flatten. Any batch that failed just contributes nothing — we
	// return a possibly-incomplete follow set, which silently hides
	// some of the user's real follows until the next refresh. Better
	// than erroring out the whole feed.
	return results.flat();
}

/**
 * Read the cached set of community DIDs the viewer follows. Cache
 * miss triggers a fresh `getRelationships` fan-out (parallel batches,
 * ~150ms worst case) and a 5 min edge-cache write.
 *
 * Returns the intersection of "communities on atmo.garden" ∩ "DIDs
 * the viewer follows on bsky", using bsky's native graph as the
 * source of truth. No D1 writes, no new follow table — the user's
 * `app.bsky.graph.follow` records on their own PDS drive everything.
 */
export async function getCachedViewerCommunityFollows(
	env: App.Platform['env'],
	viewerDid: string
): Promise<string[]> {
	const cacheKey = viewerFollowsCacheKey(viewerDid);
	const cached = await cfCache.match(cacheKey);
	if (cached) {
		try {
			return (await cached.json()) as string[];
		} catch {
			/* fall through */
		}
	}

	const communityDids = await getAllCommunityDids(env);
	const followed = await fetchViewerCommunityRelationships(viewerDid, communityDids);

	await cfCache.put(
		cacheKey,
		new Response(JSON.stringify(followed), {
			headers: {
				'content-type': 'application/json',
				'cache-control': 'public, s-maxage=300'
			}
		})
	);
	return followed;
}

/**
 * Purge the cached follow set for a viewer and eagerly repopulate it
 * from bsky. Called by `POST /api/refresh-follows` after the UI
 * writes a new `app.bsky.graph.follow` record.
 *
 * Important caveat: Workers Cache API is **per-colocation**, so this
 * only busts the cache at the colo handling the current request.
 * Other colos will continue to serve stale data until their 5 min
 * TTL expires. In practice this is fine — users' follow-then-reload
 * flows stick to the same colo via TCP/TLS stickiness and geo
 * routing. Cross-colo invalidation would require moving this cache
 * to KV, which roughly triples monthly cost.
 */
export async function invalidateViewerCommunityFollows(
	env: App.Platform['env'],
	viewerDid: string
): Promise<string[]> {
	const cacheKey = viewerFollowsCacheKey(viewerDid);
	await cfCache.delete(cacheKey);
	// Eagerly repopulate so the refresh round-trip includes the fresh
	// data — the UI can immediately use it (or at least knows the
	// bsky graph has propagated).
	return getCachedViewerCommunityFollows(env, viewerDid);
}

// ---------------------------------------------------------------------------
// JWT helper (unverified payload parsing)
// ---------------------------------------------------------------------------

/**
 * Pull the `iss` claim out of a service-auth JWT in the
 * `Authorization: Bearer <jwt>` header. Does **not** verify the
 * signature — the attack surface is "see how a different user's
 * feed would look," which is bounded by the fact that bsky follow
 * graphs are public anyway. Proper signature verification would
 * require fetching the caller's DID doc and running ES256K against
 * their repo signing key; worth doing eventually, not blocking for
 * MVP.
 *
 * Also rejects obviously-expired JWTs as a minimal sanity check.
 */
export function parseViewerDidFromJwt(authHeader: string | null): string | null {
	if (!authHeader) return null;
	const m = authHeader.match(/^Bearer (.+)$/i);
	if (!m) return null;
	const parts = m[1].split('.');
	if (parts.length !== 3) return null;

	try {
		// base64url → base64 → atob
		let payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
		while (payloadB64.length % 4 !== 0) payloadB64 += '=';
		const json = atob(payloadB64);
		const obj = JSON.parse(json) as { iss?: unknown; exp?: unknown };

		// Sanity: reject JWTs whose expiry is already past.
		if (typeof obj.exp === 'number' && obj.exp * 1000 < Date.now()) return null;

		const iss = obj.iss;
		if (typeof iss !== 'string' || !iss.startsWith('did:')) return null;
		return iss;
	} catch {
		return null;
	}
}
