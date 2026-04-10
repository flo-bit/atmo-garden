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
	getRecord,
	type EcPublicJwk,
	type RookeryAccount
} from './welcomemat';
import {
	countGraphemes,
	PROFILE_DESCRIPTION_MAX_GRAPHEMES
} from '$lib/utils/graphemes';
import {
	DEFAULT_ACCENT_COLOR,
	isAccentColor,
	type AccentColor
} from './accent-colors';

const PUBLIC_APPVIEW = 'https://public.api.bsky.app';

/**
 * Remove the `https://<handle>.atmo.garden` line from a profile description
 * before caching it for UI display. We keep that link in the on-network
 * Bluesky profile so bsky users can click through to our site, but don't want
 * to show it inside the atmo.garden UI (it's redundant there).
 */
/**
 * Fetch the community's `garden.atmo.community/self` record and return its
 * accent color, validated against the allowlist. Falls back to the default
 * if the record is missing or the field is invalid.
 */
async function fetchRecordAccentColor(pds: string, did: string): Promise<AccentColor> {
	try {
		const rec = await getRecord(pds, did, 'garden.atmo.community', 'self');
		const value = (rec?.value ?? {}) as { accentColor?: unknown };
		return isAccentColor(value.accentColor) ? value.accentColor : DEFAULT_ACCENT_COLOR;
	} catch {
		return DEFAULT_ACCENT_COLOR;
	}
}

function stripCommunityLink(desc: string | null | undefined): string | null {
	if (!desc) return null;
	const cleaned = desc
		.split('\n')
		.filter((line) => !/^\s*https?:\/\/\S*atmo\.garden\S*\s*$/i.test(line))
		.join('\n')
		.trim();
	return cleaned || null;
}
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
 *   3. Write garden.atmo.community/self pinning the creator's DID
 *   4. Encrypt the secret key and store everything in D1
 */
export type RegisterCommunityOptions = {
	shortHandle: string;
	creatorDid: Did;
	description?: string;
	/** Raw bytes + MIME type for the community avatar. */
	avatar?: { bytes: Uint8Array; mimeType: string };
	/** Tailwind color label, e.g. "pink", "blue", "lime". */
	accentColor?: string;
};

export async function registerCommunity(
	env: App.Platform['env'],
	db: D1Database,
	opts: RegisterCommunityOptions
): Promise<RegisterResult> {
	if (!env.ROOKERY_HOSTNAME) throw new Error('ROOKERY_HOSTNAME not configured');
	if (!env.ROOKERY_SIGNUP_SECRET)
		throw new Error('ROOKERY_SIGNUP_SECRET not configured');

	const { shortHandle, creatorDid, description: userDescription, avatar, accentColor } = opts;

	const { account } = await createRookeryAccount({
		hostname: env.ROOKERY_HOSTNAME,
		handle: shortHandle,
		signupSecret: env.ROOKERY_SIGNUP_SECRET
	});

	const client = WelcomeMatClient.forAccount(account);

	// Write garden.atmo.community/self. This record is the canonical
	// location for per-community metadata we own (creator, accent color,
	// future app-specific fields). Non-fatal on failure — the community
	// still exists and the bot can operate.
	try {
		await client.createRecord(
			'garden.atmo.community',
			{
				$type: 'garden.atmo.community',
				creator: creatorDid,
				accentColor: accentColor ?? 'pink',
				createdAt: new Date().toISOString()
			},
			'self'
		);
	} catch (e) {
		console.error('[registerCommunity] failed to write garden.atmo.community/self', e);
	}

	// Upload the avatar blob (if provided) so we can reference it in the
	// profile record below.
	let avatarBlob:
		| { $type: 'blob'; ref: { $link: string }; mimeType: string; size: number }
		| null = null;
	if (avatar) {
		try {
			avatarBlob = await client.uploadBlob(avatar.bytes, avatar.mimeType);
		} catch (e) {
			console.error('[registerCommunity] avatar upload failed', e);
		}
	}

	// Build the on-network profile description: `https://<handle>` on the
	// first line (so bsky viewers have a clickable link to our site) followed
	// by the user's own description text, if provided. We merge into the
	// record Rookery seeded so we don't wipe displayName.
	const trimmedUserDesc = userDescription?.trim() ?? '';
	const fullDescription = trimmedUserDesc
		? `https://${account.handle}\n\n${trimmedUserDesc}`
		: `https://${account.handle}`;
	if (countGraphemes(fullDescription) > PROFILE_DESCRIPTION_MAX_GRAPHEMES) {
		throw new Error(
			`Description too long: ${PROFILE_DESCRIPTION_MAX_GRAPHEMES} graphemes max (including the https://${account.handle} link prepended for bsky)`
		);
	}
	try {
		const existing = await getRecord(
			account.pds,
			account.did,
			'app.bsky.actor.profile',
			'self'
		);
		const baseValue = existing?.value ?? { $type: 'app.bsky.actor.profile' };
		await client.putRecord('app.bsky.actor.profile', 'self', {
			...baseValue,
			$type: 'app.bsky.actor.profile',
			description: fullDescription,
			...(avatarBlob ? { avatar: avatarBlob } : {})
		});
	} catch (e) {
		console.error('[registerCommunity] failed to update profile', e);
	}

	// Encrypt the hex-encoded secret key.
	const { ciphertext, iv } = await encryptPassword(
		account.secretKeyHex,
		env.COMMUNITY_ENCRYPTION_KEY
	);

	// Fetch the profile the signup seeded so we can cache display name /
	// avatar for the UI. Rookery writes these immediately but the relay may
	// not have propagated them yet — fall back to the short handle.
	const appview = new Client({
		handler: simpleFetchHandler({ service: PUBLIC_APPVIEW })
	});
	let displayName: string | null = shortHandle;
	let avatarUrl: string | null = null;
	let followersCount: number | null = null;
	try {
		const profile = await appview.get('app.bsky.actor.getProfile', {
			params: { actor: account.did as Did }
		});
		if (profile.ok) {
			displayName = profile.data.displayName ?? shortHandle;
			avatarUrl = profile.data.avatar ?? null;
			followersCount = profile.data.followersCount ?? 0;
		}
	} catch {
		// non-fatal — relay hasn't indexed yet
	}

	// Cache the stripped (user-facing) description in D1. The cron refresh
	// below also strips on every tick so edits made directly on bsky stay
	// consistent.
	const cachedDescription = stripCommunityLink(fullDescription);

	await insertCommunity(db, {
		did: account.did as Did,
		handle: account.handle,
		pds: account.pds,
		secret_key_ciphertext: ciphertext,
		secret_key_iv: iv,
		public_jwk_json: JSON.stringify(account.publicJwk),
		thumbprint: account.thumbprint,
		display_name: displayName,
		avatar: avatarUrl,
		description: cachedDescription,
		accent_color: accentColor ?? DEFAULT_ACCENT_COLOR,
		followers_count: followersCount
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
	const isRepost = submission.title.length === 0;

	let result: { uri: string; cid: string };
	try {
		if (isRepost) {
			// No title → straight repost. The community account boosts the
			// original post, no commentary added.
			result = await client.createRecord('app.bsky.feed.repost', {
				$type: 'app.bsky.feed.repost',
				subject: { uri: submission.postUri, cid: quotedCid },
				createdAt
			});
		} else {
			result = await client.createRecord('app.bsky.feed.post', {
				$type: 'app.bsky.feed.post',
				text: submission.title,
				createdAt,
				embed: {
					$type: 'app.bsky.embed.record',
					record: { uri: submission.postUri, cid: quotedCid }
				}
			});
		}
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
// Metric refresh
// -------------------------------------------------------------------------

/**
 * Refresh cached metrics on each post from the QUOTED (original) post's
 * live counts. Powers the "top" sort — the numbers the UI shows and the
 * numbers we rank by are the original Bluesky post's engagement, not the
 * community's quote/repost record.
 */
export async function refreshPostMetrics(db: D1Database): Promise<number> {
	const due = await getPostsDueForRefresh(db, 100);
	if (due.length === 0) return 0;

	const appview = new Client({
		handler: simpleFetchHandler({ service: PUBLIC_APPVIEW })
	});

	let refreshed = 0;
	for (let i = 0; i < due.length; i += 25) {
		const batch = due.slice(i, i + 25);
		// Fetch metrics for the set of quoted-post URIs in this batch.
		// Multiple rows can share the same quoted_post_uri (different
		// communities quoting the same post), so we dedupe the fetch set
		// and then fan out the update to every matching row.
		const quotedUris = Array.from(
			new Set(batch.map((p) => p.quoted_post_uri))
		) as ResourceUri[];
		try {
			const res = await appview.get('app.bsky.feed.getPosts', {
				params: { uris: quotedUris }
			});
			if (!res.ok) continue;
			const metricsByQuoted = new Map<
				string,
				{ like_count: number; reply_count: number; repost_count: number }
			>();
			for (const post of res.data.posts) {
				metricsByQuoted.set(post.uri, {
					like_count: post.likeCount ?? 0,
					reply_count: post.replyCount ?? 0,
					repost_count: post.repostCount ?? 0
				});
			}
			for (const row of batch) {
				const m = metricsByQuoted.get(row.quoted_post_uri);
				if (!m) continue;
				await updatePostMetrics(db, row.uri, m);
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

		// Best-effort: refresh cached profile metadata (avatar, display name,
		// desc, follower count) from the appview, and the accent color from
		// the community's `garden.atmo.community/self` record on the PDS.
		// Both requests run in parallel since they hit different services.
		// `followersCount` already comes back on every getProfile call, so
		// caching it is free — no separate refresh schedule needed.
		try {
			const [profile, recordAccent] = await Promise.all([
				appview.get('app.bsky.actor.getProfile', { params: { actor: row.did } }),
				fetchRecordAccentColor(row.pds, row.did)
			]);
			if (profile.ok) {
				await updateCommunityProfile(db, row.did, {
					display_name: profile.data.displayName ?? null,
					avatar: profile.data.avatar ?? null,
					description: stripCommunityLink(profile.data.description),
					accent_color: recordAccent,
					followers_count: profile.data.followersCount ?? 0
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
