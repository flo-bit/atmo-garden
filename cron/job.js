// Appended to .svelte-kit/cloudflare/_worker.js at build time so that the
// Cloudflare Workers scheduled() lifecycle can drive the SvelteKit cron
// endpoint. See cron/append.js + wrangler.jsonc triggers.crons.

worker_default.scheduled = async (event, env, ctx) => {
	const req = new Request('https://cron.internal/_cron/check-dms', {
		method: 'POST',
		headers: { 'x-cron-internal': '1' }
	});
	ctx.waitUntil(worker_default.fetch(req, env, ctx));
};
