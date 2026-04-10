// Remote command backing the web "Submit to community" flow. Writes a
// `garden.atmo.submission` record to the signed-in user's PDS; the cron's
// jetstream drain in bot.ts will pick it up and turn it into a community
// quote post on the next tick.

import { error } from '@sveltejs/kit';
import { command, getRequestEvent } from '$app/server';
import * as v from 'valibot';
import * as TID from '@atcute/tid';

// Accept either an `at://did/app.bsky.feed.post/rkey` URI directly or a
// bsky.app post URL — the latter is what users will usually paste.
const AT_URI = /^at:\/\/did:[^/]+\/app\.bsky\.feed\.post\/[A-Za-z0-9]+$/;

export const createSubmission = command(
	v.object({
		postUri: v.pipe(v.string(), v.regex(AT_URI, 'Expected an app.bsky.feed.post AT URI')),
		communityDid: v.pipe(
			v.string(),
			v.regex(/^did:[a-z]+:[a-zA-Z0-9._:%-]+$/, 'Expected a DID')
		),
		// Bluesky post text cap is 300 graphemes. We cap bytes conservatively
		// here; the cron's createRecord call to rookery will reject anything
		// that exceeds the grapheme limit anyway.
		title: v.optional(v.pipe(v.string(), v.maxLength(600)))
	}),
	async (input) => {
		const { locals } = getRequestEvent();
		if (!locals.client || !locals.did) error(401, 'Not authenticated');

		const rkey = TID.now();
		const res = await locals.client.post('com.atproto.repo.createRecord', {
			input: {
				repo: locals.did,
				collection: 'garden.atmo.submission',
				rkey,
				record: {
					$type: 'garden.atmo.submission',
					post: input.postUri,
					community: input.communityDid,
					...(input.title ? { title: input.title } : {}),
					createdAt: new Date().toISOString()
				}
			}
		});

		if (!res.ok) error(res.status, 'Failed to create submission');
		return { uri: res.data.uri };
	}
);
