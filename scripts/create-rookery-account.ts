// Create a rookery account via the full WelcomeMat signup flow (ES256K):
//   1. Generate a secp256k1 keypair
//   2. Fetch ToS, sign it (raw 64-byte compact ES256K signature)
//   3. Build a self-signed wm+jwt access token
//   4. Build a DPoP proof
//   5. POST /api/signup with X-Rookery-Signup-Secret header
//
// Usage:
//   pnpm tsx scripts/create-rookery-account.ts <handle>
//
// The private key (hex-encoded 32 bytes) is written to
// .rookery-accounts/<handle>.json so we can use it to auth as that account
// later. DO NOT commit that directory.

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';

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

const PDS_HOSTNAME = process.env.ROOKERY_HOSTNAME ?? 'pds.atmo.garden';
// HANDLE_DOMAIN is enforced server-side; informational here.
void process.env.ROOKERY_HANDLE_DOMAIN;
const SIGNUP_SECRET = process.env.ROOKERY_SIGNUP_SECRET;

if (!SIGNUP_SECRET) {
	console.error('Missing ROOKERY_SIGNUP_SECRET in .env / .dev.vars');
	process.exit(1);
}

const shortHandle = process.argv[2];
if (!shortHandle) {
	console.error('Usage: pnpm tsx scripts/create-rookery-account.ts <handle>');
	process.exit(1);
}
if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(shortHandle)) {
	console.error('Handle must be [a-z0-9-], single label');
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function b64url(input: Uint8Array): string {
	return Buffer.from(input).toString('base64url');
}

function b64urlStr(s: string): string {
	return Buffer.from(s).toString('base64url');
}

function sha256b64url(input: string | Uint8Array): string {
	return Buffer.from(createHash('sha256').update(input).digest()).toString('base64url');
}

type EcPublicJwk = { kty: 'EC'; crv: 'secp256k1'; x: string; y: string };

function buildPublicJwk(secretKey: Uint8Array): EcPublicJwk {
	const pubUncompressed = secp256k1.getPublicKey(secretKey, false); // 65 bytes
	const x = pubUncompressed.slice(1, 33);
	const y = pubUncompressed.slice(33, 65);
	return {
		kty: 'EC',
		crv: 'secp256k1',
		x: b64url(x),
		y: b64url(y)
	};
}

function computeThumbprint(jwk: EcPublicJwk): string {
	// RFC 7638 canonical form for EC keys: {crv, kty, x, y} in order.
	return sha256b64url(
		JSON.stringify({ crv: jwk.crv, kty: 'EC', x: jwk.x, y: jwk.y })
	);
}

function signEs256k(secretKey: Uint8Array, message: Uint8Array | string): Uint8Array {
	const msgBytes =
		typeof message === 'string' ? new TextEncoder().encode(message) : message;
	// noble 2.x prehashes with sha256 by default → signature is over sha256(msg),
	// matching rookery's validateDpopProof / verifyEs256kMessageSignature.
	const sig = secp256k1.sign(msgBytes, secretKey);
	// noble 2.x returns Uint8Array of 64 bytes (compact r||s) by default.
	if (sig.length !== 64) {
		throw new Error(`unexpected signature length: ${sig.length}`);
	}
	return sig;
}

function signJwt(
	header: Record<string, unknown>,
	payload: Record<string, unknown>,
	secretKey: Uint8Array
): string {
	const signingInput = `${b64urlStr(JSON.stringify(header))}.${b64urlStr(JSON.stringify(payload))}`;
	const sig = signEs256k(secretKey, signingInput);
	return `${signingInput}.${b64url(sig)}`;
}

// ---------------------------------------------------------------------------
// 1. Keypair
// ---------------------------------------------------------------------------

console.log(`[1/5] Generating secp256k1 keypair…`);
const secretKey = secp256k1.utils.randomSecretKey();
const publicJwk = buildPublicJwk(secretKey);
const thumbprint = computeThumbprint(publicJwk);
console.log(`       thumbprint = ${thumbprint}`);

// ---------------------------------------------------------------------------
// 2 + 3. ToS + access token
// ---------------------------------------------------------------------------

console.log(`[2/5] Fetching and signing ToS…`);
const tosText = await fetch(`https://${PDS_HOSTNAME}/tos`).then((r) => r.text());
const tosHash = sha256b64url(tosText);
const tosSignature = b64url(signEs256k(secretKey, tosText));

const accessToken = signJwt(
	{ typ: 'wm+jwt', alg: 'ES256K' },
	{
		tos_hash: tosHash,
		aud: `https://${PDS_HOSTNAME}`,
		cnf: { jkt: thumbprint },
		iat: Math.floor(Date.now() / 1000)
	},
	secretKey
);

// ---------------------------------------------------------------------------
// 4. DPoP proof for signup
// ---------------------------------------------------------------------------

console.log(`[3/5] Building DPoP proof…`);
const signupUrl = `https://${PDS_HOSTNAME}/api/signup`;
const signupHtu = (() => {
	const u = new URL(signupUrl);
	return u.origin + u.pathname;
})();
const dpopProof = signJwt(
	{ typ: 'dpop+jwt', alg: 'ES256K', jwk: publicJwk },
	{
		jti: randomUUID(),
		htm: 'POST',
		htu: signupHtu,
		iat: Math.floor(Date.now() / 1000)
	},
	secretKey
);

// ---------------------------------------------------------------------------
// 5. POST /api/signup
// ---------------------------------------------------------------------------

console.log(`[4/5] POST ${signupUrl} (handle=${shortHandle})…`);
const res = await fetch(signupUrl, {
	method: 'POST',
	headers: {
		'Content-Type': 'application/json',
		DPoP: dpopProof,
		'X-Rookery-Signup-Secret': SIGNUP_SECRET
	},
	body: JSON.stringify({
		handle: shortHandle,
		tos_signature: tosSignature,
		access_token: accessToken
	})
});

const body = (await res.json()) as {
	did?: string;
	handle?: string;
	access_token?: string;
	token_type?: string;
	error?: string;
	message?: string;
};

if (!res.ok || !body.did) {
	console.error(`       FAILED ${res.status}:`, body);
	process.exit(1);
}

console.log(`       did = ${body.did}`);
console.log(`       handle = ${body.handle}`);

// ---------------------------------------------------------------------------
// 6. Save the key material
// ---------------------------------------------------------------------------

console.log(`[5/5] Saving key material…`);
try {
	mkdirSync('.rookery-accounts', { recursive: true });
} catch {
	/* exists */
}

const record = {
	did: body.did,
	handle: body.handle,
	pds: `https://${PDS_HOSTNAME}`,
	thumbprint,
	publicJwk,
	secretKeyHex: Buffer.from(secretKey).toString('hex'),
	createdAt: new Date().toISOString()
};
writeFileSync(`.rookery-accounts/${shortHandle}.json`, JSON.stringify(record, null, 2));
console.log(`       wrote .rookery-accounts/${shortHandle}.json`);

console.log(`\n✅ Account ready: @${body.handle} (${body.did})`);
