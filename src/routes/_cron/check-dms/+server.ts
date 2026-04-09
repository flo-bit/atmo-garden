// Cron target: checks DMs for all communities, creates quote posts, and
// refreshes post metrics. Called by the Cloudflare Workers scheduled handler
// (see cron/job.js + cron/append.js). Can also be invoked manually for
// debugging via GET/POST with ?secret=... when CRON_SECRET is set.

import type { RequestHandler } from './$types';
import { json, error } from '@sveltejs/kit';
import { runCronTick } from '$lib/reddit/bot';

async function handle(request: Request, platform: App.Platform | undefined) {
	const env = platform?.env;
	if (!env) error(500, 'Platform env unavailable');

	// Optional shared-secret guard for external invocation. The scheduled
	// handler doesn't send a secret, but its Request is constructed internally
	// so we trust it unconditionally when there's no Authorization header at
	// all AND the request came from cron (see below for a better check).
	//
	// Simpler: only enforce the secret when CRON_SECRET is configured AND the
	// request carries any secret param at all — the scheduled handler calls us
	// without one.
	if (env.CRON_SECRET) {
		const url = new URL(request.url);
		const provided = url.searchParams.get('secret') ?? request.headers.get('x-cron-secret');
		const isScheduled = url.pathname === '/_cron/check-dms' && !provided && request.headers.get('x-cron-internal') === '1';
		if (!isScheduled && provided !== env.CRON_SECRET) {
			error(401, 'Unauthorized');
		}
	}

	const result = await runCronTick(env);
	return json(result);
}

export const GET: RequestHandler = async ({ request, platform }) => handle(request, platform);
export const POST: RequestHandler = async ({ request, platform }) => handle(request, platform);
