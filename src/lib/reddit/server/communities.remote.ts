import { error } from '@sveltejs/kit';
import { command, getRequestEvent } from '$app/server';
import * as v from 'valibot';
import {
	getRecentPostsForCommunity,
	getCombinedFeed,
	listCommunities,
	getCommunityByHandle,
	type CommunityRow,
	type PostRow,
	type PostWithCommunity
} from '../db';
import { registerCommunity } from '../bot';

const HANDLE_DOMAIN = '.atmo.garden';

/** Normalize "bob" → "bob.atmo.garden". Full handles pass through unchanged. */
function fullHandle(input: string): string {
	return input.includes('.') ? input : input + HANDLE_DOMAIN;
}

// Never ship encrypted key material to the client.
type PublicCommunity = Omit<
	CommunityRow,
	'secret_key_ciphertext' | 'secret_key_iv' | 'public_jwk_json' | 'thumbprint'
>;
function sanitize(row: CommunityRow): PublicCommunity {
	/* eslint-disable @typescript-eslint/no-unused-vars */
	const {
		secret_key_ciphertext,
		secret_key_iv,
		public_jwk_json,
		thumbprint,
		...rest
	} = row;
	/* eslint-enable @typescript-eslint/no-unused-vars */
	return rest;
}

export const register = command(
	v.object({
		// Short handle (single label). Rookery appends the configured domain.
		shortHandle: v.pipe(
			v.string(),
			v.regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'Must be [a-z0-9-], single label'),
			v.minLength(3),
			v.maxLength(32)
		)
	}),
	async (input) => {
		const { platform } = getRequestEvent();
		const env = platform?.env;
		if (!env || !env.DB) error(500, 'DB binding unavailable');

		try {
			const result = await registerCommunity(env, env.DB, input.shortHandle);
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
	async (input): Promise<PublicCommunity | null> => {
		const { platform } = getRequestEvent();
		const env = platform?.env;
		if (!env || !env.DB) return null;

		const row = await getCommunityByHandle(env.DB, fullHandle(input.handle));
		return row ? sanitize(row) : null;
	}
);

export const getCommunityPosts = command(
	v.object({ handle: v.string(), limit: v.optional(v.number()) }),
	async (input): Promise<PostRow[]> => {
		const { platform } = getRequestEvent();
		const env = platform?.env;
		if (!env || !env.DB) return [];

		const row = await getCommunityByHandle(env.DB, fullHandle(input.handle));
		if (!row) return [];

		return getRecentPostsForCommunity(env.DB, row.did, input.limit ?? 50);
	}
);

export const getHomeFeed = command(
	v.object({ limit: v.optional(v.number()) }),
	async (input): Promise<PostWithCommunity[]> => {
		const { platform } = getRequestEvent();
		const env = platform?.env;
		if (!env || !env.DB) return [];

		return getCombinedFeed(env.DB, input.limit ?? 50);
	}
);
