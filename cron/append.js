// Appends cron/job.js to the built SvelteKit worker so that the
// scheduled() handler ships alongside the normal fetch handler.
// Run after `vite build`.

import { appendFile, readFile } from 'fs/promises';

const job = await readFile('cron/job.js', 'utf8');
await appendFile('.svelte-kit/cloudflare/_worker.js', job, 'utf8');
console.log('[cron/append] scheduled handler appended to _worker.js');
