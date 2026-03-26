<script lang="ts">
	import type { ImageData } from './types';

	const {
		image,
		onclick,
		class: className
	}: {
		image: ImageData;
		onclick?: () => void;
		class?: string;
	} = $props();

	const imgClass = $derived([
		'border-base-500/20 dark:border-base-400/20 accent:border-accent-900 max-h-96 max-w-full rounded-2xl border',
		className
	]);

	const aspectStyle = $derived(
		image.aspectRatio
			? `aspect-ratio: ${image.aspectRatio.width} / ${image.aspectRatio.height}`
			: ''
	);
</script>

{#if onclick}
	<button class="cursor-pointer" {onclick}>
		<img
			loading="lazy"
			src={image.thumb}
			alt={image.alt}
			class={imgClass}
			style={aspectStyle}
		/>
	</button>
{:else}
	<img
		loading="lazy"
		src={image.thumb}
		alt={image.alt}
		class={imgClass}
		style={aspectStyle}
	/>
{/if}
