// Parse a user-supplied list identifier into a canonical AT URI for an
// app.bsky.graph.list record. Accepts:
//
//   - at://did:plc:xxx/app.bsky.graph.list/<rkey>  (direct, unchanged)
//   - https://bsky.app/profile/<handle-or-did>/lists/<rkey>
//
// For bsky URLs that use a handle, the handle is resolved to a DID via
// the shared resolver so storage is always DID-based.

import type { Did } from '@atcute/lexicons';
import { resolveHandle } from '$lib/atproto/methods';

const AT_LIST_URI = /^at:\/\/(did:[^/\s]+)\/app\.bsky\.graph\.list\/([A-Za-z0-9._:~-]+)$/i;
const BSKY_LIST_URL =
	/^https?:\/\/bsky\.app\/profile\/([^/\s]+)\/lists\/([A-Za-z0-9._:~-]+)\/?$/i;

export async function parseListUri(input: string): Promise<string> {
	const trimmed = input.trim();
	if (!trimmed) throw new Error('List URL is empty');

	// Already an at-URI — just validate shape.
	const atMatch = trimmed.match(AT_LIST_URI);
	if (atMatch) {
		const [, did, rkey] = atMatch;
		return `at://${did}/app.bsky.graph.list/${rkey}`;
	}

	// bsky.app URL — extract handle/did + rkey.
	const urlMatch = trimmed.match(BSKY_LIST_URL);
	if (!urlMatch) {
		throw new Error(
			'Unrecognized list URL. Use an at:// URI or https://bsky.app/profile/<handle>/lists/<rkey>'
		);
	}

	const [, handleOrDid, rkey] = urlMatch;
	let did: Did;
	if (handleOrDid.startsWith('did:')) {
		did = handleOrDid as Did;
	} else {
		try {
			did = await resolveHandle({ handle: handleOrDid as `${string}.${string}` });
		} catch {
			throw new Error(`Could not resolve handle "${handleOrDid}" to a DID`);
		}
	}

	return `at://${did}/app.bsky.graph.list/${rkey}`;
}
