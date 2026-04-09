// Batch-fetch PostView data for a list of URIs so the RedditPostCard can
// render a proper quoted post with author, text, images, etc.

import { command, getRequestEvent } from '$app/server';
import { Client, simpleFetchHandler } from '@atcute/client';
import type { ResourceUri } from '@atcute/lexicons';
import * as v from 'valibot';

export const getQuotedPosts = command(
	v.object({
		uris: v.array(v.string())
	}),
	async (input) => {
		const { locals } = getRequestEvent();

		// Prefer the authenticated client when available (gives viewer state),
		// fall back to the unauthenticated public appview.
		const client =
			locals.client ??
			new Client({
				handler: simpleFetchHandler({ service: 'https://public.api.bsky.app' })
			});

		// getPosts caps at 25 URIs per call. Chunk requests.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const out: Record<string, any> = {};
		for (let i = 0; i < input.uris.length; i += 25) {
			const batch = input.uris.slice(i, i + 25) as ResourceUri[];
			try {
				const res = await client.get('app.bsky.feed.getPosts', {
					params: { uris: batch }
				});
				if (res.ok) {
					for (const p of res.data.posts) {
						out[p.uri] = p;
					}
				}
			} catch (e) {
				console.error('[getQuotedPosts] batch failed', e);
			}
		}

		return { posts: out };
	}
);
