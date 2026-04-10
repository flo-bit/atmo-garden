import { dev } from '$app/environment';

// OAuth scopes — narrowest set the app needs:
//   - atproto                              base scope (required)
//   - repo:app.bsky.feed.like              liking / unliking community posts
//   - repo:app.bsky.graph.follow           Join button (follow community)
//   - repo:garden.atmo.submission          user-authored submission records
//   - rpc:*?aud=did:web:api.bsky.app       proxy reads through the user's PDS
//                                          to the bsky appview (needed for
//                                          getProfile + getPosts to return
//                                          viewer state like viewer.like /
//                                          viewer.following)
//
// We deliberately do NOT request transition:generic — atmo.social only writes
// to the three collections above, and avoiding the catch-all means a more
// trustworthy consent screen for users. Note that this disables the
// IframeEmbed third-party-iframe write API in src/lib/components/embed/special/IframeEmbed.svelte.
//
// transition:chat.bsky is also dropped — all chat.bsky.convo.* calls happen
// from src/lib/reddit/bot.ts as the community account via WelcomeMat, not as
// the user via OAuth.
export const scopes = [
	'atproto',
	'repo:app.bsky.feed.like',
	'repo:app.bsky.graph.follow',
	'repo:garden.atmo.submission',
	// Needed so the atmo.rsvp iframe embed can create + delete RSVP records
	// on the viewer's repo when they RSVP to a calendar event inside a post.
	'repo:community.lexicon.calendar.rsvp',
	// Any bsky appview RPC (getProfile, getPosts, getPostThread, etc.) —
	// needed because `locals.client` proxies reads through the user's PDS.
	// Canonical form per https://atproto.com/specs/permission uses query-
	// string separators (lxm=*, not lxm:*) and requires the service fragment
	// on the aud DID. The fragment for the bsky appview is #bsky_appview,
	// URL-encoded as %23bsky_appview.
	'rpc:app.bsky.actor.getProfile?aud=*',
	'rpc:app.bsky.feed.getPosts?aud=*',
	'rpc:app.bsky.feed.getPostThread?aud=*',
	'rpc:app.bsky.feed.getAuthorFeed?aud=*'
];

// set to false to disable signup
export const ALLOW_SIGNUP = false;

// which PDS to use for signup (change to your preferred PDS)
const devPDS = 'https://pds.rip/';
const prodPDS = 'https://selfhosted.social/';
export const signUpPDS = dev ? devPDS : prodPDS;

// where to redirect after oauth login/signup
export const REDIRECT_PATH = '/oauth/callback';

// redirect the user back to the page they were on before login
export const REDIRECT_TO_LAST_PAGE_ON_LOGIN = true;

export const DOH_RESOLVER = 'https://mozilla.cloudflare-dns.com/dns-query';
