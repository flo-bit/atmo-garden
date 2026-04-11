import { error } from '@sveltejs/kit';
import { command, getRequestEvent } from '$app/server';
import * as v from 'valibot';
import type { ResourceUri } from '@atcute/lexicons';
import { Client, simpleFetchHandler } from '@atcute/client';
import * as TID from '@atcute/tid';

/**
 * Resolve a batch of DIDs to their minimal profile view (handle + display
 * name + avatar). Uses the public appview so it works for signed-out
 * viewers too. Returns a map keyed by DID; missing or failed lookups are
 * simply absent from the result.
 */
export const resolveProfiles = command(
	v.object({
		dids: v.array(v.string())
	}),
	async (input) => {
		const out: Record<
			string,
			{ handle: string; displayName: string | null; avatar: string | null }
		> = {};
		if (input.dids.length === 0) return { profiles: out };

		// Dedupe before hitting the network — a feed with N posts often has
		// far fewer distinct submitters than N. Uses the public appview,
		// unauthenticated, so there are no scope concerns.
		const unique = Array.from(new Set(input.dids));
		const publicClient = new Client({
			handler: simpleFetchHandler({ service: 'https://public.api.bsky.app' })
		});

		for (let i = 0; i < unique.length; i += 25) {
			const batch = unique.slice(i, i + 25);
			try {
				const res = await publicClient.get('app.bsky.actor.getProfiles', {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					params: { actors: batch as any }
				});
				if (res.ok) {
					for (const p of res.data.profiles) {
						out[p.did] = {
							handle: p.handle,
							displayName: p.displayName ?? null,
							avatar: p.avatar ?? null
						};
					}
				}
			} catch (e) {
				console.error('[resolveProfiles] batch failed', e);
			}
		}

		return { profiles: out };
	}
);

/**
 * Fetch viewer-specific state for a batch of post URIs. Returns a map
 * `{ [uri]: { likeUri: string | null } }` so the caller can render
 * per-post "liked by me" UI. Requires an authenticated viewer — returns
 * an empty map when signed out.
 */
export const getPostsViewerState = command(
	v.object({
		uris: v.array(v.string())
	}),
	async (input) => {
		const { locals } = getRequestEvent();
		const out: Record<string, { likeUri: string | null }> = {};
		if (!locals.client || !locals.did) return { states: out };

		for (let i = 0; i < input.uris.length; i += 25) {
			const batch = input.uris.slice(i, i + 25) as ResourceUri[];
			try {
				const res = await locals.client.get('app.bsky.feed.getPosts', {
					params: { uris: batch }
				});
				if (res.ok) {
					for (const p of res.data.posts) {
						out[p.uri] = { likeUri: p.viewer?.like ?? null };
					}
				}
			} catch (e) {
				console.error('[getPostsViewerState] batch failed', e);
			}
		}

		return { states: out };
	}
);

export const likePost = command(
	v.object({
		uri: v.string(),
		cid: v.string()
	}),
	async (input) => {
		const { locals } = getRequestEvent();
		if (!locals.client || !locals.did) error(401, 'Not authenticated');

		const rkey = TID.now();
		const res = await locals.client.post('com.atproto.repo.createRecord', {
			input: {
				repo: locals.did,
				collection: 'app.bsky.feed.like',
				rkey,
				record: {
					$type: 'app.bsky.feed.like',
					subject: { uri: input.uri, cid: input.cid },
					createdAt: new Date().toISOString()
				}
			}
		});

		if (!res.ok) error(res.status, 'Failed to like post');
		return { uri: res.data.uri };
	}
);

export const unlikePost = command(
	v.object({
		likeUri: v.string()
	}),
	async (input) => {
		const { locals } = getRequestEvent();
		if (!locals.client || !locals.did) error(401, 'Not authenticated');

		const parts = input.likeUri.split('/');
		const rkey = parts[parts.length - 1];

		const res = await locals.client.post('com.atproto.repo.deleteRecord', {
			input: {
				repo: locals.did,
				collection: 'app.bsky.feed.like',
				rkey
			}
		});

		if (!res.ok) error(res.status, 'Failed to unlike post');
		return { ok: true };
	}
);

export const followUser = command(
	v.object({
		did: v.string()
	}),
	async (input) => {
		const { locals } = getRequestEvent();
		if (!locals.client || !locals.did) error(401, 'Not authenticated');

		const rkey = TID.now();
		const res = await locals.client.post('com.atproto.repo.createRecord', {
			input: {
				repo: locals.did,
				collection: 'app.bsky.graph.follow',
				rkey,
				record: {
					$type: 'app.bsky.graph.follow',
					subject: input.did,
					createdAt: new Date().toISOString()
				}
			}
		});

		if (!res.ok) error(res.status, 'Failed to follow');
		return { uri: res.data.uri };
	}
);

export const unfollowUser = command(
	v.object({
		followUri: v.string()
	}),
	async (input) => {
		const { locals } = getRequestEvent();
		if (!locals.client || !locals.did) error(401, 'Not authenticated');

		const parts = input.followUri.split('/');
		const rkey = parts[parts.length - 1];

		const res = await locals.client.post('com.atproto.repo.deleteRecord', {
			input: {
				repo: locals.did,
				collection: 'app.bsky.graph.follow',
				rkey
			}
		});

		if (!res.ok) error(res.status, 'Failed to unfollow');
		return { ok: true };
	}
);

export const getProfile = command(
	v.object({
		actor: v.string()
	}),
	async (input) => {
		const { locals } = getRequestEvent();

		const client = locals.client ?? new Client({
			handler: simpleFetchHandler({ service: 'https://public.api.bsky.app' })
		});

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const res = await client.get('app.bsky.actor.getProfile', {
			params: { actor: input.actor as any } // eslint-disable-line @typescript-eslint/no-explicit-any
		});
		if (!res.ok) error(res.status, 'Failed to load profile');
		return res.data;
	}
);

export const getPostThread = command(
	v.object({
		uri: v.string(),
		depth: v.optional(v.number()),
		parentHeight: v.optional(v.number())
	}),
	async (input) => {
		const { locals } = getRequestEvent();

		const client = locals.client ?? new Client({
			handler: simpleFetchHandler({ service: 'https://public.api.bsky.app' })
		});

		const res = await client.get('app.bsky.feed.getPostThread', {
			params: {
				uri: input.uri as ResourceUri,
				depth: input.depth ?? 10,
				parentHeight: input.parentHeight ?? 0
			}
		});
		if (!res.ok) error(res.status, 'Failed to load thread');
		return res.data;
	}
);

export const getAuthorFeed = command(
	v.object({
		actor: v.string(),
		cursor: v.optional(v.string())
	}),
	async (input) => {
		const { locals } = getRequestEvent();

		const client = locals.client ?? new Client({
			handler: simpleFetchHandler({ service: 'https://public.api.bsky.app' })
		});

		const res = await client.get('app.bsky.feed.getAuthorFeed', {
			params: {
				actor: input.actor as any, // eslint-disable-line @typescript-eslint/no-explicit-any
				limit: 30,
				...(input.cursor ? { cursor: input.cursor } : {})
			}
		});
		if (!res.ok) error(res.status, 'Failed to load author feed');
		return { posts: res.data.feed, cursor: res.data.cursor ?? null };
	}
);

export const searchPosts = command(
	v.object({
		q: v.string(),
		cursor: v.optional(v.string()),
		author: v.optional(v.string()),
		sort: v.optional(v.picklist(['top', 'latest'])),
		since: v.optional(v.string())
	}),
	async (input) => {
		const { locals } = getRequestEvent();

		const client = locals.client ?? new Client({
			handler: simpleFetchHandler({ service: 'https://public.api.bsky.app' })
		});

		const res = await client.get('app.bsky.feed.searchPosts', {
			params: {
				q: input.q,
				limit: 25,
				...(input.cursor ? { cursor: input.cursor } : {}),
				...(input.author ? { author: input.author as `did:${string}:${string}` } : {}),
				...(input.sort ? { sort: input.sort } : {}),
				...(input.since ? { since: input.since } : {})
			}
		});
		if (!res.ok) error(res.status, 'Failed to search posts');
		return { posts: res.data.posts, cursor: res.data.cursor ?? null };
	}
);

export const loadFeed = command(
	v.object({
		feedUri: v.string(),
		cursor: v.optional(v.string())
	}),
	async (input) => {
		const { locals } = getRequestEvent();

		const client = locals.client ?? new Client({
			handler: simpleFetchHandler({ service: 'https://public.api.bsky.app' })
		});

		const res = await client.get('app.bsky.feed.getFeed', {
			params: {
				feed: input.feedUri as ResourceUri,
				limit: 30,
				...(input.cursor ? { cursor: input.cursor } : {})
			}
		});
		if (!res.ok) error(res.status, 'Failed to load feed');
		return { posts: res.data.feed, cursor: res.data.cursor ?? null };
	}
);

export const createBookmark = command(
	v.object({
		uri: v.string(),
		cid: v.string()
	}),
	async (input) => {
		const { locals } = getRequestEvent();
		if (!locals.client || !locals.did) error(401, 'Not authenticated');

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const opts: any = { as: null, input: { uri: input.uri, cid: input.cid } };
		const res = await locals.client.post('app.bsky.bookmark.createBookmark' as any, opts); // eslint-disable-line @typescript-eslint/no-explicit-any
		if (!res.ok) error(res.status, 'Failed to bookmark');
		return { ok: true };
	}
);

export const deleteBookmark = command(
	v.object({
		uri: v.string()
	}),
	async (input) => {
		const { locals } = getRequestEvent();
		if (!locals.client || !locals.did) error(401, 'Not authenticated');

		try {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const opts: any = { as: null, input: { uri: input.uri } };
			await locals.client.post('app.bsky.bookmark.deleteBookmark' as any, opts); // eslint-disable-line @typescript-eslint/no-explicit-any
		} catch (e: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
			console.error('[deleteBookmark] error:', e?.status, e?.body ?? e?.message ?? e);
			error(e?.status ?? 500, 'Failed to remove bookmark');
		}
		return { ok: true };
	}
);

export const getBookmarks = command(
	v.object({
		cursor: v.optional(v.string()),
		limit: v.optional(v.number())
	}),
	async (input) => {
		const { locals } = getRequestEvent();
		if (!locals.client || !locals.did) error(401, 'Not authenticated');

		const res = await locals.client.get('app.bsky.bookmark.getBookmarks' as any, { // eslint-disable-line @typescript-eslint/no-explicit-any
			params: {
				limit: input.limit ?? 30,
				...(input.cursor ? { cursor: input.cursor } : {})
			}
		});

		if (!res.ok) error(res.status, 'Failed to load bookmarks');
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const data = res.data as any;
		// API returns [{ createdAt, subject, item: PostView }]
		const raw = data.items ?? data.bookmarks ?? [];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const posts = raw.map((entry: any) => entry.item ?? entry.post ?? entry);
		return { posts, cursor: data.cursor ?? null };
	}
);
