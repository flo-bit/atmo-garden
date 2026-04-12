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
				/**
				 * KV namespace holding the materialized sorted feed lists
				 * (`sorted:<sort>` keys, one per PostSort). The cron tick
				 * rewrites these once per minute from `getCombinedFeed`,
				 * and both `getHomeFeed` (main page) and the bsky feed
				 * generator XRPC handler read from them through
				 * `src/lib/reddit/feed-cache.ts`.
				 */
				FEEDS_CACHE: KVNamespace;
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
				/**
				 * at-uri of the single bsky post emitted as the first entry
				 * in following-* feeds when the viewer follows zero atmo
				 * communities. Created once via
				 * `scripts/create-placeholder-post.ts`. Empty string disables
				 * the placeholder and the feed falls back to the all-<sort>
				 * contents.
				 */
				FOLLOWING_FEED_PLACEHOLDER_URI?: string;
			};
		}
	}
}
import type {} from '@atcute/atproto';
import type {} from '@atcute/bluesky';

export {};
