// One-off: delete a post by rkey from the main bot account.
// Usage: pnpm tsx scripts/delete-post.ts <rkey>

import { readFileSync } from 'fs';
import { CredentialManager, Client } from '@atcute/client';

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

const rkey = process.argv[2];
if (!rkey) {
	console.error('Usage: pnpm tsx scripts/delete-post.ts <rkey>');
	process.exit(1);
}

const didRes = await fetch(
	`https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${process.env.BSKY_HANDLE}`
);
const { did } = (await didRes.json()) as { did: string };

const plc = await fetch(`https://plc.directory/${did}`);
const doc = (await plc.json()) as { service?: { id: string; serviceEndpoint: string }[] };
const pds = doc.service?.find((s) => s.id === '#atproto_pds')?.serviceEndpoint;
if (!pds) throw new Error('No PDS');

const manager = new CredentialManager({ service: pds });
await manager.login({ identifier: process.env.BSKY_HANDLE!, password: process.env.BSKY_PASSWORD! });
const client = new Client({ handler: manager });

const res = await client.post('com.atproto.repo.deleteRecord', {
	input: {
		repo: did as `did:${string}:${string}`,
		collection: 'app.bsky.feed.post',
		rkey
	}
});

console.log(res.ok ? `deleted ${rkey}` : `failed: ${JSON.stringify(res.data)}`);
