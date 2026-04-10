import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getCommunityByHandle } from '$lib/reddit/db';
import { updateCommunity } from '$lib/reddit/bot';
import { ACCENT_COLORS, isAccentColor } from '$lib/reddit/accent-colors';

const HANDLE_DOMAIN = '.atmo.garden';
const ALLOWED_AVATAR_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_AVATAR_BYTES = 1024 * 1024;

function fullHandle(input: string): string {
	return input.includes('.') ? input : input + HANDLE_DOMAIN;
}

function decodeBase64(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/**
 * POST /c/{handle}/update
 *
 * Admin-only update of a community's avatar / description / accent color.
 * Gated by the `X-Rookery-Signup-Secret` header (same shared secret used by
 * the delete endpoint and by /api/signup on the Rookery side). No session
 * auth — intended for curl-style admin tooling.
 *
 * Body (application/json, all fields optional):
 *   {
 *     "avatar": { "base64": "<image-bytes-b64>", "mimeType": "image/jpeg" },
 *     "description": "new bio text",
 *     "accentColor": "blue"
 *   }
 */
export const POST: RequestHandler = async ({ request, params, platform }) => {
	const env = platform?.env;
	if (!env?.DB) error(500, 'DB binding unavailable');
	if (!env.ROOKERY_SIGNUP_SECRET) error(500, 'ROOKERY_SIGNUP_SECRET not configured');

	const provided = request.headers.get('x-rookery-signup-secret');
	if (!provided || provided !== env.ROOKERY_SIGNUP_SECRET) {
		error(403, 'Admin auth required');
	}

	let body: {
		avatar?: { base64?: string; mimeType?: string };
		description?: string;
		accentColor?: string;
	};
	try {
		body = await request.json();
	} catch {
		error(400, 'Invalid JSON body');
	}

	const row = await getCommunityByHandle(env.DB, fullHandle(params.handle));
	if (!row) error(404, 'Community not found');

	// Validate + decode avatar if present.
	let avatarPayload: { bytes: Uint8Array; mimeType: string } | undefined;
	if (body.avatar) {
		if (!body.avatar.base64 || !body.avatar.mimeType) {
			error(400, 'avatar requires base64 and mimeType');
		}
		if (!ALLOWED_AVATAR_MIMES.has(body.avatar.mimeType)) {
			error(400, `Unsupported mime type: ${body.avatar.mimeType}`);
		}
		const bytes = decodeBase64(body.avatar.base64);
		if (bytes.byteLength > MAX_AVATAR_BYTES) {
			error(400, `Avatar too large: max ${MAX_AVATAR_BYTES} bytes`);
		}
		avatarPayload = { bytes, mimeType: body.avatar.mimeType };
	}

	// Validate accent color.
	if (body.accentColor !== undefined && !isAccentColor(body.accentColor)) {
		error(400, `Invalid accentColor. Allowed: ${ACCENT_COLORS.join(', ')}`);
	}

	if (!avatarPayload && body.description === undefined && body.accentColor === undefined) {
		error(400, 'No fields to update (provide avatar, description, and/or accentColor)');
	}

	try {
		await updateCommunity(env, row, {
			avatar: avatarPayload,
			description: body.description,
			accentColor: body.accentColor
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.error('[c/update] failed', e);
		error(500, `Update failed: ${msg}`);
	}

	return json({ ok: true, did: row.did, handle: row.handle });
};
