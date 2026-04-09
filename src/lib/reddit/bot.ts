// Reddit-on-Bluesky bot: server-side logic for creating rookery-backed
// community accounts, reading their DMs via Bluesky's chat service, and
// turning submission DMs into quote posts on Bluesky.
//
// All auth goes through rookery's WelcomeMat DPoP flow (secp256k1). Chat
// operations use service-auth JWTs that rookery issues via
// getServiceAuth, which api.bsky.chat accepts because the token is signed
// by the account's secp256k1 repo signing key (published in its DID doc).

import { Client, simpleFetchHandler } from '@atcute/client';
import type { Did, ResourceUri } from '@atcute/lexicons';
import { decryptPassword, encryptPassword } from './crypto';
import {
	getCombinedFeed,
	getPostsDueForRefresh,
	hasSubmission,
	insertCommunity,
	insertPost,
	listCommunities,
	updateCommunityProfile,
	updatePostMetrics,
	type CommunityRow
} from './db';
import { getPostCid, parseSubmission } from './submission';
import {
	WelcomeMatClient,
	createRookeryAccount,
	type EcPublicJwk,
	type RookeryAccount
} from './welcomemat';

const PUBLIC_APPVIEW = 'https://public.api.bsky.app';
const CHAT_SERVICE_DID = 'did:web:api.bsky.chat';
const CHAT_SERVICE_BASE = 'https://api.bsky.chat/xrpc';
const PROCESSED_REACTION = '✅';

// -------------------------------------------------------------------------
// Loading a client for a stored community
// -------------------------------------------------------------------------

async function loadClient(
	env: App.Platform['env'],
	row: CommunityRow
): Promise<WelcomeMatClient> {
	const secretKeyHex = await decryptPassword(
		row.secret_key_ciphertext,
		row.secret_key_iv,
		env.COMMUNITY_ENCRYPTION_KEY
	);
	const publicJwk = JSON.parse(row.public_jwk_json) as EcPublicJwk;
	const account: RookeryAccount = {
		did: row.did,
		handle: row.handle,
		pds: row.pds,
		thumbprint: row.thumbprint,
		publicJwk,
		secretKeyHex
	};
	return WelcomeMatClient.forAccount(account);
}

// -------------------------------------------------------------------------
// Registration
// -------------------------------------------------------------------------

export type RegisterResult = {
	did: Did;
	handle: string;
};

/**
 * Create a brand-new rookery community account.
 *
 * Flow:
 *   1. Generate a secp256k1 keypair
 *   2. Sign up on rookery (which auto-seeds chat.bsky.actor.declaration
 *      and a bot-labeled app.bsky.actor.profile)
 *   3. Encrypt the secret key and store everything in D1
 */
export async function registerCommunity(
	env: App.Platform['env'],
	db: D1Database,
	shortHandle: string
): Promise<RegisterResult> {
	if (!env.ROOKERY_HOSTNAME) throw new Error('ROOKERY_HOSTNAME not configured');
	if (!env.ROOKERY_SIGNUP_SECRET)
		throw new Error('ROOKERY_SIGNUP_SECRET not configured');

	const { account } = await createRookeryAccount({
		hostname: env.ROOKERY_HOSTNAME,
		handle: shortHandle,
		signupSecret: env.ROOKERY_SIGNUP_SECRET
	});

	// Encrypt the hex-encoded secret key.
	const { ciphertext, iv } = await encryptPassword(
		account.secretKeyHex,
		env.COMMUNITY_ENCRYPTION_KEY
	);

	// Fetch the profile the signup seeded so we can cache display name /
	// description for the UI. Rookery writes these immediately but the relay
	// may not have propagated them yet — fall back to the short handle.
	const appview = new Client({
		handler: simpleFetchHandler({ service: PUBLIC_APPVIEW })
	});
	let displayName: string | null = shortHandle;
	let avatar: string | null = null;
	let description: string | null = `https://${account.handle}`;
	try {
		const profile = await appview.get('app.bsky.actor.getProfile', {
			params: { actor: account.did as Did }
		});
		if (profile.ok) {
			displayName = profile.data.displayName ?? shortHandle;
			avatar = profile.data.avatar ?? null;
			description = profile.data.description ?? description;
		}
	} catch {
		// non-fatal — relay hasn't indexed yet
	}

	await insertCommunity(db, {
		did: account.did as Did,
		handle: account.handle,
		pds: account.pds,
		secret_key_ciphertext: ciphertext,
		secret_key_iv: iv,
		public_jwk_json: JSON.stringify(account.publicJwk),
		thumbprint: account.thumbprint,
		display_name: displayName,
		avatar,
		description
	});

	return { did: account.did as Did, handle: account.handle };
}

// -------------------------------------------------------------------------
// Chat types
// -------------------------------------------------------------------------

type ChatConvo = {
	id: string;
	status?: string;
	rev: string;
	unreadCount?: number;
	members: { did: string }[];
};

type ChatReaction = {
	value: string;
	sender?: { did: string };
};

type ChatMessage = {
	$type?: string;
	id: string;
	rev: string;
	text?: string;
	sentAt: string;
	sender?: { did: string };
	embed?: {
		$type?: string;
		record?: { uri?: string };
	} | null;
	reactions?: ChatReaction[];
};

// -------------------------------------------------------------------------
// api.bsky.chat calls via service-auth tokens
// -------------------------------------------------------------------------

/**
 * Call an api.bsky.chat XRPC method as the given community. Automatically
 * fetches a service-auth token from rookery scoped to the method.
 */
async function chatCall<T>(
	client: WelcomeMatClient,
	method: string,
	init: { method?: 'GET' | 'POST'; query?: Record<string, string>; body?: unknown }
): Promise<{ ok: boolean; status: number; data: T | { error: string; message?: string } }> {
	const httpMethod = init.method ?? 'GET';
	const token = await client.getServiceAuth(CHAT_SERVICE_DID, method);

	const url = new URL(`${CHAT_SERVICE_BASE}/${method}`);
	if (init.query) {
		for (const [k, v] of Object.entries(init.query)) {
			if (v !== undefined) url.searchParams.set(k, v);
		}
	}

	const req: RequestInit = {
		method: httpMethod,
		headers: {
			Authorization: `Bearer ${token}`,
			...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {})
		},
		...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {})
	};

	const res = await fetch(url.toString(), req);
	const text = await res.text();
	let data: unknown;
	try {
		data = text ? JSON.parse(text) : {};
	} catch {
		data = { error: 'ParseError', message: text };
	}
	return { ok: res.ok, status: res.status, data: data as never };
}

async function listConvos(
	client: WelcomeMatClient,
	status: 'accepted' | 'request'
): Promise<ChatConvo[]> {
	const res = await chatCall<{ convos: ChatConvo[] }>(
		client,
		'chat.bsky.convo.listConvos',
		{ method: 'GET', query: { limit: '50', status } }
	);
	if (!res.ok) return [];
	return (res.data as { convos: ChatConvo[] }).convos ?? [];
}

async function getMessages(
	client: WelcomeMatClient,
	convoId: string
): Promise<ChatMessage[]> {
	const res = await chatCall<{ messages: ChatMessage[] }>(
		client,
		'chat.bsky.convo.getMessages',
		{ method: 'GET', query: { convoId, limit: '100' } }
	);
	if (!res.ok) return [];
	return (res.data as { messages: ChatMessage[] }).messages ?? [];
}

async function acceptConvo(client: WelcomeMatClient, convoId: string): Promise<void> {
	await chatCall(client, 'chat.bsky.convo.acceptConvo', {
		method: 'POST',
		body: { convoId }
	});
}

async function addReaction(
	client: WelcomeMatClient,
	convoId: string,
	messageId: string,
	value: string
): Promise<void> {
	await chatCall(client, 'chat.bsky.convo.addReaction', {
		method: 'POST',
		body: { convoId, messageId, value }
	}).catch(() => {});
}

// -------------------------------------------------------------------------
// DM processing
// -------------------------------------------------------------------------

/**
 * Poll both accepted + request convos for a community and turn fresh
 * submission DMs into quote posts. Returns the number of quote posts
 * created this call.
 */
export async function processCommunityDms(
	env: App.Platform['env'],
	db: D1Database,
	row: CommunityRow
): Promise<number> {
	const client = await loadClient(env, row);
	let created = 0;

	const [accepted, requested] = await Promise.all([
		listConvos(client, 'accepted'),
		listConvos(client, 'request')
	]);
	const convos = [...accepted, ...requested];

	for (const convo of convos) {
		const otherMembers = convo.members.filter((m) => m.did !== row.did);
		if (otherMembers.length === 0) continue;

		if (convo.status === 'request') {
			await acceptConvo(client, convo.id);
		}

		const messages = await getMessages(client, convo.id);
		// Process oldest → newest so reactions appear in order.
		for (const msg of [...messages].reverse()) {
			if (msg.$type === 'chat.bsky.convo.defs#deletedMessageView') continue;
			if (!msg.sender) continue;
			if (msg.sender.did === row.did) continue;

			// Already processed? Look for our own ✅ reaction on this message.
			const alreadyProcessed = msg.reactions?.some(
				(r) => r.value === PROCESSED_REACTION && r.sender?.did === row.did
			);
			if (alreadyProcessed) continue;

			const submission = await parseSubmission({
				text: msg.text,
				embed: msg.embed ?? undefined
			});
			if (!submission) {
				// Mark as handled so we don't re-parse on every cron run.
				await addReaction(client, convo.id, msg.id, PROCESSED_REACTION);
				continue;
			}

			// Check dedup before hitting createRecord so we never double-post.
			if (await hasSubmission(db, row.did, submission.postUri)) {
				await addReaction(client, convo.id, msg.id, PROCESSED_REACTION);
				continue;
			}

			const ok = await createSubmissionPost(
				db,
				client,
				row,
				submission,
				msg.sender.did as Did
			);
			if (ok) {
				created++;
				await addReaction(client, convo.id, msg.id, PROCESSED_REACTION);
			}
		}
	}

	return created;
}

async function createSubmissionPost(
	db: D1Database,
	client: WelcomeMatClient,
	row: CommunityRow,
	submission: { title: string; postUri: ResourceUri },
	senderDid: Did
): Promise<boolean> {
	// Resolve the CID of the post being quoted via the public appview.
	const appview = new Client({
		handler: simpleFetchHandler({ service: PUBLIC_APPVIEW })
	});
	const quotedCid = await getPostCid(appview, submission.postUri);
	if (!quotedCid) return false;

	const createdAt = new Date().toISOString();
	let result: { uri: string; cid: string };
	try {
		result = await client.createRecord('app.bsky.feed.post', {
			$type: 'app.bsky.feed.post',
			text: submission.title,
			createdAt,
			embed: {
				$type: 'app.bsky.embed.record',
				record: {
					uri: submission.postUri,
					cid: quotedCid
				}
			}
		});
	} catch (e) {
		console.error('[createSubmissionPost] rookery createRecord failed', e);
		return false;
	}

	const inserted = await insertPost(db, {
		uri: result.uri,
		cid: result.cid,
		community_did: row.did,
		title: submission.title,
		quoted_post_uri: submission.postUri,
		quoted_post_cid: quotedCid,
		author_did: senderDid,
		like_count: 0,
		reply_count: 0,
		repost_count: 0,
		indexed_at: createdAt
	});
	return inserted;
}

// -------------------------------------------------------------------------
// Metric refresh (unchanged — uses public appview)
// -------------------------------------------------------------------------

export async function refreshPostMetrics(db: D1Database): Promise<number> {
	const due = await getPostsDueForRefresh(db, 100);
	if (due.length === 0) return 0;

	const appview = new Client({
		handler: simpleFetchHandler({ service: PUBLIC_APPVIEW })
	});

	let refreshed = 0;
	for (let i = 0; i < due.length; i += 25) {
		const batch = due.slice(i, i + 25).map((p) => p.uri as ResourceUri);
		try {
			const res = await appview.get('app.bsky.feed.getPosts', {
				params: { uris: batch }
			});
			if (!res.ok) continue;
			for (const post of res.data.posts) {
				await updatePostMetrics(db, post.uri, {
					like_count: post.likeCount ?? 0,
					reply_count: post.replyCount ?? 0,
					repost_count: post.repostCount ?? 0
				});
				refreshed++;
			}
		} catch (e) {
			console.error('[refreshPostMetrics] batch failed', e);
		}
	}

	return refreshed;
}

// -------------------------------------------------------------------------
// Top-level cron entry point
// -------------------------------------------------------------------------

export async function runCronTick(env: App.Platform['env']): Promise<{
	communitiesChecked: number;
	postsCreated: number;
	postsRefreshed: number;
	errors: string[];
}> {
	const db = env.DB;
	if (!db) throw new Error('DB binding missing');

	const errors: string[] = [];
	const communities = await listCommunities(db);

	const appview = new Client({
		handler: simpleFetchHandler({ service: PUBLIC_APPVIEW })
	});

	let postsCreated = 0;
	for (const row of communities) {
		try {
			postsCreated += await processCommunityDms(env, db, row);
		} catch (e) {
			console.error(`[cron] community ${row.handle} failed:`, e);
			errors.push(`${row.handle}: ${String(e)}`);
		}

		// Best-effort: refresh cached profile metadata (avatar, display name, desc).
		try {
			const profile = await appview.get('app.bsky.actor.getProfile', {
				params: { actor: row.did }
			});
			if (profile.ok) {
				await updateCommunityProfile(db, row.did, {
					display_name: profile.data.displayName ?? null,
					avatar: profile.data.avatar ?? null,
					description: profile.data.description ?? null
				});
			}
		} catch {
			// non-fatal
		}
	}

	const postsRefreshed = await refreshPostMetrics(db).catch((e) => {
		errors.push(`refresh: ${String(e)}`);
		return 0;
	});

	return {
		communitiesChecked: communities.length,
		postsCreated,
		postsRefreshed,
		errors
	};
}

// Convenience re-export so routes don't need to import db.ts directly.
export { getCombinedFeed };
