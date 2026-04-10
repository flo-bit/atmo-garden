<script lang="ts" module>
	export type PlyrEmbed = {
		src: string;
		kind: 'track' | 'collection';
	};

	/**
	 * Parse a plyr.fm URL into its canonical embed form + size category.
	 *
	 *   https://plyr.fm/track/595                          → track  /embed/track/595
	 *   https://plyr.fm/embed/track/56                     → track  /embed/track/56
	 *   https://plyr.fm/playlist/abc-def                   → collection /embed/playlist/abc-def
	 *   https://plyr.fm/u/handle/album/slug                → collection /embed/album/handle/slug
	 *   https://plyr.fm/embed/album/handle/slug            → collection /embed/album/handle/slug
	 *
	 * Returns null for anything else on plyr.fm.
	 */
	export function toPlyrEmbed(href: string): PlyrEmbed | null {
		// Track
		const trackMatch = href.match(/plyr\.fm\/(?:embed\/)?track\/(\d+)/);
		if (trackMatch) {
			return { src: `https://plyr.fm/embed/track/${trackMatch[1]}`, kind: 'track' };
		}

		// Playlist
		const playlistMatch = href.match(/plyr\.fm\/(?:embed\/)?playlist\/([a-f0-9-]+)/i);
		if (playlistMatch) {
			return {
				src: `https://plyr.fm/embed/playlist/${playlistMatch[1]}`,
				kind: 'collection'
			};
		}

		// Album via /embed/album/handle/slug
		const albumEmbed = href.match(/plyr\.fm\/embed\/album\/([^/?#]+)\/([^/?#]+)/);
		if (albumEmbed) {
			return {
				src: `https://plyr.fm/embed/album/${albumEmbed[1]}/${albumEmbed[2]}`,
				kind: 'collection'
			};
		}

		// Album via the canonical /u/handle/album/slug URL
		const albumPage = href.match(/plyr\.fm\/u\/([^/?#]+)\/album\/([^/?#]+)/);
		if (albumPage) {
			return {
				src: `https://plyr.fm/embed/album/${albumPage[1]}/${albumPage[2]}`,
				kind: 'collection'
			};
		}

		return null;
	}
</script>

<script lang="ts">
	import type { EmbedExternalData } from '../types';

	const { data }: { data: EmbedExternalData } = $props();

	const embed = $derived(toPlyrEmbed(data.external.href));
</script>

{#if embed}
	<div class="w-full overflow-hidden rounded-2xl border border-base-300 dark:border-base-600/30">
		<iframe
			src={embed.src}
			title={data.external.title ?? 'Plyr.fm'}
			class="w-full {embed.kind === 'track' ? 'h-40' : 'h-[500px]'}"
			frameborder="0"
			allow="autoplay; encrypted-media"
			loading="lazy"
		></iframe>
	</div>
{/if}
