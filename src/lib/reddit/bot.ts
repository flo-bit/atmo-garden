// Reddit-on-Bluesky bot: server-side logic for logging in as community
// accounts, managing the central curate list, reading DMs, and creating
// quote posts from DM submissions.

import { Client, CredentialManager, simpleFetchHandler } from '@atcute/client';
import type { Did, ResourceUri } from '@atcute/lexicons';
import * as TID from '@atcute/tid';
import { getPDS, actorToDid } from '$lib/atproto/methods';
import { decryptPassword, encryptPassword } from './crypto';
import {
	getCombinedFeed,
	getMeta,
	getPostsDueForRefresh,
	hasSubmission,
	insertCommunity,
	insertPost,
	listCommunities,
	setMeta,
	updateCommunityProfile,
	updatePostMetrics,
	type CommunityRow
} from './db';

const PROCESSED_REACTION = '✅';
import { getPostCid, parseSubmission } from './submission';

const PUBLIC_APPVIEW = 'https://public.api.bsky.app';
const CURATE_LIST_META_KEY = 'curate_list_uri';
const CURATE_LIST_RKEY_META_KEY = 'curate_list_rkey';

export type AuthedAccount = {
	did: Did;
	handle: string;
	pds: string;
	manager: CredentialManager;
	pdsClient: Client; // repo ops
	chatClient: Client; // chat proxied to api.bsky.chat
};

// -------------------------------------------------------------------------
// Auth helpers
// -------------------------------------------------------------------------

/**
 * Log in to a PDS using an app password and return a ready-to-use pair of
 * clients — one for the PDS (for createRecord etc) and one proxied through
 * the bsky chat service (for chat.bsky.convo.*).
 */
export async function loginWithAppPassword(
	identifier: string,
	password: string,
	pdsUrl?: string
): Promise<AuthedAccount> {
	// Resolve identifier → PDS if we don't already know the PDS. We rely on
	// the login response for the authoritative did/handle.
	let pds = pdsUrl;

	if (!pds) {
		const resolvedDid = await actorToDid(identifier);
		const resolvedPds = await getPDS(resolvedDid);
		if (!resolvedPds) throw new Error(`No PDS found for ${identifier}`);
		pds = resolvedPds;
	}

	const manager = new CredentialManager({ service: pds });
	const session = await manager.login({ identifier, password });
	const handle = session.handle;
	const did: Did = session.did;

	const pdsClient = new Client({ handler: manager });
	const chatClient = new Client({
		handler: manager,
		proxy: { did: 'did:web:api.bsky.chat' as Did, serviceId: '#bsky_chat' }
	});

	return { did, handle, pds, manager, pdsClient, chatClient };
}

export async function loginMainAccount(env: App.Platform['env']): Promise<AuthedAccount> {
	if (!env.BSKY_HANDLE || !env.BSKY_PASSWORD) {
		throw new Error('BSKY_HANDLE / BSKY_PASSWORD not configured');
	}
	return loginWithAppPassword(env.BSKY_HANDLE, env.BSKY_PASSWORD);
}

export async function loginCommunity(
	row: CommunityRow,
	env: App.Platform['env']
): Promise<AuthedAccount> {
	const password = await decryptPassword(
		row.password_ciphertext,
		row.password_iv,
		env.COMMUNITY_ENCRYPTION_KEY
	);
	return loginWithAppPassword(row.handle, password, row.pds);
}

// -------------------------------------------------------------------------
// Curate list management
// -------------------------------------------------------------------------

/**
 * Ensure that the main account has a curate list for tracking community
 * accounts. Returns the list's AT URI. Creates the list if missing.
 */
export async function ensureCurateList(
	main: AuthedAccount,
	db: D1Database
): Promise<ResourceUri> {
	const cached = await getMeta(db, CURATE_LIST_META_KEY);
	if (cached) return cached as ResourceUri;

	// Check whether the main account already has a reddit communities list.
	const existing = await main.pdsClient.get('com.atproto.repo.listRecords', {
		params: {
			repo: main.did,
			collection: 'app.bsky.graph.list',
			limit: 100
		}
	});

	if (existing.ok) {
		for (const rec of existing.data.records) {
			const value = rec.value as { name?: string; purpose?: string };
			if (
				value?.purpose === 'app.bsky.graph.defs#curatelist' &&
				value?.name === 'atmo communities'
			) {
				const uri = rec.uri as ResourceUri;
				await setMeta(db, CURATE_LIST_META_KEY, uri);
				const rkey = uri.split('/').pop() ?? '';
				await setMeta(db, CURATE_LIST_RKEY_META_KEY, rkey);
				return uri;
			}
		}
	}

	// Create the list.
	const rkey = TID.now();
	const create = await main.pdsClient.post('com.atproto.repo.createRecord', {
		input: {
			repo: main.did,
			collection: 'app.bsky.graph.list',
			rkey,
			record: {
				$type: 'app.bsky.graph.list',
				purpose: 'app.bsky.graph.defs#curatelist',
				name: 'atmo communities',
				description: 'Communities registered on atmo.social (reddit-on-bluesky)',
				createdAt: new Date().toISOString()
			}
		}
	});

	if (!create.ok) throw new Error('Failed to create curate list');
	const uri = create.data.uri as ResourceUri;
	await setMeta(db, CURATE_LIST_META_KEY, uri);
	await setMeta(db, CURATE_LIST_RKEY_META_KEY, rkey);
	return uri;
}

/**
 * Add a community DID to the curate list.
 */
export async function addCommunityToList(
	main: AuthedAccount,
	listUri: ResourceUri,
	communityDid: Did
): Promise<void> {
	const rkey = TID.now();
	const res = await main.pdsClient.post('com.atproto.repo.createRecord', {
		input: {
			repo: main.did,
			collection: 'app.bsky.graph.listitem',
			rkey,
			record: {
				$type: 'app.bsky.graph.listitem',
				list: listUri,
				subject: communityDid,
				createdAt: new Date().toISOString()
			}
		}
	});
	if (!res.ok) throw new Error('Failed to add listitem');
}

// -------------------------------------------------------------------------
// Registration
// -------------------------------------------------------------------------

export type RegisterResult = {
	did: Did;
	handle: string;
};

export async function registerCommunity(
	env: App.Platform['env'],
	db: D1Database,
	identifier: string,
	password: string
): Promise<RegisterResult> {
	// Log in as the community to validate credentials.
	const community = await loginWithAppPassword(identifier, password);

	// Store encrypted credentials in D1.
	const { ciphertext, iv } = await encryptPassword(password, env.COMMUNITY_ENCRYPTION_KEY);

	// Fetch profile metadata for the registration preview.
	const appview = new Client({
		handler: simpleFetchHandler({ service: PUBLIC_APPVIEW })
	});
	const profile = await appview.get('app.bsky.actor.getProfile', {
		params: { actor: community.did }
	});

	await insertCommunity(db, {
		did: community.did,
		handle: community.handle,
		pds: community.pds,
		password_ciphertext: ciphertext,
		password_iv: iv,
		display_name: profile.ok ? profile.data.displayName ?? null : null,
		avatar: profile.ok ? profile.data.avatar ?? null : null,
		description: profile.ok ? profile.data.description ?? null : null
	});

	// Add the DID to the main curate list.
	const main = await loginMainAccount(env);
	const listUri = await ensureCurateList(main, db);
	await addCommunityToList(main, listUri, community.did);

	return { did: community.did, handle: community.handle };
}

// -------------------------------------------------------------------------
// DM processing + quote posting
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

/**
 * Poll all convos for a community and turn fresh submission DMs into quote
 * posts. Returns the number of quote posts created.
 */
export async function processCommunityDms(
	env: App.Platform['env'],
	db: D1Database,
	row: CommunityRow
): Promise<number> {
	const community = await loginCommunity(row, env);
	let created = 0;

	// Fetch all convos (both accepted and requested). We have to do two calls
	// because listConvos filters by status.
	const convoLists = await Promise.all([
		community.chatClient.get('chat.bsky.convo.listConvos', {
			params: { limit: 50, status: 'accepted' }
		}),
		community.chatClient.get('chat.bsky.convo.listConvos', {
			params: { limit: 50, status: 'request' }
		})
	]);

	const convos: ChatConvo[] = [];
	for (const res of convoLists) {
		if (res.ok) {
			for (const c of res.data.convos as unknown as ChatConvo[]) convos.push(c);
		}
	}

	for (const convo of convos) {
		// Skip empty convos / convos where we are the only participant.
		const otherMembers = convo.members.filter((m) => m.did !== community.did);
		if (otherMembers.length === 0) continue;

		// Accept request convos so we can process them.
		if (convo.status === 'request') {
			try {
				await community.chatClient.post('chat.bsky.convo.acceptConvo', {
					input: { convoId: convo.id }
				});
			} catch {
				// non-fatal
			}
		}

		// Pull the latest page of messages. Processed messages are marked
		// with a ✅ reaction from the community itself, so we don't need any
		// DB cursor — we just walk the page and skip anything already reacted.
		const msgRes = await community.chatClient.get('chat.bsky.convo.getMessages', {
			params: { convoId: convo.id, limit: 100 }
		});
		if (!msgRes.ok) continue;
		const messages = msgRes.data.messages as unknown as ChatMessage[];

		// Process oldest → newest so reactions appear in order in the chat.
		for (const msg of [...messages].reverse()) {
			if (msg.$type === 'chat.bsky.convo.defs#deletedMessageView') continue;
			if (!msg.sender) continue;
			// Skip messages the community sent.
			if (msg.sender.did === community.did) continue;

			// Already processed? Look for our own ✅ reaction on this message.
			const alreadyProcessed = msg.reactions?.some(
				(r) => r.value === PROCESSED_REACTION && r.sender?.did === community.did
			);
			if (alreadyProcessed) continue;

			const submission = await parseSubmission({ text: msg.text, embed: msg.embed });
			if (!submission) {
				// Not a valid submission — still mark it handled so we don't
				// re-parse on every cron run.
				await community.chatClient
					.post('chat.bsky.convo.addReaction', {
						input: { convoId: convo.id, messageId: msg.id, value: PROCESSED_REACTION }
					})
					.catch(() => {});
				continue;
			}

			// Extra safety: even if the reaction didn't stick last time, the
			// posts table has a unique index on (community_did, quoted_post_uri)
			// and is authoritative. Check before hitting createRecord so we
			// never double-post to Bluesky.
			if (await hasSubmission(db, community.did, submission.postUri)) {
				await community.chatClient
					.post('chat.bsky.convo.addReaction', {
						input: { convoId: convo.id, messageId: msg.id, value: PROCESSED_REACTION }
					})
					.catch(() => {});
				continue;
			}

			const ok = await createSubmissionPost(db, community, submission, msg.sender.did as Did);
			if (ok) {
				created++;
				await community.chatClient
					.post('chat.bsky.convo.addReaction', {
						input: { convoId: convo.id, messageId: msg.id, value: PROCESSED_REACTION }
					})
					.catch(() => {});
			}
		}
	}

	return created;
}

async function createSubmissionPost(
	db: D1Database,
	community: AuthedAccount,
	submission: { title: string; postUri: ResourceUri },
	senderDid: Did
): Promise<boolean> {
	// Resolve the CID of the post being quoted.
	const appview = new Client({
		handler: simpleFetchHandler({ service: PUBLIC_APPVIEW })
	});

	const quotedCid = await getPostCid(appview, submission.postUri);
	if (!quotedCid) return false;

	const rkey = TID.now();
	const createdAt = new Date().toISOString();

	const res = await community.pdsClient.post('com.atproto.repo.createRecord', {
		input: {
			repo: community.did,
			collection: 'app.bsky.feed.post',
			rkey,
			record: {
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
			}
		}
	});

	if (!res.ok) return false;

	const inserted = await insertPost(db, {
		uri: res.data.uri,
		cid: res.data.cid,
		community_did: community.did,
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
// Post metric refresh
// -------------------------------------------------------------------------

/**
 * Refresh cached like/reply/repost counts for stale posts per the decay
 * schedule. Uses the public appview (unauthenticated) for efficiency.
 */
export async function refreshPostMetrics(db: D1Database): Promise<number> {
	const due = await getPostsDueForRefresh(db, 100);
	if (due.length === 0) return 0;

	const appview = new Client({
		handler: simpleFetchHandler({ service: PUBLIC_APPVIEW })
	});

	let refreshed = 0;
	// getPosts caps at 25 URIs per request.
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

	// Keep profile cache refreshed (cheap — one appview call per community).
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

		// Best-effort: refresh profile metadata (avatar/display name/description).
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

// -------------------------------------------------------------------------
// Convenience: combined feed wrapper so routes don't import db.ts directly.
// -------------------------------------------------------------------------

export { getCombinedFeed };
