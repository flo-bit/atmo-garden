// WelcomeMat client for rookery — Workers-compatible.
//
// Uses @noble/curves for ES256K and Web APIs (crypto.subtle / crypto.randomUUID
// / TextEncoder) so it runs in both the Cloudflare Workers runtime and Node.
//
// What this module provides:
//
//   - createRookeryAccount(): signs up a new rookery account via /api/signup
//   - WelcomeMatClient: holds a signing key + thumbprint for an existing
//     account and exposes high-level operations:
//       - signDpop(method, url, accessToken) → DPoP proof JWT
//       - buildAccessToken(tosText) → wm+jwt access token (cached)
//       - getServiceAuth(aud, lxm) → service-auth JWT from rookery
//       - createRecord(collection, record, rkey?) → via rookery DPoP
//       - deleteRecord(collection, rkey) → via rookery DPoP
//
// The client does NOT know how to refresh the ToS / access token — if the ToS
// changes, construct a new client.

import { secp256k1 } from '@noble/curves/secp256k1.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EcPublicJwk = {
	kty: 'EC';
	crv: 'secp256k1';
	x: string;
	y: string;
};

export type RookeryAccount = {
	did: string;
	handle: string;
	pds: string;
	thumbprint: string;
	publicJwk: EcPublicJwk;
	/** 32-byte secp256k1 secret key as a hex string */
	secretKeyHex: string;
};

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

function b64url(input: Uint8Array | ArrayBuffer): string {
	const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
	let bin = '';
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlString(s: string): string {
	return b64url(new TextEncoder().encode(s));
}

async function sha256b64url(input: string | Uint8Array): Promise<string> {
	const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
	// Copy into a fresh ArrayBuffer so lib.dom BufferSource type checks.
	const buf = new ArrayBuffer(data.byteLength);
	new Uint8Array(buf).set(data);
	const hash = await crypto.subtle.digest('SHA-256', buf);
	return b64url(hash);
}

function hexToBytes(hex: string): Uint8Array {
	if (hex.length % 2 !== 0) throw new Error('hex string has odd length');
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
}

function bytesToHex(bytes: Uint8Array): string {
	let s = '';
	for (let i = 0; i < bytes.length; i++) {
		s += bytes[i].toString(16).padStart(2, '0');
	}
	return s;
}

// noble 2.x sign() prehashes with sha256 by default; that matches what rookery
// verifies against (sha256 of the signing input).
function signEs256k(secretKey: Uint8Array, message: Uint8Array | string): Uint8Array {
	const msgBytes =
		typeof message === 'string' ? new TextEncoder().encode(message) : message;
	const sig = secp256k1.sign(msgBytes, secretKey);
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
	const signingInput = `${b64urlString(JSON.stringify(header))}.${b64urlString(JSON.stringify(payload))}`;
	const sig = signEs256k(secretKey, signingInput);
	return `${signingInput}.${b64url(sig)}`;
}

function buildPublicJwk(secretKey: Uint8Array): EcPublicJwk {
	const pub = secp256k1.getPublicKey(secretKey, false); // uncompressed (0x04 || x || y)
	return {
		kty: 'EC',
		crv: 'secp256k1',
		x: b64url(pub.slice(1, 33)),
		y: b64url(pub.slice(33, 65))
	};
}

async function computeThumbprint(jwk: EcPublicJwk): Promise<string> {
	// RFC 7638 canonical form for EC keys.
	return sha256b64url(
		JSON.stringify({ crv: jwk.crv, kty: 'EC', x: jwk.x, y: jwk.y })
	);
}

function normalizeHtu(url: string): string {
	const u = new URL(url);
	return u.origin + u.pathname;
}

/**
 * Fetch a record directly from the PDS via the public
 * `com.atproto.repo.getRecord` endpoint. Does not require auth.
 */
export async function getRecord(
	pds: string,
	repo: string,
	collection: string,
	rkey: string
): Promise<{ uri: string; cid: string; value: Record<string, unknown> } | null> {
	const url = new URL(`${pds}/xrpc/com.atproto.repo.getRecord`);
	url.searchParams.set('repo', repo);
	url.searchParams.set('collection', collection);
	url.searchParams.set('rkey', rkey);
	const res = await fetch(url);
	if (!res.ok) return null;
	return (await res.json()) as {
		uri: string;
		cid: string;
		value: Record<string, unknown>;
	};
}

// ---------------------------------------------------------------------------
// Signup
// ---------------------------------------------------------------------------

export type CreateAccountOptions = {
	/** The rookery host, e.g. "pds.atmo.garden" */
	hostname: string;
	/** Single-label handle — rookery appends the configured handle domain. */
	handle: string;
	/** Shared admin secret gated on rookery's /api/signup handler. */
	signupSecret: string;
};

export type CreateAccountResult = {
	account: RookeryAccount;
};

/**
 * Generate a fresh secp256k1 keypair and enroll it as a new rookery account
 * via the WelcomeMat signup flow. Returns the full account object including
 * the secret key hex (to be encrypted and stored by the caller).
 */
export async function createRookeryAccount(
	opts: CreateAccountOptions
): Promise<CreateAccountResult> {
	const secretKey = secp256k1.utils.randomSecretKey();
	const publicJwk = buildPublicJwk(secretKey);
	const thumbprint = await computeThumbprint(publicJwk);

	const pds = `https://${opts.hostname}`;

	const tosText = await fetch(`${pds}/tos`).then((r) => r.text());
	const tosHash = await sha256b64url(tosText);
	const tosSignature = b64url(signEs256k(secretKey, tosText));

	const accessToken = signJwt(
		{ typ: 'wm+jwt', alg: 'ES256K' },
		{
			tos_hash: tosHash,
			aud: pds,
			cnf: { jkt: thumbprint },
			iat: Math.floor(Date.now() / 1000)
		},
		secretKey
	);

	const signupUrl = `${pds}/api/signup`;
	const dpopProof = signJwt(
		{ typ: 'dpop+jwt', alg: 'ES256K', jwk: publicJwk },
		{
			jti: crypto.randomUUID(),
			htm: 'POST',
			htu: normalizeHtu(signupUrl),
			iat: Math.floor(Date.now() / 1000)
		},
		secretKey
	);

	const res = await fetch(signupUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			DPoP: dpopProof,
			'X-Rookery-Signup-Secret': opts.signupSecret
		},
		body: JSON.stringify({
			handle: opts.handle,
			tos_signature: tosSignature,
			access_token: accessToken
		})
	});

	const body = (await res.json()) as {
		did?: string;
		handle?: string;
		error?: string;
		message?: string;
	};
	if (!res.ok || !body.did || !body.handle) {
		const reason = body.error || body.message || `status ${res.status}`;
		throw new Error(`rookery signup failed: ${reason}`);
	}

	return {
		account: {
			did: body.did,
			handle: body.handle,
			pds,
			thumbprint,
			publicJwk,
			secretKeyHex: bytesToHex(secretKey)
		}
	};
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * High-level client for operating as an already-enrolled rookery account.
 *
 * Construct from a stored RookeryAccount via `WelcomeMatClient.forAccount()`.
 * The client lazily fetches the ToS once and caches the resulting access
 * token for its lifetime — since access tokens have no explicit expiry and
 * rookery only rejects them on ToS change, one access token per cron tick
 * is typically enough.
 */
export class WelcomeMatClient {
	readonly account: RookeryAccount;
	private secretKey: Uint8Array;
	private accessTokenCache: { token: string; tosHash: string } | null = null;

	private constructor(account: RookeryAccount) {
		this.account = account;
		this.secretKey = hexToBytes(account.secretKeyHex);
	}

	static forAccount(account: RookeryAccount): WelcomeMatClient {
		return new WelcomeMatClient(account);
	}

	/**
	 * Fetch the current ToS from the PDS and build (or reuse) a wm+jwt access
	 * token. The token is cached in memory until the ToS hash changes.
	 */
	private async ensureAccessToken(): Promise<string> {
		const tosText = await fetch(`${this.account.pds}/tos`).then((r) => r.text());
		const tosHash = await sha256b64url(tosText);
		if (this.accessTokenCache && this.accessTokenCache.tosHash === tosHash) {
			return this.accessTokenCache.token;
		}
		const token = signJwt(
			{ typ: 'wm+jwt', alg: 'ES256K' },
			{
				tos_hash: tosHash,
				aud: this.account.pds,
				cnf: { jkt: this.account.thumbprint },
				iat: Math.floor(Date.now() / 1000)
			},
			this.secretKey
		);
		this.accessTokenCache = { token, tosHash };
		return token;
	}

	/**
	 * Build a DPoP proof JWT bound to the current access token. This is the
	 * correct one to use for any authenticated rookery call.
	 */
	async buildDpopProof(method: string, url: string): Promise<{
		accessToken: string;
		dpopProof: string;
	}> {
		const accessToken = await this.ensureAccessToken();
		const ath = await sha256b64url(accessToken);
		const dpopProof = signJwt(
			{ typ: 'dpop+jwt', alg: 'ES256K', jwk: this.account.publicJwk },
			{
				jti: crypto.randomUUID(),
				htm: method,
				htu: normalizeHtu(url),
				iat: Math.floor(Date.now() / 1000),
				ath
			},
			this.secretKey
		);
		return { accessToken, dpopProof };
	}

	private async dpopRequest(
		method: 'GET' | 'POST',
		url: string,
		body?: unknown
	): Promise<Response> {
		const { accessToken, dpopProof } = await this.buildDpopProof(method, url);
		const init: RequestInit = {
			method,
			headers: {
				Authorization: `DPoP ${accessToken}`,
				DPoP: dpopProof,
				...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
			},
			...(body !== undefined ? { body: JSON.stringify(body) } : {})
		};
		return fetch(url, init);
	}

	/**
	 * Ask rookery to issue a service-auth JWT scoped to the given aud / lxm.
	 * This is what gets sent to third-party atproto services like api.bsky.chat.
	 */
	async getServiceAuth(aud: string, lxm: string, expSeconds = 60): Promise<string> {
		const url = `${this.account.pds}/xrpc/com.atproto.server.getServiceAuth?aud=${encodeURIComponent(aud)}&lxm=${encodeURIComponent(lxm)}&exp=${expSeconds}`;
		const res = await this.dpopRequest('GET', url);
		if (!res.ok) {
			throw new Error(
				`getServiceAuth failed (${res.status}): ${await res.text()}`
			);
		}
		const body = (await res.json()) as { token: string };
		return body.token;
	}

	/**
	 * createRecord via rookery's DPoP-auth'd endpoint. The rkey is optional —
	 * rookery generates a TID if omitted, which is compatible with Bluesky.
	 */
	async createRecord(
		collection: string,
		record: Record<string, unknown>,
		rkey?: string
	): Promise<{ uri: string; cid: string }> {
		const url = `${this.account.pds}/xrpc/com.atproto.repo.createRecord`;
		const res = await this.dpopRequest('POST', url, {
			repo: this.account.did,
			collection,
			...(rkey ? { rkey } : {}),
			record
		});
		if (!res.ok) {
			throw new Error(`createRecord failed (${res.status}): ${await res.text()}`);
		}
		return (await res.json()) as { uri: string; cid: string };
	}

	/**
	 * Upload a blob to the PDS via DPoP. Returns the blob ref that can be
	 * embedded in records (e.g. `app.bsky.actor.profile.avatar`).
	 */
	async uploadBlob(
		bytes: Uint8Array,
		mimeType: string
	): Promise<{
		$type: 'blob';
		ref: { $link: string };
		mimeType: string;
		size: number;
	}> {
		const url = `${this.account.pds}/xrpc/com.atproto.repo.uploadBlob`;
		const { accessToken, dpopProof } = await this.buildDpopProof('POST', url);
		// Copy into a fresh ArrayBuffer so the fetch body type check is happy
		// even when `bytes` is a view over a shared buffer.
		const body = new ArrayBuffer(bytes.byteLength);
		new Uint8Array(body).set(bytes);
		const res = await fetch(url, {
			method: 'POST',
			headers: {
				Authorization: `DPoP ${accessToken}`,
				DPoP: dpopProof,
				'Content-Type': mimeType
			},
			body
		});
		if (!res.ok) {
			throw new Error(`uploadBlob failed (${res.status}): ${await res.text()}`);
		}
		const json = (await res.json()) as { blob: unknown };
		return json.blob as {
			$type: 'blob';
			ref: { $link: string };
			mimeType: string;
			size: number;
		};
	}

	/**
	 * putRecord via rookery's DPoP-auth'd endpoint. Replaces the record at
	 * (repo, collection, rkey) with `record`. Upsert semantics: creates the
	 * record if it doesn't exist.
	 */
	async putRecord(
		collection: string,
		rkey: string,
		record: Record<string, unknown>
	): Promise<{ uri: string; cid: string }> {
		const url = `${this.account.pds}/xrpc/com.atproto.repo.putRecord`;
		const res = await this.dpopRequest('POST', url, {
			repo: this.account.did,
			collection,
			rkey,
			record
		});
		if (!res.ok) {
			throw new Error(`putRecord failed (${res.status}): ${await res.text()}`);
		}
		return (await res.json()) as { uri: string; cid: string };
	}

	async deleteRecord(collection: string, rkey: string): Promise<void> {
		const url = `${this.account.pds}/xrpc/com.atproto.repo.deleteRecord`;
		const res = await this.dpopRequest('POST', url, {
			repo: this.account.did,
			collection,
			rkey
		});
		if (!res.ok) {
			throw new Error(`deleteRecord failed (${res.status}): ${await res.text()}`);
		}
	}
}

