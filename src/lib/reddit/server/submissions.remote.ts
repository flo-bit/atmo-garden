// Remote command backing the web "Submit to community" flow. Writes a
// `garden.atmo.submission` record to the signed-in user's PDS; the cron's
// jetstream drain in bot.ts will pick it up and turn it into a community
// quote post on the next tick.

import { error } from '@sveltejs/kit';
import { command, getRequestEvent } from '$app/server';
import * as v from 'valibot';
import * as TID from '@atcute/tid';
import type { Did, Handle, ResourceUri } from '@atcute/lexicons';
import { resolveHandle } from '$lib/atproto/methods';
import { processWebSubmission } from '../bot';

// Accept either an `at://did/app.bsky.feed.post/rkey` URI directly or a
// bsky.app post URL — the latter is what users will usually paste.
const AT_URI = /^at:\/\/(did:[^/]+)\/app\.bsky\.feed\.post\/([A-Za-z0-9]+)$/;
const BSKY_URL = /^https?:\/\/bsky\.app\/profile\/([^/\s]+)\/post\/([A-Za-z0-9]+)$/i;

/**
 * Normalize a user-pasted post reference (either at-URI or bsky.app URL)
 * into a canonical `at://did/app.bsky.feed.post/rkey`. Resolves the handle
 * via DoH/slingshot when the URL uses a handle instead of a DID.
 *
 * Returns null when the input can't be parsed as a Bluesky post reference.
 */
async function normalizePostRef(ref: string): Promise<string | null> {
	const trimmed = ref.trim();

	const atMatch = trimmed.match(AT_URI);
	if (atMatch) return trimmed;

	const urlMatch = trimmed.match(BSKY_URL);
	if (!urlMatch) return null;

	const handleOrDid = urlMatch[1];
	const rkey = urlMatch[2];

	let did: string;
	if (handleOrDid.startsWith('did:')) {
		did = handleOrDid;
	} else {
		try {
			did = await resolveHandle({ handle: handleOrDid as Handle });
		} catch {
			return null;
		}
	}

	return `at://${did}/app.bsky.feed.post/${rkey}`;
}

export const createSubmission = command(
	v.object({
		// Accepts either an at-URI or a bsky.app post URL; normalized server-side.
		postRef: v.pipe(v.string(), v.minLength(1), v.maxLength(1024)),
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
		const { platform, locals } = getRequestEvent();
		if (!locals.client || !locals.did) error(401, 'Not authenticated');

		const postUri = await normalizePostRef(input.postRef);
		if (!postUri) {
			error(
				400,
				"Couldn't parse that as a Bluesky post. Paste a bsky.app URL or an at:// URI."
			);
		}

		const rkey = TID.now();
		const res = await locals.client.post('com.atproto.repo.createRecord', {
			input: {
				repo: locals.did,
				collection: 'garden.atmo.submission',
				rkey,
				record: {
					$type: 'garden.atmo.submission',
					post: postUri,
					community: input.communityDid,
					...(input.title ? { title: input.title } : {}),
					createdAt: new Date().toISOString()
				}
			}
		});

		if (!res.ok) error(res.status, 'Failed to create submission');

		// Synchronously turn the submission into a community quote post so the
		// user doesn't have to wait for the jetstream cron. The drain in
		// bot.ts is still the canonical path (and handles submissions from
		// other clients) — this is a best-effort fast path. Dedup in
		// processWebSubmission keeps the two paths idempotent.
		const env = platform?.env;
		let processed = false;
		let reason: string | undefined;
		if (env?.DB) {
			try {
				const result = await processWebSubmission(env, env.DB, {
					communityDid: input.communityDid,
					postUri: postUri as ResourceUri,
					title: input.title?.trim() ?? '',
					submitterDid: locals.did as Did
				});
				processed = result.ok;
				if (!result.ok) reason = result.reason;
			} catch (e) {
				console.error('[createSubmission] immediate processing failed', e);
			}
		}

		return { uri: res.data.uri, processed, reason };
	}
);
