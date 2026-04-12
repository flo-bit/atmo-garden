// Create the one-time empty-state placeholder post that the
// `following-hot` / `following-new` bsky feed generators emit when
// the viewer follows zero atmo.garden communities.
//
// The feed generator handler prepends this post's URI to the feed
// skeleton response before falling back to the all-<sort> contents,
// so users who open a following feed with no subscriptions see:
//
//   "🌱 Follow communities on atmo.garden to personalize this feed.
//    Browse communities → https://atmo.garden"
//
// …followed by the global hot/new feed.
//
// Usage:
//   pnpm tsx scripts/create-placeholder-post.ts
//
// Prints the resulting at-uri. Paste it into wrangler.jsonc as
// `FOLLOWING_FEED_PLACEHOLDER_URI`, then deploy. This script uses
// `createRecord` (not `putRecord`) because the post needs a TID
// rkey for the bsky firehose, so re-running it will create a NEW
// post each time — run it once and keep the URI stable. To retire
// or change the placeholder, delete the old record from bsky and
// re-run the script.
//
// Requires the same env vars the discovery-list publisher + feed
// generator publisher use in src/lib/reddit/bot.ts:
//
//   ATMO_GARDEN_PDS           - e.g. https://bsky.social  (or the
//                                PDS that actually hosts the account)
//   ATMO_GARDEN_IDENTIFIER    - handle, e.g. atmo.garden
//   ATMO_GARDEN_APP_PASSWORD  - bsky app password (NOT main password)

import { readFileSync } from 'fs';

function loadEnv(path: string) {
	try {
		const text = readFileSync(path, 'utf8');
		for (const line of text.split('\n')) {
			const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
			if (!m) continue;
			let val = m[2];
			if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
			if (!process.env[m[1]]) process.env[m[1]] = val;
		}
	} catch {
		/* ignore */
	}
}
loadEnv('.env');
loadEnv('.dev.vars');

const PDS = process.env.ATMO_GARDEN_PDS;
const IDENTIFIER = process.env.ATMO_GARDEN_IDENTIFIER;
const APP_PASSWORD = process.env.ATMO_GARDEN_APP_PASSWORD;

if (!PDS || !IDENTIFIER || !APP_PASSWORD) {
	console.error(
		'Missing ATMO_GARDEN_PDS / ATMO_GARDEN_IDENTIFIER / ATMO_GARDEN_APP_PASSWORD in env'
	);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Post content + richtext facet for the https://atmo.garden link
// ---------------------------------------------------------------------------

const POST_TEXT =
	'🌱 Follow communities on atmo.garden to personalize this feed.\n\nBrowse communities → https://atmo.garden';

/** Find the UTF-8 byte range of `substring` inside `text`, or null. */
function byteRange(
	text: string,
	substring: string
): { byteStart: number; byteEnd: number } | null {
	const charIdx = text.indexOf(substring);
	if (charIdx === -1) return null;
	const encoder = new TextEncoder();
	const byteStart = encoder.encode(text.slice(0, charIdx)).byteLength;
	const byteEnd = byteStart + encoder.encode(substring).byteLength;
	return { byteStart, byteEnd };
}

const LINK_SUBSTRING = 'https://atmo.garden';
const linkRange = byteRange(POST_TEXT, LINK_SUBSTRING);
if (!linkRange) {
	console.error('internal: could not locate link substring in POST_TEXT');
	process.exit(1);
}

const facets = [
	{
		index: linkRange,
		features: [
			{
				$type: 'app.bsky.richtext.facet#link',
				uri: 'https://atmo.garden'
			}
		]
	}
];

// ---------------------------------------------------------------------------
// 1. Log in
// ---------------------------------------------------------------------------

console.log(`[1/2] createSession on ${PDS} as ${IDENTIFIER}…`);
const sessionRes = await fetch(`${PDS}/xrpc/com.atproto.server.createSession`, {
	method: 'POST',
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify({ identifier: IDENTIFIER, password: APP_PASSWORD })
});
if (!sessionRes.ok) {
	console.error(
		`       createSession failed (${sessionRes.status}):`,
		await sessionRes.text()
	);
	process.exit(1);
}
const session = (await sessionRes.json()) as { did: string; accessJwt: string };
console.log(`       did = ${session.did}`);

// ---------------------------------------------------------------------------
// 2. createRecord the placeholder post
// ---------------------------------------------------------------------------

console.log(`[2/2] createRecord app.bsky.feed.post…`);
const createRes = await fetch(`${PDS}/xrpc/com.atproto.repo.createRecord`, {
	method: 'POST',
	headers: {
		'Content-Type': 'application/json',
		Authorization: `Bearer ${session.accessJwt}`
	},
	body: JSON.stringify({
		repo: session.did,
		collection: 'app.bsky.feed.post',
		record: {
			$type: 'app.bsky.feed.post',
			text: POST_TEXT,
			facets,
			createdAt: new Date().toISOString()
		}
	})
});
if (!createRes.ok) {
	console.error(
		`       createRecord failed (${createRes.status}):`,
		await createRes.text()
	);
	process.exit(1);
}
const body = (await createRes.json()) as { uri: string; cid: string };

// ---------------------------------------------------------------------------
// 3. Report
// ---------------------------------------------------------------------------

console.log(`\n✅ Placeholder post created:\n`);
console.log(`   at-uri: ${body.uri}`);
const rkey = body.uri.split('/').pop();
console.log(`   web:    https://bsky.app/profile/${IDENTIFIER}/post/${rkey}`);
console.log(`\nPaste the at-uri into wrangler.jsonc as:`);
console.log(`   "FOLLOWING_FEED_PLACEHOLDER_URI": "${body.uri}"`);
console.log(`\nThen deploy. The following-hot / following-new feeds will`);
console.log(`prepend this post when the viewer follows zero communities.\n`);
