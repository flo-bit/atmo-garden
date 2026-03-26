export type {
	ImageData,
	EmbedImageData,
	EmbedExternalData,
	EmbedVideoData,
	EmbedRecord,
	EmbedRecordData,
	UnknownEmbed,
	Embed
} from './types';

export { default as EmbedImage } from './Image.svelte';
export { default as EmbedImages } from './Images.svelte';
export { default as EmbedExternal } from './External.svelte';
export { default as EmbedVideo } from './Video.svelte';
export { default as EmbedQuotedPost } from './QuotedPost.svelte';
export { default as EmbedRouter } from './Embed.svelte';

import type { Embed } from './types';

/**
 * Attaches onclick/onclickhandle callbacks to record embeds (quoted posts).
 * `navigate` is called with (handle, rkey) extracted from the quoted post's href.
 * `navigateToProfile` is called with a handle.
 */
export function wireEmbedClicks(
	embeds: Embed[],
	navigate: (handle: string, rkey: string) => void,
	navigateToProfile: (handle: string) => void
): Embed[] {
	for (const embed of embeds) {
		if (embed.type === 'record' && embed.record) {
			embed.record.onclick = (_data, href) => {
				if (href) {
					const parts = href.split('/');
					const handle = parts[parts.length - 3];
					const rkey = parts[parts.length - 1];
					navigate(handle, rkey);
				}
			};
			embed.record.onclickhandle = (handle) => navigateToProfile(handle);
			embed.record.handleHref = (handle) => `/p/${handle}`;
		}
	}
	return embeds;
}
