import { error } from '@sveltejs/kit';
import { command, getRequestEvent } from '$app/server';
import * as v from 'valibot';
import {
	getRecentPostsForCommunity,
	getCombinedFeed,
	getPostByUri,
	listCommunities,
	getCommunityByHandle,
	type CommunityRow,
	type PostWithCommunity,
	type PostSort
} from '../db';
import { canUserSubmit, registerCommunity } from '../bot';
import { parseListUri } from '../list-uri';
import {
	ACCENT_COLORS,
	DEFAULT_ACCENT_COLOR,
	isAccentColor,
	type AccentColor
} from '../accent-colors';

const HANDLE_DOMAIN = '.atmo.garden';

/** Normalize "bob" → "bob.atmo.garden". Full handles pass through unchanged. */
function fullHandle(input: string): string {
	return input.includes('.') ? input : input + HANDLE_DOMAIN;
}

// Never ship encrypted key material to the client.
type PublicCommunity = Omit<
	CommunityRow,
	| 'secret_key_ciphertext'
	| 'secret_key_iv'
	| 'public_jwk_json'
	| 'thumbprint'
	| 'accent_color'
	| 'followers_count'
> & {
	accentColor: AccentColor;
	followersCount: number;
	/** Total cached submissions in this community. Populated by
	  * listCommunities; 0 for single-row reads that don't compute it. */
	postCount: number;
};

/** PublicCommunity + viewer-specific access state. */
type CommunityWithAccess = PublicCommunity & {
	canSubmit: boolean;
};

function sanitize(row: CommunityRow & { post_count?: number }): PublicCommunity {
	/* eslint-disable @typescript-eslint/no-unused-vars */
	const {
		secret_key_ciphertext,
		secret_key_iv,
		public_jwk_json,
		thumbprint,
		accent_color,
		followers_count,
		post_count,
		...rest
	} = row;
	/* eslint-enable @typescript-eslint/no-unused-vars */
	return {
		...rest,
		accentColor: isAccentColor(accent_color) ? accent_color : DEFAULT_ACCENT_COLOR,
		followersCount: followers_count ?? 0,
		postCount: post_count ?? 0
	};
}

/** Decode a base64-encoded string into a Uint8Array (Workers-safe). */
function decodeBase64(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

// 1 MiB cap — Bluesky's profile avatar limit is ~1MB.
const MAX_AVATAR_BYTES = 1024 * 1024;
const ALLOWED_AVATAR_MIMES = ['image/jpeg', 'image/png', 'image/webp'];

export const register = command(
	v.object({
		// Short handle (single label). Rookery appends the configured domain.
		shortHandle: v.pipe(
			v.string(),
			v.regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'Must be [a-z0-9-], single label'),
			v.minLength(3),
			v.maxLength(32)
		),
		// Grapheme-accurate length check happens in registerCommunity; this
		// is just a sanity cap to reject absurdly large payloads before we
		// touch the PDS. 256 graphemes can be up to ~1024 UTF-16 code units
		// in pathological emoji-heavy strings.
		description: v.optional(v.pipe(v.string(), v.maxLength(2048))),
		accentColor: v.optional(v.picklist(ACCENT_COLORS)),
		whoCanSubmit: v.optional(v.picklist(['everyone', 'list'])),
		// Raw user input: either an at-URI or a bsky.app list URL. Parsed
		// and normalized server-side before being written to the record.
		listUrl: v.optional(v.pipe(v.string(), v.maxLength(512))),
		avatar: v.optional(
			v.object({
				// Base64-encoded image bytes (no data URL prefix).
				base64: v.pipe(v.string(), v.maxLength(2 * 1024 * 1024)),
				mimeType: v.picklist(ALLOWED_AVATAR_MIMES)
			})
		)
	}),
	async (input) => {
		const { platform, locals } = getRequestEvent();
		const env = platform?.env;
		if (!env || !env.DB) error(500, 'DB binding unavailable');
		if (!locals.did) error(401, 'You must be signed in to create a community');

		let avatarPayload: { bytes: Uint8Array; mimeType: string } | undefined;
		if (input.avatar) {
			const bytes = decodeBase64(input.avatar.base64);
			if (bytes.byteLength > MAX_AVATAR_BYTES) {
				error(400, `Avatar too large: max ${MAX_AVATAR_BYTES} bytes`);
			}
			avatarPayload = { bytes, mimeType: input.avatar.mimeType };
		}

		// Parse + normalize the optional allowlist URL into a canonical
		// at-URI. If whoCanSubmit is 'list' but no URL was given, reject.
		const whoCanSubmit = input.whoCanSubmit ?? 'everyone';
		let listUri: string | null = null;
		if (whoCanSubmit === 'list') {
			if (!input.listUrl) {
				error(400, 'List URL is required when "members of a list" is selected');
			}
			try {
				listUri = await parseListUri(input.listUrl);
			} catch (e) {
				error(400, e instanceof Error ? e.message : 'Invalid list URL');
			}
		}

		try {
			const result = await registerCommunity(env, env.DB, {
				shortHandle: input.shortHandle,
				creatorDid: locals.did,
				description: input.description,
				accentColor: input.accentColor,
				avatar: avatarPayload,
				whoCanSubmit,
				listUri
			});
			return { ok: true, did: result.did, handle: result.handle };
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error('[register]', e);
			error(400, `Registration failed: ${msg}`);
		}
	}
);

export const getCommunities = command(
	v.object({}),
	async (): Promise<PublicCommunity[]> => {
		const { platform } = getRequestEvent();
		const env = platform?.env;
		if (!env || !env.DB) return [];

		const rows = await listCommunities(env.DB);
		return rows.map(sanitize);
	}
);

export const getCommunity = command(
	v.object({ handle: v.string() }),
	async (input): Promise<CommunityWithAccess | null> => {
		const { platform, locals } = getRequestEvent();
		const env = platform?.env;
		if (!env || !env.DB) return null;

		const row = await getCommunityByHandle(env.DB, fullHandle(input.handle));
		if (!row) return null;

		// Viewer-specific: can this viewer submit to the community? Reads the
		// allowlist off the community's PDS and (if gated) checks membership.
		// Fails open — if the config fetch blows up, we don't want to hide the
		// submit button from everyone.
		const canSubmit = await canUserSubmit(row.pds, row.did, locals.did ?? null).catch(
			() => true
		);

		return { ...sanitize(row), canSubmit };
	}
);

export const getCommunityPosts = command(
	v.object({
		handle: v.string(),
		limit: v.optional(v.number()),
		offset: v.optional(v.number()),
		sort: v.optional(v.picklist(['hot', 'new', 'top-day', 'top-week', 'top-month']))
	}),
	async (input): Promise<PostWithCommunity[]> => {
		const { platform } = getRequestEvent();
		const env = platform?.env;
		if (!env || !env.DB) return [];

		const row = await getCommunityByHandle(env.DB, fullHandle(input.handle));
		if (!row) return [];

		return getRecentPostsForCommunity(
			env.DB,
			row.did,
			input.limit ?? 50,
			(input.sort ?? 'hot') as PostSort,
			input.offset ?? 0
		);
	}
);

export const getCommunityPost = command(
	v.object({ uri: v.pipe(v.string(), v.maxLength(512)) }),
	async (input): Promise<PostWithCommunity | null> => {
		const { platform } = getRequestEvent();
		const env = platform?.env;
		if (!env || !env.DB) return null;

		return getPostByUri(env.DB, input.uri);
	}
);

export const getHomeFeed = command(
	v.object({
		limit: v.optional(v.number()),
		offset: v.optional(v.number()),
		sort: v.optional(v.picklist(['hot', 'new', 'top-day', 'top-week', 'top-month']))
	}),
	async (input): Promise<PostWithCommunity[]> => {
		const { platform } = getRequestEvent();
		const env = platform?.env;
		if (!env || !env.DB) return [];

		return getCombinedFeed(
			env.DB,
			input.limit ?? 50,
			(input.sort ?? 'hot') as PostSort,
			input.offset ?? 0
		);
	}
);
