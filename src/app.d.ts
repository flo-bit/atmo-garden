// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { OAuthSession } from '@atcute/oauth-node-client';
import type { Client } from '@atcute/client';
import type { Did } from '@atcute/lexicons';

declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			session: OAuthSession | null;
			client: Client | null;
			did: Did | null;
		}
		// interface PageData {}
		// interface PageState {}
		interface Platform {
			env: {
				OAUTH_SESSIONS: KVNamespace;
				OAUTH_STATES: KVNamespace;
				CLIENT_ASSERTION_KEY: string;
				COOKIE_SECRET: string;
				OAUTH_PUBLIC_URL: string;
				PROFILE_CACHE?: KVNamespace;
				DB: D1Database;
				COMMUNITY_ENCRYPTION_KEY: string;
				ROOKERY_HOSTNAME: string;
				ROOKERY_SIGNUP_SECRET: string;
				CRON_SECRET?: string;
				// Optional: credentials for adding newly-registered communities
				// to the public atmo.garden discovery list. If any of these are
				// missing, registration still succeeds but skips the list-add.
				ATMO_GARDEN_PDS?: string;
				ATMO_GARDEN_IDENTIFIER?: string;
				ATMO_GARDEN_APP_PASSWORD?: string;
				ATMO_GARDEN_LIST_RKEY?: string;
			};
		}
	}
}
import type {} from '@atcute/atproto';
import type {} from '@atcute/bluesky';

export {};
