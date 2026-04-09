// Write an app.bsky.feed.post record to alice's rookery repo using ES256K.
//
// Usage: pnpm tsx scripts/post-as-alice.ts "some post text"

import { readFileSync } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import * as TID from '@atcute/tid';

type EcPublicJwk = { kty: 'EC'; crv: 'secp256k1'; x: string; y: string };
type AccountFile = {
	did: string;
	handle: string;
	pds: string;
	thumbprint: string;
	publicJwk: EcPublicJwk;
	secretKeyHex: string;
};

const text = process.argv.slice(2).join(' ') || 'hello from alice via rookery';
const account = JSON.parse(
	readFileSync('.rookery-accounts/alice.json', 'utf8')
) as AccountFile;
const secretKey = new Uint8Array(Buffer.from(account.secretKeyHex, 'hex'));
console.log(`posting as ${account.handle} (${account.did})`);
console.log(`text: ${JSON.stringify(text)}`);

// --- helpers ---
function b64url(input: Uint8Array): string {
	return Buffer.from(input).toString('base64url');
}
function sha256b64url(input: string): string {
	return Buffer.from(createHash('sha256').update(input).digest()).toString('base64url');
}
function signEs256k(secretKey: Uint8Array, message: string | Uint8Array): Uint8Array {
	const msgBytes =
		typeof message === 'string' ? new TextEncoder().encode(message) : message;
	const sig = secp256k1.sign(msgBytes, secretKey);
	if (sig.length !== 64) throw new Error(`bad sig length ${sig.length}`);
	return sig;
}
function signJwt(
	header: Record<string, unknown>,
	payload: Record<string, unknown>,
	secretKey: Uint8Array
): string {
	const signingInput = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
	const sig = signEs256k(secretKey, signingInput);
	return `${signingInput}.${b64url(sig)}`;
}

// --- access token ---
const tosText = await fetch(`${account.pds}/tos`).then((r) => r.text());
const accessToken = signJwt(
	{ typ: 'wm+jwt', alg: 'ES256K' },
	{
		tos_hash: sha256b64url(tosText),
		aud: account.pds,
		cnf: { jkt: account.thumbprint },
		iat: Math.floor(Date.now() / 1000)
	},
	secretKey
);

function buildDpop(method: string, url: string): string {
	const u = new URL(url);
	return signJwt(
		{ typ: 'dpop+jwt', alg: 'ES256K', jwk: account.publicJwk },
		{
			jti: randomUUID(),
			htm: method,
			htu: u.origin + u.pathname,
			iat: Math.floor(Date.now() / 1000),
			ath: sha256b64url(accessToken)
		},
		secretKey
	);
}

// --- createRecord ---
const url = `${account.pds}/xrpc/com.atproto.repo.createRecord`;
const res = await fetch(url, {
	method: 'POST',
	headers: {
		Authorization: `DPoP ${accessToken}`,
		DPoP: buildDpop('POST', url),
		'Content-Type': 'application/json'
	},
	body: JSON.stringify({
		repo: account.did,
		collection: 'app.bsky.feed.post',
		rkey: TID.now(),
		record: {
			$type: 'app.bsky.feed.post',
			text,
			createdAt: new Date().toISOString()
		}
	})
});

const body = await res.text();
console.log('\nstatus:', res.status);
console.log('body:', body);
if (res.ok) {
	const data = JSON.parse(body) as { uri: string; cid: string };
	const rkey = data.uri.split('/').pop();
	console.log(`\n✅ posted`);
	console.log(`   ${data.uri}`);
	console.log(`   https://bsky.app/profile/${account.handle}/post/${rkey}`);
}
