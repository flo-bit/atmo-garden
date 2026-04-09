import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),

	kit: {
		adapter: adapter({
			// Expose wrangler.jsonc bindings (D1, KV, vars) as platform.env
			// during `vite dev`. See
			// https://svelte.dev/docs/kit/adapter-cloudflare#Bindings
			platformProxy: {
				configPath: 'wrangler.jsonc',
				persist: true
			}
		}),
		experimental: {
			remoteFunctions: true
		}
	}
};

export default config;
