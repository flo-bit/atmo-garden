// Publish (or update) the two atmo.garden-wide bsky feed generator
// records on the atmo.garden account:
//
//   - all-hot  → "atmo.garden Hot"
//   - top-day  → "atmo.garden Top of the Day"
//
// Both point at `did:web:atmo.garden` as the feed generator service
// DID, which is declared by `static/.well-known/did.json` and served
// by `src/routes/xrpc/app.bsky.feed.getFeedSkeleton/+server.ts`.
//
// Idempotent: uses `com.atproto.repo.putRecord` with fixed rkeys
// (`all-hot`, `top-day`), so re-running the script overwrites the
// existing records instead of creating duplicates.
//
// Usage:
//   pnpm tsx scripts/publish-feed-generators.ts
//
// Requires the same env vars the discovery-list publisher uses in
// `src/lib/reddit/bot.ts:addCommunityToDiscoveryList`:
//
//   ATMO_GARDEN_PDS           - e.g. https://bsky.social  (or the PDS
//                                that actually hosts the account)
//   ATMO_GARDEN_IDENTIFIER    - handle, e.g. atmo.garden
//   ATMO_GARDEN_APP_PASSWORD  - bsky app password (NOT the main one)
//
// The feed generator records themselves reference
// `did:web:atmo.garden` as the service DID, so the did.json well-known
// must also be live for the feeds to actually work in a bsky client.

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

const SERVICE_DID = 'did:web:atmo.garden';

type FeedGeneratorSpec = {
	rkey: string;
	displayName: string;
	description: string;
};

// Display names must fit within the `app.bsky.feed.generator` lexicon's
// 24-grapheme / 240-byte cap on displayName. "atmo.garden Top of the
// Day" is 26 graphemes and gets rejected — "atmo.garden Top Today" (21)
// is the shortest phrasing that still reads naturally and stays under.
// Keep each displayName ≤ 24 graphemes when adding new feeds.
const FEEDS: FeedGeneratorSpec[] = [
	{
		rkey: 'all-hot',
		displayName: 'atmo.garden Hot',
		description:
			'The hottest submissions across every atmo.garden community — ranked by how fast each post is picking up likes right now. Browse + submit at https://atmo.garden.'
	},
	{
		rkey: 'all-new',
		displayName: 'atmo.garden New',
		description:
			'The newest submissions across every atmo.garden community — a live firehose of everything freshly submitted. Browse + submit at https://atmo.garden.'
	},
	{
		rkey: 'top-day',
		displayName: 'atmo.garden Top Today',
		description:
			'The most-liked submissions from every atmo.garden community over the last 24 hours. Browse + submit at https://atmo.garden.'
	},
	{
		rkey: 'top-week',
		displayName: 'atmo.garden Top Week',
		description:
			'The most-liked submissions from every atmo.garden community over the last 7 days. Browse + submit at https://atmo.garden.'
	},
	{
		rkey: 'following-hot',
		displayName: 'atmo Following Hot',
		description:
			'Hot submissions from only the atmo.garden communities you follow on Bluesky. Follow a community account to add it to this feed. Browse + submit at https://atmo.garden.'
	},
	{
		rkey: 'following-new',
		displayName: 'atmo Following New',
		description:
			'Newest submissions from only the atmo.garden communities you follow on Bluesky. Follow a community account to add it to this feed. Browse + submit at https://atmo.garden.'
	}
];

// ---------------------------------------------------------------------------
// 1. Log in
// ---------------------------------------------------------------------------

console.log(`[1/3] createSession on ${PDS} as ${IDENTIFIER}…`);
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
// 2. putRecord each feed generator
// ---------------------------------------------------------------------------

const createdAt = new Date().toISOString();

for (let i = 0; i < FEEDS.length; i++) {
	const spec = FEEDS[i];
	console.log(`[2/3] putRecord ${spec.rkey} (${i + 1}/${FEEDS.length})…`);
	const res = await fetch(`${PDS}/xrpc/com.atproto.repo.putRecord`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${session.accessJwt}`
		},
		body: JSON.stringify({
			repo: session.did,
			collection: 'app.bsky.feed.generator',
			rkey: spec.rkey,
			record: {
				$type: 'app.bsky.feed.generator',
				did: SERVICE_DID,
				displayName: spec.displayName,
				description: spec.description,
				createdAt
			}
		})
	});
	if (!res.ok) {
		console.error(`       putRecord ${spec.rkey} failed (${res.status}):`, await res.text());
		process.exit(1);
	}
	const body = (await res.json()) as { uri: string; cid: string };
	console.log(`       ${body.uri}`);
}

// ---------------------------------------------------------------------------
// 3. Report subscribe links
// ---------------------------------------------------------------------------

console.log(`\n[3/3] ✅ Published. Users can subscribe via these links:\n`);
for (const spec of FEEDS) {
	const atUri = `at://${session.did}/app.bsky.feed.generator/${spec.rkey}`;
	// Convert at:// → https://bsky.app/profile/<handle>/feed/<rkey>
	// The handle form is nicer than the did form in URLs; bsky resolves
	// handles in profile paths just fine.
	const webUrl = `https://bsky.app/profile/${IDENTIFIER}/feed/${spec.rkey}`;
	console.log(`  ${spec.displayName}`);
	console.log(`    at-uri:  ${atUri}`);
	console.log(`    web:     ${webUrl}`);
}
console.log();
