// Tombstone a rookery account on the PLC directory + deactivate it on
// rookery. IRREVERSIBLE.
//
// Usage: pnpm tsx scripts/delete-rookery-account.ts <handle-or-did>
//
//   pnpm tsx scripts/delete-rookery-account.ts alice.atmo.garden
//   pnpm tsx scripts/delete-rookery-account.ts did:plc:xxx

import { readFileSync, unlinkSync } from 'fs';

function loadEnv(path: string) {
	try {
		const text = readFileSync(path, 'utf8');
		for (const line of text.split('\n')) {
			const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
			if (!m) continue;
			let val = m[2];
			if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
			if (!process.env[m[1]]) process.env[m[1]] = val;
		}
	} catch {
		/* ignore */
	}
}
loadEnv('.env');
loadEnv('.dev.vars');

const PDS_HOSTNAME = process.env.ROOKERY_HOSTNAME ?? 'pds.atmo.garden';
const SIGNUP_SECRET = process.env.ROOKERY_SIGNUP_SECRET;

if (!SIGNUP_SECRET) {
	console.error('Missing ROOKERY_SIGNUP_SECRET in .env / .dev.vars');
	process.exit(1);
}

const target = process.argv[2];
if (!target) {
	console.error('Usage: pnpm tsx scripts/delete-rookery-account.ts <handle-or-did>');
	process.exit(1);
}

const url = `https://${PDS_HOSTNAME}/api/admin/delete-account`;
console.log(`POST ${url}`);
console.log(`  handleOrDid: ${target}`);

const res = await fetch(url, {
	method: 'POST',
	headers: {
		'Content-Type': 'application/json',
		'X-Rookery-Signup-Secret': SIGNUP_SECRET
	},
	body: JSON.stringify({ handleOrDid: target })
});

const body = await res.text();
console.log(`\nstatus: ${res.status}`);
console.log(`body: ${body}`);

if (!res.ok) {
	process.exit(1);
}

// If we have a local keyfile for this handle (short label), remove it.
const shortLabel = target.includes('.') ? target.split('.')[0] : null;
if (shortLabel) {
	const keyfile = `.rookery-accounts/${shortLabel}.json`;
	try {
		unlinkSync(keyfile);
		console.log(`\nremoved local keyfile: ${keyfile}`);
	} catch {
		/* didn't exist */
	}
}

console.log('\n✅ tombstone submitted');
console.log('   The PLC operation may take a few seconds to propagate.');
console.log(
	'   Verify: https://plc.directory/' +
		(target.startsWith('did:') ? target : '(check via resolveHandle)') +
		'/log/audit'
);
