<script lang="ts">
	import type { Embed } from './types';
	import External from './External.svelte';
	import Images from './Images.svelte';
	import Video from './Video.svelte';
	import QuotedPost from './QuotedPost.svelte';
	// Special embeds (YouTube/Tenor/Atmo RSVP/Iframe/etc.) are intentionally
	// disabled here — atmo.social only renders generic External cards for
	// link previews. The special components are still in `./special` if we
	// want to opt back in later.

	const {
		embed,
		showSensitive = true
	}: {
		embed: Embed;
		showSensitive?: boolean;
	} = $props();
</script>

<div class="flex min-w-0 flex-col items-start gap-2 overflow-hidden pt-3 text-sm">
	{#if embed.type === 'images'}
		<Images data={embed} {showSensitive} />
	{:else if embed.type === 'external' && embed.external}
		<External data={embed} />
	{:else if embed.type === 'video' && embed.video}
		<Video data={embed} {showSensitive} />
	{:else if embed.type === 'record' && embed.record}
		<QuotedPost record={embed.record} />
	{:else if embed.type === 'unknown'}
		<div
			class="text-base-700 dark:text-base-300 bg-base-200/50 dark:bg-base-900/50 border-base-300 dark:border-base-600/30 rounded-2xl border p-4 text-sm"
		>
			Unsupported embed type
		</div>
	{/if}
</div>
