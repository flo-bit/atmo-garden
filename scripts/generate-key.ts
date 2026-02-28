import { generateClientAssertionKey } from '@atcute/oauth-node-client';

const key = await generateClientAssertionKey('main-key');
const json = JSON.stringify(key);

console.log('Generated client assertion key.\n');
console.log('Set it as a Cloudflare Workers secret:\n');
console.log('  npx wrangler secret put CLIENT_ASSERTION_KEY\n');
console.log('Then paste this value:\n');
console.log(json);
