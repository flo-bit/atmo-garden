// Standalone diagnostic: logs in as the BSKY_HANDLE account and dumps
// all conversations + their latest messages so we can see what DMs exist
// and why they're not being picked up by the bot.
//
// Run: pnpm tsx scripts/debug-dms.ts

import { readFileSync } from 'fs';
import { Client, CredentialManager } from '@atcute/client';
import type { Did } from '@atcute/lexicons';

// Minimal .env loader (no external dep).
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
		// ignore
	}
}

loadEnv('.env');
loadEnv('.dev.vars');

const HANDLE = process.env.BSKY_HANDLE;
const PASSWORD = process.env.BSKY_PASSWORD;

if (!HANDLE || !PASSWORD) {
	console.error('Missing BSKY_HANDLE / BSKY_PASSWORD in env');
	process.exit(1);
}

async function main() {
	console.log(`Logging in as ${HANDLE}…`);

	// Resolve the PDS via the public handle resolver.
	const didRes = await fetch(
		`https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${HANDLE}`
	);
	if (!didRes.ok) {
		console.error('Failed to resolve handle:', didRes.status);
		process.exit(1);
	}
	const { did } = (await didRes.json()) as { did: string };
	console.log(`  did = ${did}`);

	const plcRes = await fetch(`https://plc.directory/${did}`);
	if (!plcRes.ok) {
		console.error('Failed to resolve DID doc:', plcRes.status);
		process.exit(1);
	}
	const doc = (await plcRes.json()) as {
		service?: { id: string; serviceEndpoint: string }[];
	};
	const pds = doc.service?.find((s) => s.id === '#atproto_pds')?.serviceEndpoint;
	if (!pds) {
		console.error('No PDS in DID doc');
		process.exit(1);
	}
	console.log(`  pds = ${pds}`);

	const manager = new CredentialManager({ service: pds });
	await manager.login({ identifier: HANDLE!, password: PASSWORD! });
	console.log(`  login OK, session.did = ${manager.session?.did}`);

	const chatClient = new Client({
		handler: manager,
		proxy: { did: 'did:web:api.bsky.chat' as Did, serviceId: '#bsky_chat' }
	});

	for (const status of ['accepted', 'request']) {
		console.log(`\n=== listConvos (status=${status}) ===`);
		const res = await chatClient.get('chat.bsky.convo.listConvos', {
			params: { limit: 50, status }
		});
		if (!res.ok) {
			console.log(`  FAILED status=${res.status}`, res.data);
			continue;
		}
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const convos = res.data.convos as any[];
		console.log(`  ${convos.length} convos`);
		for (const c of convos) {
			console.log(
				`  - convoId=${c.id} rev=${c.rev} unread=${c.unreadCount} members=${c.members
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					.map((m: any) => m.handle ?? m.did)
					.join(', ')}`
			);
			if (c.lastMessage) {
				console.log(
					`    lastMessage: ${JSON.stringify({
						$type: c.lastMessage.$type,
						text: c.lastMessage.text,
						sender: c.lastMessage.sender?.did,
						rev: c.lastMessage.rev
					})}`
				);
			}

			// Pull ALL messages via pagination.
			let cursor: string | undefined;
			let total = 0;
			for (let page = 0; page < 10; page++) {
				const msgRes = await chatClient.get('chat.bsky.convo.getMessages', {
					params: { convoId: c.id, limit: 100, ...(cursor ? { cursor } : {}) }
				});
				if (!msgRes.ok) {
					console.log(`    getMessages FAILED ${msgRes.status}`, msgRes.data);
					break;
				}
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const msgs = msgRes.data.messages as any[];
				if (page === 0) console.log(`    page ${page}: ${msgs.length} messages`);
				else console.log(`    page ${page}: +${msgs.length} more`);
				for (const m of msgs) {
					console.log(
						`      [${m.rev}] ${m.$type ?? 'msg'} sender=${m.sender?.did ?? '?'} sentAt=${m.sentAt} text=${JSON.stringify(m.text ?? null)} embed=${JSON.stringify(m.embed ?? null)} facets=${JSON.stringify(m.facets ?? null)}`
					);
				}
				total += msgs.length;
				cursor = msgRes.data.cursor;
				if (!cursor) break;
			}
			console.log(`    total messages seen: ${total}`);
		}
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
