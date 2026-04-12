// Purge the edge-cached community-follow set for the authenticated
// user, then eagerly repopulate it from bsky's public appview via
// `getRelationships`. Called by the community page's follow / unfollow
// button after a successful `app.bsky.graph.follow` (or delete) write
// on the user's PDS, so the next `getFeedSkeleton` call for this
// user picks up the new community subscription without waiting for
// the default 5 min TTL.
//
// Per-colo invalidation only — see `invalidateViewerCommunityFollows`
// in `src/lib/reddit/feed-cache.ts` for the tradeoff. In practice the
// user's "follow → reload feed" flow stays on one Cloudflare colo via
// TCP/TLS stickiness + geo routing, so the stale-in-other-colos
// window is a non-issue for interactive UX.

import type { RequestHandler } from './$types';
import { json, error } from '@sveltejs/kit';
import { invalidateViewerCommunityFollows } from '$lib/reddit/feed-cache';

export const POST: RequestHandler = async ({ platform, locals }) => {
	const env = platform?.env;
	if (!env) error(500, 'Platform env unavailable');
	if (!locals.did) error(401, 'Not authenticated');

	// `invalidateViewerCommunityFollows` deletes the cached entry at
	// the current colo and then re-fetches from bsky, so this request
	// returns with the fresh data baked into the per-colo cache. The
	// UI doesn't need the returned list today, but we include it in
	// the response in case it wants to render immediate feedback
	// ("you now follow N communities") without a second round-trip.
	const followed = await invalidateViewerCommunityFollows(env, locals.did, env.DB);

	return json({ ok: true, followedCount: followed.length });
};
