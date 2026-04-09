// AES-GCM password encryption for stored community app passwords.
// Uses Web Crypto (native in Workers + modern Node).
//
// The key is derived from the COMMUNITY_ENCRYPTION_KEY env var with SHA-256 so
// any string length works. Ciphertext + IV are both base64url-encoded.

async function deriveKey(secret: string): Promise<CryptoKey> {
	const bytes = new TextEncoder().encode(secret);
	// Copy into a fresh ArrayBuffer so the strict lib.dom BufferSource
	// type checks (Uint8Array<ArrayBufferLike> → ArrayBuffer).
	const buf = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buf).set(bytes);
	const hash = await crypto.subtle.digest('SHA-256', buf);
	return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, [
		'encrypt',
		'decrypt'
	]);
}

function toB64Url(bytes: Uint8Array): string {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64Url(str: string): Uint8Array {
	const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
	const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
	const bin = atob(padded);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
	const buf = new ArrayBuffer(u8.byteLength);
	new Uint8Array(buf).set(u8);
	return buf;
}

export async function encryptPassword(
	plaintext: string,
	secret: string
): Promise<{ ciphertext: string; iv: string }> {
	const key = await deriveKey(secret);
	const ivBytes = crypto.getRandomValues(new Uint8Array(12));
	const ivBuf = toArrayBuffer(ivBytes);
	const encoded = toArrayBuffer(new TextEncoder().encode(plaintext));
	const ct = new Uint8Array(
		await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivBuf }, key, encoded)
	);
	return { ciphertext: toB64Url(ct), iv: toB64Url(ivBytes) };
}

export async function decryptPassword(
	ciphertext: string,
	iv: string,
	secret: string
): Promise<string> {
	const key = await deriveKey(secret);
	const pt = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: toArrayBuffer(fromB64Url(iv)) },
		key,
		toArrayBuffer(fromB64Url(ciphertext))
	);
	return new TextDecoder().decode(pt);
}
