// Read alice's DMs via rookery's getServiceAuth endpoint.
// Uses the ES256K WelcomeMat flow.
//
// Usage: pnpm tsx scripts/read-alice-dms.ts [handle]

import { readFileSync } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';

type EcPublicJwk = { kty: 'EC'; crv: 'secp256k1'; x: string; y: string };

type AccountFile = {
	did: string;
	handle: string;
	pds: string;
	thumbprint: string;
	publicJwk: EcPublicJwk;
	secretKeyHex: string;
};

const HANDLE = process.argv[2] ?? 'alice';
const account = JSON.parse(
	readFileSync(`.rookery-accounts/${HANDLE}.json`, 'utf8')
) as AccountFile;
const secretKey = new Uint8Array(Buffer.from(account.secretKeyHex, 'hex'));
console.log(`logged-in identity: ${account.handle} (${account.did})`);

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

// --- access token (re-usable across this script run) ---
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

async function getServiceAuth(aud: string, lxm: string): Promise<string> {
	const url = `${account.pds}/xrpc/com.atproto.server.getServiceAuth?aud=${encodeURIComponent(aud)}&lxm=${encodeURIComponent(lxm)}`;
	const res = await fetch(url, {
		headers: {
			Authorization: `DPoP ${accessToken}`,
			DPoP: buildDpop('GET', url)
		}
	});
	const body = await res.text();
	if (!res.ok) throw new Error(`getServiceAuth ${res.status}: ${body}`);
	return (JSON.parse(body) as { token: string }).token;
}

function decodeJwt(jwt: string): unknown {
	const [h, p] = jwt.split('.');
	const decode = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString());
	return { header: decode(h), payload: decode(p) };
}

// --- listConvos ---
console.log('\n[1/3] getServiceAuth(aud=did:web:api.bsky.chat, lxm=chat.bsky.convo.listConvos)');
const listToken = await getServiceAuth('did:web:api.bsky.chat', 'chat.bsky.convo.listConvos');
console.log('  token:', JSON.stringify(decodeJwt(listToken), null, 2));

console.log('\n[2/3] api.bsky.chat/listConvos …');
const convosRes = await fetch(
	'https://api.bsky.chat/xrpc/chat.bsky.convo.listConvos?limit=20',
	{ headers: { Authorization: `Bearer ${listToken}` } }
);
console.log('  status:', convosRes.status);
const convosBody = await convosRes.text();
if (!convosRes.ok) {
	console.log('  body:', convosBody);
	process.exit(1);
}
type Convo = {
	id: string;
	rev: string;
	unreadCount: number;
	status?: string;
	members: Array<{ did: string; handle?: string }>;
};
const convosData = JSON.parse(convosBody) as { convos: Convo[]; cursor?: string };
console.log(`  ${convosData.convos.length} convos`);
for (const c of convosData.convos) {
	console.log(
		`  - ${c.id} status=${c.status ?? '?'} unread=${c.unreadCount} members=${c.members
			.map((m) => m.handle ?? m.did)
			.join(', ')}`
	);
}

// Also check "request" status.
const reqRes = await fetch(
	'https://api.bsky.chat/xrpc/chat.bsky.convo.listConvos?limit=20&status=request',
	{ headers: { Authorization: `Bearer ${listToken}` } }
);
if (reqRes.ok) {
	const reqData = JSON.parse(await reqRes.text()) as { convos: Convo[] };
	if (reqData.convos.length > 0) {
		console.log(`  (requests) ${reqData.convos.length} convos:`);
		for (const c of reqData.convos) {
			console.log(
				`  - ${c.id} members=${c.members.map((m) => m.handle ?? m.did).join(', ')}`
			);
		}
		convosData.convos.push(...reqData.convos);
	}
}

// --- getMessages per convo ---
console.log('\n[3/3] getMessages for each convo');
for (const convo of convosData.convos) {
	console.log(`\nconvo ${convo.id} (${convo.members.map((m) => m.handle ?? m.did).join(', ')})`);
	const mToken = await getServiceAuth('did:web:api.bsky.chat', 'chat.bsky.convo.getMessages');
	const msgRes = await fetch(
		`https://api.bsky.chat/xrpc/chat.bsky.convo.getMessages?convoId=${convo.id}&limit=20`,
		{ headers: { Authorization: `Bearer ${mToken}` } }
	);
	if (!msgRes.ok) {
		console.log('  FAILED', msgRes.status, (await msgRes.text()).slice(0, 200));
		continue;
	}
	type Msg = {
		$type?: string;
		id: string;
		rev: string;
		sender?: { did: string };
		text?: string;
		sentAt: string;
		embed?: { record?: { uri?: string } };
	};
	const { messages } = (await msgRes.json()) as { messages: Msg[] };
	console.log(`  ${messages.length} messages (newest first):`);
	for (const m of messages) {
		const embedUri = m.embed?.record?.uri;
		console.log(
			`  - [${m.rev}] sender=${m.sender?.did ?? '?'} sentAt=${m.sentAt}`
		);
		console.log(`    text: ${JSON.stringify(m.text ?? null)}`);
		if (embedUri) console.log(`    embed: ${embedUri}`);
	}
}
