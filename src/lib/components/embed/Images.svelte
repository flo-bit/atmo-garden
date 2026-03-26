<script lang="ts">
	import type { EmbedImageData } from './types';
	import Image from './Image.svelte';
	import { openLightbox } from './ImageLightbox.svelte';

	const {
		data,
		showSensitive = true
	}: {
		data: EmbedImageData;
		showSensitive?: boolean;
	} = $props();

	let revealed = $state(false);
</script>

{#if data.sensitive && showSensitive && !revealed}
	{@const firstImage = data.images[0]}
	<button
		onclick={() => (revealed = true)}
		style={firstImage?.aspectRatio
			? `aspect-ratio: ${firstImage.aspectRatio.width} / ${firstImage.aspectRatio.height}`
			: 'aspect-ratio: 1 / 1'}
		class="border-base-500/20 bg-base-200/50 text-base-600 dark:border-base-400/20 dark:bg-base-800/50 dark:text-base-400 accent:border-accent-900 flex max-h-160 w-full cursor-pointer items-center justify-center rounded-2xl border text-center text-sm"
	>
		Sensitive content, click to show.
	</button>
{:else if data.images.length === 1}
	<Image image={data.images[0]} onclick={() => openLightbox(data.images, 0)} />
{:else}
	<div class="columns-2 gap-4">
		{#each data.images as image, i (image.thumb)}
			<Image {image} onclick={() => openLightbox(data.images, i)} class="mb-4" />
		{/each}
	</div>
{/if}
