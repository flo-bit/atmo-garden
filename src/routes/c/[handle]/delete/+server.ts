import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getCommunityByHandle, deleteCommunity } from '$lib/reddit/db';
import { deleteRookeryAccount } from '$lib/reddit/welcomemat';

const HANDLE_DOMAIN = '.atmo.garden';

/** Normalize "bob" → "bob.atmo.garden". Full handles pass through unchanged. */
function fullHandle(input: string): string {
	return input.includes('.') ? input : input + HANDLE_DOMAIN;
}

/**
 * POST /c/{handle}/delete
 *
 * Admin takedown. Gated by the `X-Rookery-Signup-Secret` header (same shared
 * secret used by /api/signup on the Rookery side). Tombstones the Rookery
 * account via /api/admin/delete-account — which tombstones the DID on the
 * PLC, deactivates the account DO, and emits a firehose event so downstream
 * appviews stop indexing its records — then drops the community's D1 rows.
 *
 * Irreversible. No user session check; this is intended for admin tooling
 * (curl with the shared secret), not a user-facing UI.
 */
export const POST: RequestHandler = async ({ request, params, platform }) => {
	const env = platform?.env;
	if (!env?.DB) error(500, 'DB binding unavailable');
	if (!env.ROOKERY_HOSTNAME) error(500, 'ROOKERY_HOSTNAME not configured');
	if (!env.ROOKERY_SIGNUP_SECRET) error(500, 'ROOKERY_SIGNUP_SECRET not configured');

	const provided = request.headers.get('x-rookery-signup-secret');
	if (!provided || provided !== env.ROOKERY_SIGNUP_SECRET) {
		error(403, 'Admin auth required');
	}

	const row = await getCommunityByHandle(env.DB, fullHandle(params.handle));
	if (!row) error(404, 'Community not found');

	// 1. Tombstone the Rookery account first. If this fails we leave the D1
	//    rows in place so the operator can retry — the community stays
	//    visible rather than becoming a ghost row pointing at a live PDS.
	try {
		await deleteRookeryAccount({
			hostname: env.ROOKERY_HOSTNAME,
			signupSecret: env.ROOKERY_SIGNUP_SECRET,
			handleOrDid: row.did
		});
	} catch (e) {
		console.error('[c/delete] rookery delete-account failed', e);
		error(502, `Rookery delete failed: ${e instanceof Error ? e.message : String(e)}`);
	}

	// 2. Drop D1 rows. Posts go first because of the FK on community_did.
	await deleteCommunity(env.DB, row.did);

	return json({ ok: true, did: row.did, handle: row.handle });
};
