/**
 * Count graphemes (user-perceived characters) in a string using Intl.Segmenter.
 * Emojis, combining marks, and surrogate pairs all count as 1.
 *
 * This matches how Bluesky enforces its profile / post length limits.
 */
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function countGraphemes(s: string): number {
	return Array.from(graphemeSegmenter.segment(s)).length;
}

/**
 * Maximum graphemes allowed in an `app.bsky.actor.profile` description
 * per the Bluesky lexicon. Exceeding this causes `putRecord` to fail.
 */
export const PROFILE_DESCRIPTION_MAX_GRAPHEMES = 256;
