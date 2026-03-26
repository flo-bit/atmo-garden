import { error } from '@sveltejs/kit';
import { command, getRequestEvent } from '$app/server';
import * as v from 'valibot';
import type { ResourceUri } from '@atcute/lexicons';
import { Client, simpleFetchHandler } from '@atcute/client';
import * as TID from '@atcute/tid';

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

export const createRsvp = command(
	v.object({
		eventUri: v.string(),
		eventCid: v.string(),
		status: v.optional(v.string())
	}),
	async (input) => {
		const { locals } = getRequestEvent();
		if (!locals.client || !locals.did) error(401, 'Not authenticated');

		const rkey = TID.now();
		const res = await locals.client.post('com.atproto.repo.createRecord', {
			input: {
				repo: locals.did,
				collection: 'community.lexicon.calendar.rsvp',
				rkey,
				record: {
					$type: 'community.lexicon.calendar.rsvp',
					status: input.status ?? 'community.lexicon.calendar.rsvp#going',
					subject: { uri: input.eventUri, cid: input.eventCid },
					createdAt: new Date().toISOString()
				}
			}
		});

		if (!res.ok) error(res.status, 'Failed to RSVP');
		return { uri: res.data.uri };
	}
);

export const deleteRsvp = command(
	v.object({
		rsvpUri: v.string()
	}),
	async (input) => {
		const { locals } = getRequestEvent();
		if (!locals.client || !locals.did) error(401, 'Not authenticated');

		const parts = input.rsvpUri.split('/');
		const rkey = parts[parts.length - 1];

		const res = await locals.client.post('com.atproto.repo.deleteRecord', {
			input: {
				repo: locals.did,
				collection: 'community.lexicon.calendar.rsvp',
				rkey
			}
		});

		if (!res.ok) error(res.status, 'Failed to cancel RSVP');
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
		cursor: v.optional(v.string())
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
				...(input.cursor ? { cursor: input.cursor } : {})
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
