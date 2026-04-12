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
	deletePostsByUris,
	getCombinedFeed,
	getCommunityByDid,
	getJetstreamCursor,
	getPostsDueForRefresh,
	getPostsPastDeletionGrace,
	hasSubmission,
	insertCommunity,
	insertPost,
	listCommunities,
	markPostRemoved,
	saveJetstreamCursor,
	updateCommunityMentionsSeenAt,
	updateCommunityProfile,
	type CommunityRow
} from './db';
import { getPostMeta, parseSubmission } from './submission';
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
export type WhoCanSubmit = 'everyone' | 'list';

export type CommunityConfig = {
	accentColor: AccentColor;
	whoCanSubmit: WhoCanSubmit;
	listUri: string | null;
	/** DID of the account that registered the community. Null for legacy rows. */
	creator: string | null;
};

const DEFAULT_COMMUNITY_CONFIG: CommunityConfig = {
	accentColor: DEFAULT_ACCENT_COLOR,
	whoCanSubmit: 'everyone',
	listUri: null,
	creator: null
};

/**
 * Fetch the community's `garden.atmo.community/self` record and return the
 * UI-relevant fields. Falls back to sensible defaults on any failure so the
 * community still works without a record.
 */
export async function fetchCommunityConfig(pds: string, did: string): Promise<CommunityConfig> {
	try {
		const rec = await getRecord(pds, did, 'garden.atmo.community', 'self');
		const value = (rec?.value ?? {}) as {
			accentColor?: unknown;
			whoCanSubmit?: unknown;
			listUri?: unknown;
			creator?: unknown;
		};
		return {
			accentColor: isAccentColor(value.accentColor) ? value.accentColor : DEFAULT_ACCENT_COLOR,
			whoCanSubmit: value.whoCanSubmit === 'list' ? 'list' : 'everyone',
			listUri: typeof value.listUri === 'string' ? value.listUri : null,
			creator:
				typeof value.creator === 'string' && value.creator.startsWith('did:')
					? value.creator
					: null
		};
	} catch {
		return { ...DEFAULT_COMMUNITY_CONFIG };
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
const BSKY_APPVIEW_DID = 'did:web:api.bsky.app';
const BSKY_APPVIEW_BASE = 'https://api.bsky.app/xrpc';
const PROCESSED_REACTION = '✅';
const REJECTED_REACTION = '🔒';

// -------------------------------------------------------------------------
// Welcome post helpers
// -------------------------------------------------------------------------

const textEncoder = new TextEncoder();

/** Find the UTF-8 byte range of `substring` inside `text`, or null. */
function byteRange(
	text: string,
	substring: string
): { byteStart: number; byteEnd: number } | null {
	const charIdx = text.indexOf(substring);
	if (charIdx === -1) return null;
	const byteStart = textEncoder.encode(text.slice(0, charIdx)).byteLength;
	const byteEnd = byteStart + textEncoder.encode(substring).byteLength;
	return { byteStart, byteEnd };
}

type RichtextFacet = {
	index: { byteStart: number; byteEnd: number };
	features: { $type: 'app.bsky.richtext.facet#link'; uri: string }[];
};

/**
 * Compose + publish the "this is a community account" welcome post on a
 * freshly-registered community account. Explains how submissions work and
 * links back to the community on atmo.garden (plus the allowlist if gated).
 *
 * Returns the new post's `{uri, cid}` so the caller can pin it on the
 * community's profile, or `null` if the post failed to create.
 */
async function createWelcomePost(
	client: WelcomeMatClient,
	shortHandle: string,
	access: { whoCanSubmit: WhoCanSubmit; listUri: string | null }
): Promise<{ uri: string; cid: string } | null> {
	const communityUrl = `https://${shortHandle}.atmo.garden`;
	const gatedToList = access.whoCanSubmit === 'list' && !!access.listUri;
	const domainText = `${shortHandle}.atmo.garden`;

	const submitterLine = gatedToList
		? 'People from this list can submit posts'
		: 'Everyone can submit posts';

	const text = `This is a community account, people can submit bsky posts by DM'ing them to this account
- DMs with text get quoted
- DMs without text get reposted

${submitterLine}

see posts of this community sorted by Hot/New/Top on ${domainText}`;

	const facets: RichtextFacet[] = [];

	if (gatedToList && access.listUri) {
		// at://did:plc:xxx/app.bsky.graph.list/rkey → https://bsky.app/profile/did/lists/rkey
		const match = access.listUri.match(
			/^at:\/\/([^/]+)\/app\.bsky\.graph\.list\/([^/]+)$/
		);
		if (match) {
			const [, did, rkey] = match;
			const listUrl = `https://bsky.app/profile/${did}/lists/${rkey}`;
			const range = byteRange(text, 'this list');
			if (range) {
				facets.push({
					index: range,
					features: [{ $type: 'app.bsky.richtext.facet#link', uri: listUrl }]
				});
			}
		}
	}

	const domainRange = byteRange(text, domainText);
	if (domainRange) {
		facets.push({
			index: domainRange,
			features: [{ $type: 'app.bsky.richtext.facet#link', uri: communityUrl }]
		});
	}

	try {
		const result = await client.createRecord('app.bsky.feed.post', {
			$type: 'app.bsky.feed.post',
			text,
			facets,
			createdAt: new Date().toISOString()
		});
		return { uri: result.uri, cid: result.cid };
	} catch (e) {
		console.error('[createWelcomePost] failed', e);
		return null;
	}
}

// -------------------------------------------------------------------------
// atmo.garden discovery list
// -------------------------------------------------------------------------

/**
 * Add a newly-registered community's DID to the public atmo.garden discovery
 * list (e.g. https://bsky.app/profile/atmo.garden/lists/3mj2xb5hpp74n).
 *
 * Authenticates against the atmo.garden account with a classic Bluesky app
 * password — OAuth is overkill for a single-account bot. Uses raw fetch so
 * we don't drag in a full atproto client just for this.
 *
 * Best-effort: if any env var is missing we silently skip. If the login or
 * createRecord fails we log and return — a flaky list-add must not break
 * community registration.
 */
async function addCommunityToDiscoveryList(
	env: App.Platform['env'],
	communityDid: Did
): Promise<void> {
	const pds = env.ATMO_GARDEN_PDS;
	const identifier = env.ATMO_GARDEN_IDENTIFIER;
	const password = env.ATMO_GARDEN_APP_PASSWORD;
	const listRkey = env.ATMO_GARDEN_LIST_RKEY;

	if (!pds || !identifier || !password || !listRkey) {
		console.log(
			'[discovery-list] skipped — ATMO_GARDEN_* env vars not fully configured'
		);
		return;
	}

	try {
		// 1. Log in.
		const sessionRes = await fetch(`${pds}/xrpc/com.atproto.server.createSession`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ identifier, password })
		});
		if (!sessionRes.ok) {
			throw new Error(
				`createSession failed (${sessionRes.status}): ${await sessionRes.text()}`
			);
		}
		const session = (await sessionRes.json()) as {
			did: string;
			accessJwt: string;
		};

		// 2. Build the list at-URI from the logged-in account's own DID +
		//    the configured rkey. This means the env var is just the short
		//    rkey — no handle resolution required.
		const listUri = `at://${session.did}/app.bsky.graph.list/${listRkey}`;

		// 3. Create the listitem record.
		const createRes = await fetch(`${pds}/xrpc/com.atproto.repo.createRecord`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${session.accessJwt}`
			},
			body: JSON.stringify({
				repo: session.did,
				collection: 'app.bsky.graph.listitem',
				record: {
					$type: 'app.bsky.graph.listitem',
					subject: communityDid,
					list: listUri,
					createdAt: new Date().toISOString()
				}
			})
		});
		if (!createRes.ok) {
			throw new Error(
				`createRecord listitem failed (${createRes.status}): ${await createRes.text()}`
			);
		}

		console.log(`[discovery-list] added ${communityDid} to ${listUri}`);
	} catch (e) {
		console.error('[discovery-list] failed', e);
	}
}

// -------------------------------------------------------------------------
// Loading a client for a stored community
// -------------------------------------------------------------------------

/**
 * Re-read the community's on-network profile (via the public appview) +
 * `garden.atmo.community/self` record and write the fresh values into
 * the D1 cache. Used by the cron tick AND by the editCommunity remote so
 * an edit takes effect immediately instead of waiting up to a minute for
 * the next cron. Fails soft — errors just leave the cache stale until
 * the next cron tick catches up.
 */
export async function refreshCommunityCache(
	env: App.Platform['env'],
	row: CommunityRow
): Promise<void> {
	const appview = new Client({
		handler: simpleFetchHandler({ service: PUBLIC_APPVIEW })
	});
	try {
		const [profile, config] = await Promise.all([
			appview.get('app.bsky.actor.getProfile', { params: { actor: row.did } }),
			fetchCommunityConfig(row.pds, row.did)
		]);
		if (profile.ok) {
			await updateCommunityProfile(env.DB, row.did, {
				display_name: profile.data.displayName ?? null,
				avatar: profile.data.avatar ?? null,
				description: stripCommunityLink(profile.data.description),
				accent_color: config.accentColor,
				followers_count: profile.data.followersCount ?? 0
			});
		}
	} catch (e) {
		console.error('[refreshCommunityCache] failed', e);
	}
}

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

/**
 * Partial update of a community's on-network presence. Fields that are
 * omitted are left untouched (both on the profile record and on
 * garden.atmo.community/self). The D1 cache picks up display-name /
 * avatar / description / accent from the next cron tick; accent_color
 * can be updated inline since we know the new value.
 */
export type UpdateCommunityOptions = {
	avatar?: { bytes: Uint8Array; mimeType: string };
	/** User-facing description (we prepend the `https://<handle>` link). */
	description?: string;
	accentColor?: string;
};

export async function updateCommunity(
	env: App.Platform['env'],
	row: CommunityRow,
	opts: UpdateCommunityOptions
): Promise<void> {
	const client = await loadClient(env, row);

	// Upload new avatar blob if provided.
	let avatarBlob:
		| { $type: 'blob'; ref: { $link: string }; mimeType: string; size: number }
		| null = null;
	if (opts.avatar) {
		avatarBlob = await client.uploadBlob(opts.avatar.bytes, opts.avatar.mimeType);
	}

	// Merge into the existing profile record. We read it first so we
	// don't clobber fields we don't touch (displayName etc.).
	if (avatarBlob || opts.description !== undefined) {
		try {
			const existing = await getRecord(
				row.pds,
				row.did,
				'app.bsky.actor.profile',
				'self'
			);
			const baseValue =
				existing?.value ?? ({ $type: 'app.bsky.actor.profile' } as Record<string, unknown>);

			const next: Record<string, unknown> = { ...baseValue, $type: 'app.bsky.actor.profile' };

			if (avatarBlob) {
				next.avatar = avatarBlob;
			}
			if (opts.description !== undefined) {
				const trimmed = opts.description.trim();
				const full = trimmed
					? `https://${row.handle}\n\n${trimmed}`
					: `https://${row.handle}`;
				if (countGraphemes(full) > PROFILE_DESCRIPTION_MAX_GRAPHEMES) {
					throw new Error(
						`Description too long: ${PROFILE_DESCRIPTION_MAX_GRAPHEMES} graphemes max (including the https://${row.handle} prefix)`
					);
				}
				next.description = full;
			}

			await client.putRecord('app.bsky.actor.profile', 'self', next);
		} catch (e) {
			console.error('[updateCommunity] failed to update profile', e);
			throw e;
		}
	}

	// Merge into garden.atmo.community/self for accent color changes.
	if (opts.accentColor !== undefined) {
		try {
			const existing = await getRecord(
				row.pds,
				row.did,
				'garden.atmo.community',
				'self'
			);
			const baseValue =
				existing?.value ?? ({ $type: 'garden.atmo.community' } as Record<string, unknown>);
			await client.putRecord('garden.atmo.community', 'self', {
				...baseValue,
				$type: 'garden.atmo.community',
				accentColor: opts.accentColor
			});
		} catch (e) {
			console.error('[updateCommunity] failed to update community record', e);
			throw e;
		}
	}
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
	/** Who is allowed to submit posts. Defaults to 'everyone'. */
	whoCanSubmit?: WhoCanSubmit;
	/**
	 * When `whoCanSubmit === 'list'`, the canonical at-URI of the allowlist
	 * `app.bsky.graph.list` record. Caller is responsible for parsing and
	 * normalizing (handle → DID) before passing.
	 */
	listUri?: string | null;
};

export async function registerCommunity(
	env: App.Platform['env'],
	db: D1Database,
	opts: RegisterCommunityOptions
): Promise<RegisterResult> {
	if (!env.ROOKERY_HOSTNAME) throw new Error('ROOKERY_HOSTNAME not configured');
	if (!env.ROOKERY_SIGNUP_SECRET)
		throw new Error('ROOKERY_SIGNUP_SECRET not configured');

	const {
		shortHandle,
		creatorDid,
		description: userDescription,
		avatar,
		accentColor,
		whoCanSubmit = 'everyone',
		listUri
	} = opts;

	const { account } = await createRookeryAccount({
		hostname: env.ROOKERY_HOSTNAME,
		handle: shortHandle,
		signupSecret: env.ROOKERY_SIGNUP_SECRET
	});

	const client = WelcomeMatClient.forAccount(account);

	// Write garden.atmo.community/self. This record is the canonical
	// location for per-community metadata we own (creator, accent color,
	// access control, future app-specific fields). Non-fatal on failure —
	// the community still exists and the bot can operate.
	try {
		await client.createRecord(
			'garden.atmo.community',
			{
				$type: 'garden.atmo.community',
				creator: creatorDid,
				accentColor: accentColor ?? 'pink',
				whoCanSubmit,
				...(whoCanSubmit === 'list' && listUri ? { listUri } : {}),
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
	// Publish the "this is a community account" welcome post first, so we
	// have its `{uri, cid}` to pin on the profile below. Non-fatal — if
	// this fails the profile just won't have a pinned post.
	const welcomePost = await createWelcomePost(client, shortHandle, {
		whoCanSubmit,
		listUri: listUri ?? null
	});

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
			...(avatarBlob ? { avatar: avatarBlob } : {}),
			...(welcomePost ? { pinnedPost: welcomePost } : {})
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
		followers_count: followersCount,
		// Leave NULL so the first cron tick primes the mentions cursor by
		// calling updateSeen(now) — we don't want to retroactively repost
		// anything that was mentioning the handle before the community
		// existed (e.g. squatted names, testing, etc.).
		last_mention_seen_at: null
	});

	// Add the new community to the public atmo.garden discovery list so it
	// shows up for anyone subscribed to the list on Bluesky. Non-fatal —
	// the community is fully registered by this point regardless.
	await addCommunityToDiscoveryList(env, account.did as Did);

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

async function sendMessage(
	client: WelcomeMatClient,
	convoId: string,
	text: string
): Promise<void> {
	await chatCall(client, 'chat.bsky.convo.sendMessage', {
		method: 'POST',
		body: { convoId, message: { text } }
	}).catch((e) => {
		console.error('[sendMessage] failed', e);
	});
}

// -------------------------------------------------------------------------
// api.bsky.app calls via service-auth tokens
// -------------------------------------------------------------------------

/**
 * Call an api.bsky.app XRPC method as the given community, using a rookery
 * service-auth JWT scoped to the method. Mirrors `chatCall`, but for the
 * public Bluesky appview (used for notifications — the mention-based
 * submission flow lives on `app.bsky.notification.*`).
 */
async function appviewCall<T>(
	client: WelcomeMatClient,
	method: string,
	init: { method?: 'GET' | 'POST'; query?: Record<string, string | string[]>; body?: unknown }
): Promise<{ ok: boolean; status: number; data: T | { error: string; message?: string } }> {
	const httpMethod = init.method ?? 'GET';
	const token = await client.getServiceAuth(BSKY_APPVIEW_DID, method);

	const url = new URL(`${BSKY_APPVIEW_BASE}/${method}`);
	if (init.query) {
		for (const [k, v] of Object.entries(init.query)) {
			if (v === undefined) continue;
			if (Array.isArray(v)) {
				for (const item of v) url.searchParams.append(k, item);
			} else {
				url.searchParams.set(k, v);
			}
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

type NotificationView = {
	uri: string;
	cid: string;
	author: { did: string };
	reason: string;
	reasonSubject?: string;
	record: unknown;
	isRead: boolean;
	indexedAt: string;
};

async function listMentionNotifications(
	client: WelcomeMatClient
): Promise<NotificationView[]> {
	const res = await appviewCall<{ notifications: NotificationView[] }>(
		client,
		'app.bsky.notification.listNotifications',
		{ method: 'GET', query: { limit: '100', reasons: ['mention'] } }
	);
	if (!res.ok) {
		console.error(
			'[listMentionNotifications] non-ok',
			res.status,
			(res.data as { error?: string; message?: string })?.message
		);
		return [];
	}
	return (res.data as { notifications: NotificationView[] }).notifications ?? [];
}

async function updateNotificationsSeen(
	client: WelcomeMatClient,
	seenAt: string
): Promise<void> {
	const res = await appviewCall(client, 'app.bsky.notification.updateSeen', {
		method: 'POST',
		body: { seenAt }
	});
	if (!res.ok) {
		console.error(
			'[updateNotificationsSeen] non-ok',
			res.status,
			(res.data as { error?: string; message?: string })?.message
		);
	}
}

// -------------------------------------------------------------------------
// DM processing
// -------------------------------------------------------------------------

/**
 * Fetch all member DIDs of an `app.bsky.graph.list` via the public appview.
 * `app.bsky.graph.getList` is an unauthenticated endpoint that returns up
 * to 100 items per page, so we loop through cursors until exhausted.
 *
 * For the atmo use case, community allowlists are typically small, so one
 * call usually suffices. Returns an empty Set on failure (which means the
 * gated community will reject every submission — fail-closed).
 */
async function fetchListMembers(listUri: string): Promise<Set<string>> {
	const members = new Set<string>();
	let cursor: string | undefined;
	try {
		do {
			const url = new URL(`${PUBLIC_APPVIEW}/xrpc/app.bsky.graph.getList`);
			url.searchParams.set('list', listUri);
			url.searchParams.set('limit', '100');
			if (cursor) url.searchParams.set('cursor', cursor);
			const res = await fetch(url);
			if (!res.ok) {
				console.error('[fetchListMembers] non-ok response', res.status);
				return members;
			}
			const body = (await res.json()) as {
				cursor?: string;
				items?: { subject?: { did?: string } }[];
			};
			for (const item of body.items ?? []) {
				if (item.subject?.did) members.add(item.subject.did);
			}
			cursor = body.cursor;
		} while (cursor);
	} catch (e) {
		console.error('[fetchListMembers] failed', e);
	}
	return members;
}

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

	// Fetch the community's access-control config once per tick so we
	// don't hammer the PDS getRecord endpoint per DM. If the community is
	// gated, also pre-fetch the full set of allowed DIDs from the list so
	// per-sender checks below are O(1).
	const config = await fetchCommunityConfig(row.pds, row.did);
	const gated = config.whoCanSubmit === 'list' && !!config.listUri;
	const allowedMembers = gated ? await fetchListMembers(config.listUri!) : null;

	const [accepted, requested] = await Promise.all([
		listConvos(client, 'accepted'),
		listConvos(client, 'request')
	]);
	const convos = [...accepted, ...requested];

	function isAllowed(senderDid: string): boolean {
		if (!gated) return true;
		// Community creator bypasses the allowlist — they shouldn't be
		// locked out of their own community by their own list config.
		if (config.creator && config.creator === senderDid) return true;
		return allowedMembers?.has(senderDid) ?? false;
	}

	// Track convos where we've already sent a rejection message this tick
	// so a user with multiple queued messages only gets one reply.
	const notifiedRejections = new Set<string>();
	const REJECTION_MESSAGE =
		"Sorry, only members of this community's allowlist can submit posts. If you think this is a mistake, reach out to the community owner.";

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

			// Already handled? Look for our own ✅ (processed) or 🔒 (rejected)
			// reaction on this message — either one means "don't reconsider".
			const alreadyHandled = msg.reactions?.some(
				(r) =>
					(r.value === PROCESSED_REACTION || r.value === REJECTED_REACTION) &&
					r.sender?.did === row.did
			);
			if (alreadyHandled) continue;

			const submission = await parseSubmission({
				text: msg.text,
				embed: msg.embed ?? undefined
			});
			if (!submission) {
				// Mark as handled so we don't re-parse on every cron run.
				await addReaction(client, convo.id, msg.id, PROCESSED_REACTION);
				continue;
			}

			// Access control gate. Reply with a rejection message the first
			// time we see a rejected DM in a given convo this tick, then
			// mark it with 🔒 so we don't reconsider on the next run.
			if (!isAllowed(msg.sender.did)) {
				if (!notifiedRejections.has(convo.id)) {
					await sendMessage(client, convo.id, REJECTION_MESSAGE);
					notifiedRejections.add(convo.id);
				}
				await addReaction(client, convo.id, msg.id, REJECTED_REACTION);
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

/**
 * Poll mention notifications and turn each top-level mentioning post into a
 * community repost. Users can submit a post to a community by tagging that
 * community's handle in a brand-new bsky post — no DM required.
 *
 * Flow per community:
 *   1. First run (`last_mention_seen_at IS NULL`): prime the cursor by
 *      calling `updateSeen(now)` and stamping the column, then return.
 *      This makes the feature ignore all pre-existing mentions so we don't
 *      retroactively repost old tags from before the feature shipped.
 *   2. Subsequent runs: `listNotifications({ reasons: ['mention'] })`,
 *      drop anything whose `indexedAt <= cursor`, drop replies (posts with
 *      a `reply` field), drop authors blocked by the community allowlist,
 *      dedup via `hasSubmission`, then repost from the community account.
 *   3. Advance the cursor to the latest `indexedAt` observed. Also call
 *      `updateSeen` with that value so the notifications tab stays tidy.
 *
 * Mentions always become reposts (title = ""), not quote posts — the
 * mentioning post is already the "commentary," so a quote would be
 * redundant. Reuses `createSubmissionPost` so the same dedup row, metric
 * seeding, and baseline-likes logic that the DM / web-submission paths get.
 */
export async function processCommunityMentions(
	env: App.Platform['env'],
	db: D1Database,
	row: CommunityRow
): Promise<number> {
	const client = await loadClient(env, row);

	// First-run initialization: skip pre-existing mentions.
	if (row.last_mention_seen_at === null) {
		const now = new Date().toISOString();
		await updateNotificationsSeen(client, now);
		await updateCommunityMentionsSeenAt(db, row.did, now);
		return 0;
	}

	const cutoff = row.last_mention_seen_at;
	const notifications = await listMentionNotifications(client);
	if (notifications.length === 0) return 0;

	// Fetch access config once per community, matching the DM path.
	const config = await fetchCommunityConfig(row.pds, row.did);
	const gated = config.whoCanSubmit === 'list' && !!config.listUri;
	const allowedMembers = gated ? await fetchListMembers(config.listUri!) : null;

	function isAllowed(senderDid: string): boolean {
		if (!gated) return true;
		if (config.creator && config.creator === senderDid) return true;
		return allowedMembers?.has(senderDid) ?? false;
	}

	let created = 0;
	// Track the max indexedAt we observed (not just the ones we processed)
	// so notifications filtered out by reply/allowlist/dedup still advance
	// the cursor and don't get re-scanned next tick.
	let newCutoff = cutoff;

	for (const notif of notifications) {
		if (notif.indexedAt > newCutoff) newCutoff = notif.indexedAt;

		if (notif.reason !== 'mention') continue;
		if (notif.indexedAt <= cutoff) continue;

		// Only top-level posts — skip replies.
		const record = notif.record as { reply?: unknown } | null;
		if (record && record.reply) continue;

		// Must be an app.bsky.feed.post URI; notifications can point at other
		// collections in theory, and createSubmissionPost assumes a post.
		const postUri = notif.uri;
		if (
			typeof postUri !== 'string' ||
			!/^at:\/\/did:[^/]+\/app\.bsky\.feed\.post\/[A-Za-z0-9]+$/.test(postUri)
		) {
			continue;
		}

		if (!isAllowed(notif.author.did)) continue;

		// Dedup: someone may have already submitted this post via DM / web.
		if (await hasSubmission(db, row.did, postUri)) continue;

		const ok = await createSubmissionPost(
			db,
			client,
			row,
			// Empty title → repost, matching DMs-without-text semantics.
			{ title: '', postUri: postUri as ResourceUri },
			notif.author.did as Did
		);
		if (ok) created++;
	}

	// Persist the advanced cursor (if there was anything at all) and tell
	// the appview our seen-marker so the community's notifications tab
	// stays clean. Notifications that arrive after listNotifications
	// returned will have `indexedAt > newCutoff` and be picked up next
	// tick — the cursor intentionally only advances to what we observed.
	if (newCutoff !== cutoff) {
		await updateNotificationsSeen(client, newCutoff);
		await updateCommunityMentionsSeenAt(db, row.did, newCutoff);
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
	// Resolve the CID + current like count of the post being quoted. The
	// CID feeds the embed record; the like count becomes the baseline for
	// the Hot sort's community-lift calculation.
	const appview = new Client({
		handler: simpleFetchHandler({ service: PUBLIC_APPVIEW })
	});
	const quotedMeta = await getPostMeta(appview, submission.postUri);
	if (!quotedMeta) return false;
	const quotedCid = quotedMeta.cid;
	const baselineLikeCount = quotedMeta.likeCount;

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
				createdAt,
				submittedBy: senderDid
			});
		} else {
			result = await client.createRecord('app.bsky.feed.post', {
				$type: 'app.bsky.feed.post',
				text: submission.title,
				createdAt,
				embed: {
					$type: 'app.bsky.embed.record',
					record: { uri: submission.postUri, cid: quotedCid }
				},
				submittedBy: senderDid
			});

			// Lock replies on the quote post so randos can't pile on under the
			// community's submission. Threadgate records must share the rkey
			// of the post they gate; an empty `allow` array means "nobody can
			// reply". Non-fatal — the submission still counts if this fails.
			const postRkey = result.uri.split('/').pop();
			if (postRkey) {
				try {
					await client.createRecord(
						'app.bsky.feed.threadgate',
						{
							$type: 'app.bsky.feed.threadgate',
							post: result.uri,
							allow: [],
							createdAt
						},
						postRkey
					);
				} catch (e) {
					console.error('[createSubmissionPost] threadgate createRecord failed', e);
				}
			}
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
		// Seed current + baseline to the same snapshot. The cron's
		// refreshPostMetrics updates `like_count` on every tick, but
		// never touches the baseline — so community lift = current − baseline.
		like_count: baselineLikeCount,
		reply_count: 0,
		repost_count: 0,
		like_count_at_submission: baselineLikeCount,
		indexed_at: createdAt
	});
	return inserted;
}

// -------------------------------------------------------------------------
// Web submissions via garden.atmo.submission records (jetstream-driven)
// -------------------------------------------------------------------------

/**
 * Is `viewerDid` allowed to submit to this community? Reads the community's
 * `garden.atmo.community/self` record off the PDS to get the access policy;
 * for list-gated communities also fetches the allowlist members.
 *
 * The community creator is always allowed, regardless of allowlist state —
 * they registered the community and should never be locked out of their
 * own space.
 *
 * Semantics for anonymous viewers (`viewerDid === null`):
 *   - non-gated community → true
 *   - list-gated → true (optimistic — user may still be prompted to log in
 *     before the submission actually goes through). This keeps the UI from
 *     hiding the button from signed-out visitors who would otherwise be
 *     allowed once they log in.
 */
/**
 * Pure check: given an already-fetched config, is `viewerDid` allowed to
 * submit? Lets callers that already have the config (e.g. the community
 * page remote, which also needs `creator` from it) skip a second fetch.
 */
export async function checkCanSubmit(
	config: CommunityConfig,
	viewerDid: string | null
): Promise<boolean> {
	if (config.whoCanSubmit !== 'list' || !config.listUri) return true;
	if (!viewerDid) return true;
	if (config.creator && config.creator === viewerDid) return true;
	const members = await fetchListMembers(config.listUri);
	return members.has(viewerDid);
}

export async function canUserSubmit(
	pds: string,
	communityDid: string,
	viewerDid: string | null
): Promise<boolean> {
	const config = await fetchCommunityConfig(pds, communityDid);
	return checkCanSubmit(config, viewerDid);
}

/**
 * Reason a web submission was dropped. Surfaced for logging; callers don't
 * branch on these today.
 */
export type WebSubmissionResult =
	| { ok: true }
	| { ok: false; reason: 'unknown-community' | 'not-allowed' | 'duplicate' | 'failed' };

/**
 * Handle a single `garden.atmo.submission` record: look up the target
 * community, check allowlist, dedup, and create the quote/repost on the
 * community account. Mirrors the DM path in `processCommunityDms` but driven
 * by records seen on the jetstream instead of DMs.
 */
export async function processWebSubmission(
	env: App.Platform['env'],
	db: D1Database,
	input: {
		communityDid: string;
		postUri: ResourceUri;
		title: string;
		submitterDid: Did;
	}
): Promise<WebSubmissionResult> {
	const row = await getCommunityByDid(db, input.communityDid);
	if (!row) return { ok: false, reason: 'unknown-community' };

	// Access control: re-read the community config on every submission so
	// allowlist flips take effect immediately. Cheap compared to the DM path
	// because we don't have a convo loop to amortize over. The creator is
	// always allowed through, matching the UI-side check in `canUserSubmit`.
	const config = await fetchCommunityConfig(row.pds, row.did);
	if (config.whoCanSubmit === 'list' && config.listUri) {
		const isCreator = config.creator && config.creator === input.submitterDid;
		if (!isCreator) {
			const members = await fetchListMembers(config.listUri);
			if (!members.has(input.submitterDid)) {
				return { ok: false, reason: 'not-allowed' };
			}
		}
	}

	// Dedup against both the existing DM path and any prior jetstream run
	// that already processed this record.
	if (await hasSubmission(db, row.did, input.postUri)) {
		return { ok: false, reason: 'duplicate' };
	}

	const client = await loadClient(env, row);
	const ok = await createSubmissionPost(
		db,
		client,
		row,
		{ title: input.title, postUri: input.postUri },
		input.submitterDid
	);
	return ok ? { ok: true } : { ok: false, reason: 'failed' };
}

/**
 * Drain `garden.atmo.submission` commit events from the jetstream, process
 * each one, and persist the new cursor on exit. Safe to call from the cron —
 * self-bounded by `timeoutMs` and by the "caught up to present" check.
 */
export async function drainSubmissionJetstream(
	env: App.Platform['env'],
	db: D1Database,
	timeoutMs = 20_000
): Promise<{ events: number; created: number; cursor: number | null }> {
	// Dynamic import so we only pay the WebSocket startup cost when the cron
	// actually drains (and so unit tests that don't touch the jetstream can
	// still import bot.ts cleanly).
	const { JetstreamSubscription } = await import('@atcute/jetstream');

	const cursor = await getJetstreamCursor(db);
	const startTimeUs = Date.now() * 1000;
	const deadline = Date.now() + timeoutMs;

	type PendingSubmission = {
		communityDid: string;
		postUri: ResourceUri;
		title: string;
		submitterDid: Did;
	};
	const pending: PendingSubmission[] = [];

	const subscription = new JetstreamSubscription({
		url: [
			'wss://jetstream1.us-east.bsky.network/subscribe',
			'wss://jetstream2.us-east.bsky.network/subscribe',
			'wss://jetstream1.us-west.bsky.network/subscribe',
			'wss://jetstream2.us-west.bsky.network/subscribe'
		],
		wantedCollections: ['garden.atmo.submission'],
		...(cursor !== null ? { cursor } : {})
	});

	try {
		for await (const event of subscription) {
			if (event.kind === 'commit') {
				const { commit } = event;
				if (
					commit.operation === 'create' &&
					commit.collection === 'garden.atmo.submission' &&
					commit.record
				) {
					const record = commit.record as {
						post?: unknown;
						community?: unknown;
						title?: unknown;
					};
					const postUri = typeof record.post === 'string' ? record.post : null;
					const communityDid =
						typeof record.community === 'string' ? record.community : null;
					const title = typeof record.title === 'string' ? record.title : '';

					// Only accept well-formed `app.bsky.feed.post` quotes — mirror
					// the DM parser's shape so downstream code can assume a valid
					// quoted post.
					if (
						postUri &&
						communityDid &&
						/^at:\/\/did:[^/]+\/app\.bsky\.feed\.post\/[A-Za-z0-9]+$/.test(postUri)
					) {
						pending.push({
							communityDid,
							postUri: postUri as ResourceUri,
							title,
							submitterDid: event.did as Did
						});
					}
				}
			}

			if (event.time_us >= startTimeUs) break;
			if (Date.now() >= deadline) break;
		}
	} catch (e) {
		console.error('[drainSubmissionJetstream] subscription failed', e);
	}

	// Process after the stream closes so we don't hold the WebSocket open
	// while hitting rookery per submission. Failures are logged but don't
	// block cursor advancement — the dedup in `processWebSubmission` makes
	// re-processing safe in future runs anyway.
	let created = 0;
	for (const p of pending) {
		try {
			const res = await processWebSubmission(env, db, p);
			if (res.ok) created++;
			else if (res.reason === 'failed') {
				console.error('[drainSubmissionJetstream] failed submission', p);
			}
		} catch (e) {
			console.error('[drainSubmissionJetstream] processing error', e, p);
		}
	}

	const lastCursor = subscription.cursor ?? null;
	if (lastCursor !== null) {
		await saveJetstreamCursor(db, lastCursor);
	}

	return { events: pending.length, created, cursor: lastCursor };
}

// -------------------------------------------------------------------------
// Metric refresh
// -------------------------------------------------------------------------

/**
 * Refresh cached metrics on each post from the QUOTED (original) post's
 * live counts. Powers the "top" sort — the numbers the UI shows and the
 * numbers we rank by are the original Bluesky post's engagement, not the
 * community's quote/repost record.
 *
 * Shape of the tick:
 *   1. Pull up to 100 due rows from D1, round-robined across communities.
 *   2. Chunk into batches of 25 (bsky `getPosts` max) and fire them
 *      concurrently against the public appview.
 *   3. Build a single D1 batch of UPDATE statements and flush in one
 *      round-trip — far cheaper than the previous per-row await loop.
 *
 * Missing-post tracking: if a quoted post is absent from the appview
 * response (deleted, taken down, hidden) we stamp `missing_since` on
 * the row the first tick we see it, and leave it set on subsequent
 * ticks. If the post reappears (brief appview inconsistency) we clear
 * the stamp on that tick's update. `last_refreshed_at` is always
 * advanced so the normal age-bucket backoff kicks in instead of every
 * tick re-fetching the same dead URI. `sweepDeletedPosts` later in the
 * cron tick picks up rows whose `missing_since` has aged past the
 * grace period and nukes both the bsky wrapper record and the D1 row.
 *
 * Transient failures (network error, non-ok response for the whole
 * batch) leave the rows alone so the next tick retries them — in
 * particular we do NOT stamp `missing_since` from a failed batch, so
 * an appview outage can't trip the grace-period deletion path.
 */
export async function refreshPostMetrics(db: D1Database): Promise<number> {
	const due = await getPostsDueForRefresh(db, 100);
	if (due.length === 0) return 0;

	const appview = new Client({
		handler: simpleFetchHandler({ service: PUBLIC_APPVIEW })
	});

	// Split into getPosts-sized chunks (max 25 URIs per call).
	const chunks: (typeof due)[] = [];
	for (let i = 0; i < due.length; i += 25) {
		chunks.push(due.slice(i, i + 25));
	}

	type Metrics = { like_count: number; reply_count: number; repost_count: number };
	type ChunkResult = {
		batch: typeof due;
		metricsByQuoted: Map<string, Metrics> | null;
	};

	// Fire every chunk in parallel. A chunk resolving with
	// `metricsByQuoted: null` signals a transient failure — we skip its
	// rows without advancing `last_refreshed_at` so they retry next tick.
	const chunkResults: ChunkResult[] = await Promise.all(
		chunks.map(async (batch) => {
			const quotedUris = Array.from(
				new Set(batch.map((p) => p.quoted_post_uri))
			) as ResourceUri[];
			try {
				const res = await appview.get('app.bsky.feed.getPosts', {
					params: { uris: quotedUris }
				});
				if (!res.ok) {
					console.error(
						'[refreshPostMetrics] non-ok getPosts',
						quotedUris.length,
						'uris'
					);
					return { batch, metricsByQuoted: null };
				}
				const metricsByQuoted = new Map<string, Metrics>();
				for (const post of res.data.posts) {
					metricsByQuoted.set(post.uri, {
						like_count: post.likeCount ?? 0,
						reply_count: post.replyCount ?? 0,
						repost_count: post.repostCount ?? 0
					});
				}
				return { batch, metricsByQuoted };
			} catch (e) {
				console.error('[refreshPostMetrics] batch fetch failed', e);
				return { batch, metricsByQuoted: null };
			}
		})
	);

	// Build one big D1 batch of UPDATEs — both the "we got metrics"
	// (clears missing_since if set) and "quoted post is gone" (stamps
	// missing_since via COALESCE so we keep the earliest detection
	// time). D1 processes all statements in a single round-trip, so
	// 100 updates cost roughly the same as 1.
	const updateWithMetrics = db.prepare(
		'UPDATE posts SET like_count = ?, reply_count = ?, repost_count = ?, last_refreshed_at = datetime("now"), missing_since = NULL WHERE uri = ?'
	);
	const markMissing = db.prepare(
		'UPDATE posts SET last_refreshed_at = datetime("now"), missing_since = COALESCE(missing_since, datetime("now")) WHERE uri = ?'
	);

	const statements: D1PreparedStatement[] = [];
	let refreshed = 0;
	let missing = 0;

	for (const { batch, metricsByQuoted } of chunkResults) {
		if (!metricsByQuoted) continue; // transient failure — retry next tick
		for (const row of batch) {
			const m = metricsByQuoted.get(row.quoted_post_uri);
			if (m) {
				statements.push(
					updateWithMetrics.bind(m.like_count, m.reply_count, m.repost_count, row.uri)
				);
				refreshed++;
			} else {
				statements.push(markMissing.bind(row.uri));
				missing++;
			}
		}
	}

	if (statements.length > 0) {
		try {
			await db.batch(statements);
		} catch (e) {
			console.error('[refreshPostMetrics] batch update failed', e);
			return 0;
		}
	}

	if (missing > 0) {
		console.log(
			`[refreshPostMetrics] ${refreshed} refreshed, ${missing} marked missing`
		);
	}

	return refreshed;
}

// -------------------------------------------------------------------------
// Deleted-post sweep
// -------------------------------------------------------------------------

/** Parse `at://did:…/collection/rkey` into its collection + rkey parts. */
function parseCommunityRecordUri(
	uri: string
): { collection: string; rkey: string } | null {
	const m = uri.match(/^at:\/\/did:[^/]+\/([^/]+)\/([^/]+)$/);
	if (!m) return null;
	return { collection: m[1], rkey: m[2] };
}

/**
 * Best-effort delete of a community-account wrapper record (quote
 * post or repost) from the community's PDS via DPoP. For quote posts
 * (`app.bsky.feed.post`), also deletes the paired threadgate at the
 * same rkey (see `createSubmissionPost`).
 *
 * Shared between the cron's `sweepDeletedPosts` and the mod-driven
 * `removeCommunityPost` — both paths need exactly the same sequence:
 * parse URI → deleteRecord(wrapper) → deleteRecord(threadgate if
 * quote). Errors are logged but not thrown so callers can always
 * fall through to the D1-side bookkeeping; leaving a dangling wrapper
 * on bsky is the lesser evil compared to retrying forever on a row
 * that's no longer user-visible anyway.
 *
 * Returns `false` only when the URI is unparseable (caller should
 * treat the row as nominally processed and drop it from D1). Any
 * actual bsky-side failure still returns `true`.
 */
async function deleteCommunityWrapperRecord(
	client: WelcomeMatClient,
	communityHandle: string,
	uri: string,
	logPrefix: string
): Promise<boolean> {
	const parsed = parseCommunityRecordUri(uri);
	if (!parsed) {
		console.error(`[${logPrefix}] unparseable uri`, uri);
		return false;
	}
	const { collection, rkey } = parsed;

	// Delete the wrapper record (quote post or repost).
	try {
		await client.deleteRecord(collection, rkey);
	} catch (e) {
		console.error(
			`[${logPrefix}] deleteRecord(${collection}/${rkey}) on ${communityHandle} failed`,
			e
		);
		// Fall through — caller still proceeds with D1 bookkeeping.
	}

	// Quote posts carry a paired threadgate at the same rkey. Reposts
	// don't. Silent on failure — probably already gone or never existed.
	if (collection === 'app.bsky.feed.post') {
		try {
			await client.deleteRecord('app.bsky.feed.threadgate', rkey);
		} catch {
			/* non-fatal */
		}
	}

	return true;
}

/**
 * Grace period between "first tick we saw the post missing from the
 * appview" and actually deleting it. Short enough that users don't
 * stare at `(quoted post unavailable)` placeholders for long, long
 * enough to weather brief appview inconsistencies without nuking valid
 * submissions.
 */
const DELETE_GRACE_HOURS = 2;

/**
 * Per-tick cap so the sweep can't starve the rest of the cron if a
 * massive takedown wave hits. Unprocessed rows stay queued and get
 * picked up on the next tick.
 */
const SWEEP_LIMIT = 50;

/**
 * Nuke wrapper records for posts whose underlying bsky post has been
 * deleted / taken down. Refresh stamps `missing_since` the first tick
 * `getPosts` omits the quoted URI; we wait `DELETE_GRACE_HOURS` and
 * then:
 *
 *   1. Delete the community account's wrapper record from its PDS via
 *      DPoP (`app.bsky.feed.post` for quotes or `app.bsky.feed.repost`
 *      for straight boosts).
 *   2. For quote posts, also delete the paired threadgate record (same
 *      rkey, different collection).
 *   3. Delete the cached D1 row.
 *
 * Best-effort on the bsky side: if `deleteRecord` fails (network
 * blip, record already gone, broken community credentials, etc.) we
 * STILL delete the D1 row. Leaving the D1 row would mean retrying
 * forever on a row the UI no longer trusts anyway; a stale wrapper
 * record on bsky is the lesser evil and will usually get cleaned up
 * by the record being a dangling reference.
 */
export async function sweepDeletedPosts(
	env: App.Platform['env'],
	db: D1Database
): Promise<number> {
	const dueRows = await getPostsPastDeletionGrace(db, DELETE_GRACE_HOURS, SWEEP_LIMIT);
	if (dueRows.length === 0) return 0;

	// Group by community so we can `loadClient` once per community
	// instead of once per row.
	const byCommunity = new Map<string, string[]>();
	for (const r of dueRows) {
		const arr = byCommunity.get(r.community_did) ?? [];
		arr.push(r.uri);
		byCommunity.set(r.community_did, arr);
	}

	let deleted = 0;
	const drainedFromD1: string[] = [];

	for (const [communityDid, uris] of byCommunity) {
		const communityRow = await getCommunityByDid(db, communityDid);
		if (!communityRow) {
			// Community is gone (manually cleaned up, or `deleteCommunity`
			// race). Drop the stragglers from D1 with no bsky call.
			drainedFromD1.push(...uris);
			deleted += uris.length;
			continue;
		}

		let client: WelcomeMatClient;
		try {
			client = await loadClient(env, communityRow);
		} catch (e) {
			console.error(
				`[sweepDeletedPosts] loadClient failed for ${communityRow.handle}`,
				e
			);
			// Leave the rows alone — retry next tick once the failure
			// (bad creds / rookery down) hopefully clears.
			continue;
		}

		for (const uri of uris) {
			await deleteCommunityWrapperRecord(
				client,
				communityRow.handle,
				uri,
				'sweepDeletedPosts'
			);
			// Even unparseable URIs get dropped from D1 — same as the
			// pre-refactor behavior. The helper logs those with its
			// `logPrefix`, and returning `false` just signals "URI
			// parse failed." There's nothing useful the sweep can do
			// differently in that case.
			drainedFromD1.push(uri);
			deleted++;
		}
	}

	if (drainedFromD1.length > 0) {
		try {
			await deletePostsByUris(db, drainedFromD1);
		} catch (e) {
			console.error('[sweepDeletedPosts] D1 delete batch failed', e);
		}
	}

	console.log(`[sweepDeletedPosts] deleted ${deleted} rows`);
	return deleted;
}

// -------------------------------------------------------------------------
// Moderator-driven post removal
// -------------------------------------------------------------------------

/**
 * Remove a single post from a community at the direction of a
 * community moderator (currently only the creator — gate lives in
 * the `removePost` remote command in `communities.remote.ts`).
 *
 * Flow:
 *   1. Load the community's DPoP client.
 *   2. Delete the wrapper record (and threadgate for quotes) from
 *      the community account's PDS via the shared helper. Errors
 *      are logged but not fatal.
 *   3. Stamp `removed_at` on the D1 row. The soft-delete keeps the
 *      row visible to `hasSubmission` so the post can't be
 *      resubmitted via DM / mention / web while also dropping it
 *      out of every feed surface via the `removed_at IS NULL`
 *      filters in `db.ts`.
 *
 * This is orthogonal to `sweepDeletedPosts` — that path handles
 * "underlying bsky post was taken down upstream" via `missing_since`
 * and hard-deletes the D1 row after a grace period. Mod removals
 * stay in D1 forever (soft delete) on purpose: persistence gives us
 * a free audit trail and blocks resubmission indefinitely.
 */
export async function removeCommunityPost(
	env: App.Platform['env'],
	db: D1Database,
	communityRow: CommunityRow,
	postUri: string
): Promise<void> {
	const client = await loadClient(env, communityRow);
	await deleteCommunityWrapperRecord(
		client,
		communityRow.handle,
		postUri,
		'removeCommunityPost'
	);
	await markPostRemoved(db, postUri);
}

// -------------------------------------------------------------------------
// Top-level cron entry point
// -------------------------------------------------------------------------

export async function runCronTick(env: App.Platform['env']): Promise<{
	communitiesChecked: number;
	postsCreated: number;
	mentionsCreated: number;
	webSubmissionsCreated: number;
	jetstreamEvents: number;
	postsRefreshed: number;
	postsDeleted: number;
	feedCachesBuilt: number;
	errors: string[];
}> {
	const db = env.DB;
	if (!db) throw new Error('DB binding missing');

	const errors: string[] = [];
	const communities = await listCommunities(db);

	let postsCreated = 0;
	let mentionsCreated = 0;

	// Process communities in parallel batches. Each community's DM poll,
	// mention poll and profile cache refresh must stay ordered within that
	// community (they share a rookery client + touch overlapping D1 rows),
	// but different communities have disjoint accounts and state, so the
	// batch-level fan-out is safe. Cap concurrency so we don't stampede
	// rookery / api.bsky.chat / api.bsky.app with 40+ simultaneous clients.
	const COMMUNITY_CONCURRENCY = 10;
	async function runCommunity(row: CommunityRow): Promise<{
		posts: number;
		mentions: number;
	}> {
		let posts = 0;
		let mentions = 0;

		try {
			posts = await processCommunityDms(env, db, row);
		} catch (e) {
			console.error(`[cron] community ${row.handle} failed:`, e);
			errors.push(`${row.handle}: ${String(e)}`);
		}

		try {
			mentions = await processCommunityMentions(env, db, row);
		} catch (e) {
			console.error(`[cron] community ${row.handle} mentions failed:`, e);
			errors.push(`${row.handle} mentions: ${String(e)}`);
		}

		// Best-effort: refresh cached profile metadata (avatar, display name,
		// desc, follower count) from the appview + accent color from the
		// community's `garden.atmo.community/self` record.
		await refreshCommunityCache(env, row);

		return { posts, mentions };
	}

	for (let i = 0; i < communities.length; i += COMMUNITY_CONCURRENCY) {
		const batch = communities.slice(i, i + COMMUNITY_CONCURRENCY);
		const results = await Promise.all(batch.map(runCommunity));
		for (const r of results) {
			postsCreated += r.posts;
			mentionsCreated += r.mentions;
		}
	}

	// Drain the jetstream for `garden.atmo.submission` records created via the
	// website. Bounded by its own timeout so a slow stream can't starve metric
	// refresh below. Advances the persisted cursor on exit regardless of
	// processing success — dedup in `processWebSubmission` keeps replay safe.
	const jetstreamResult = await drainSubmissionJetstream(env, db).catch((e) => {
		errors.push(`jetstream: ${String(e)}`);
		return { events: 0, created: 0, cursor: null };
	});

	const postsRefreshed = await refreshPostMetrics(db).catch((e) => {
		errors.push(`refresh: ${String(e)}`);
		return 0;
	});

	// Sweep runs AFTER refresh so the same tick that stamps a new row
	// as missing never also deletes it — the grace-period check in
	// `getPostsPastDeletionGrace` guarantees this, but running the two
	// in order is clearer.
	const postsDeleted = await sweepDeletedPosts(env, db).catch((e) => {
		errors.push(`sweep: ${String(e)}`);
		return 0;
	});

	// Rebuild the materialized sorted lists + community DID list in
	// KV so both the main page (`getHomeFeed`) and the bsky feed
	// generator XRPC handler can serve feed requests without hitting
	// D1 on the hot path. Runs last so it reflects the freshest state
	// after refresh + sweep. Non-fatal: any per-sort failure just
	// leaves the previous KV entry in place (the 5 min expirationTtl
	// safety net kicks in only if the cron stops running entirely).
	const feedCachesBuilt = await rebuildFeedCaches(env, db).catch((e) => {
		errors.push(`feed-cache: ${String(e)}`);
		return 0;
	});

	return {
		communitiesChecked: communities.length,
		postsCreated,
		mentionsCreated,
		webSubmissionsCreated: jetstreamResult.created,
		jetstreamEvents: jetstreamResult.events,
		postsRefreshed,
		postsDeleted,
		feedCachesBuilt,
		errors
	};
}

// -------------------------------------------------------------------------
// Feed-cache materialization
// -------------------------------------------------------------------------

/**
 * Rebuild the KV-backed sorted lists that both the atmo.garden home
 * page and the bsky feed generator XRPC handler read from.
 *
 * Writes:
 *   - `sorted:hot`, `sorted:new`, `sorted:top-day`, `sorted:top-week`
 *     — each a JSON-serialized `PostWithCommunity[]` of up to
 *     `FEED_CACHE_LIMIT` rows from `getCombinedFeed`.
 *   - `communities:dids` — a JSON array of all known community DIDs,
 *     used by the following-feed path's `getRelationships` batch
 *     lookup.
 *
 * Runs the 4 sort queries in parallel (they're independent) so the
 * total added latency to `runCronTick` is bounded by the slowest
 * query. Returns the number of keys successfully written.
 */
async function rebuildFeedCaches(
	env: App.Platform['env'],
	db: D1Database
): Promise<number> {
	const { FEED_CACHE_LIMIT, writeSortedList, writeAllCommunityDids } =
		await import('./feed-cache');

	// All five sorts the main page exposes in its SortTabs. The bsky
	// feed generator only dispatches hot/new/top-day/top-week, but
	// materializing top-month here too costs almost nothing (~500 KB
	// of KV storage) and lets `getHomeFeed` stay on the fast path
	// across all UI sorts instead of falling back to D1 for one sort.
	const sorts = ['hot', 'new', 'top-day', 'top-week', 'top-month'] as const;
	let written = 0;

	await Promise.all([
		// Full community DID list (small, but refresh it here so the
		// following-feed path picks up newly-registered communities
		// within one cron tick).
		writeAllCommunityDids(env, db)
			.then(() => {
				written++;
			})
			.catch((e) => {
				console.error('[rebuildFeedCaches] community DIDs write failed', e);
			}),
		// Per-sort materializations.
		...sorts.map((sort) =>
			getCombinedFeed(db, FEED_CACHE_LIMIT, sort, 0)
				.then((rows) => writeSortedList(env, sort, rows))
				.then(() => {
					written++;
				})
				.catch((e) => {
					console.error(`[rebuildFeedCaches] ${sort} failed`, e);
				})
		)
	]);

	return written;
}

// Convenience re-export so routes don't need to import db.ts directly.
export { getCombinedFeed };
