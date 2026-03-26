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
