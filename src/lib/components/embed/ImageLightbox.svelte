<script module>
	import type { ImageData } from './types';

	export const lightboxState = $state({ open: false, images: /** @type {ImageData[]} */ ([]), index: 0 });

	export function openLightbox(images, index = 0) {
		lightboxState.images = images;
		lightboxState.index = index;
		lightboxState.open = true;
	}
</script>

<script lang="ts">
	function close() {
		lightboxState.open = false;
	}

	function onkeydown(event: KeyboardEvent) {
		if (!lightboxState.open) return;
		if (event.key === 'Escape') {
			close();
		} else if (event.key === 'ArrowRight') {
			if (lightboxState.index < lightboxState.images.length - 1) lightboxState.index++;
		} else if (event.key === 'ArrowLeft') {
			if (lightboxState.index > 0) lightboxState.index--;
		}
	}

	let image = $derived(lightboxState.images[lightboxState.index]);
</script>

<svelte:window {onkeydown} />

{#if lightboxState.open && image}
	<!-- svelte-ignore a11y_interactive_supports_focus, a11y_click_events_have_key_events -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
		onclick={close}
		role="dialog"
		aria-modal="true"
		aria-label={image.alt}
	>
		{#if lightboxState.images.length > 1 && lightboxState.index > 0}
			<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
			<div class="absolute left-4 z-10" onclick={(e) => e.stopPropagation()}>
				<button
					class="rounded-full bg-white/20 p-2 text-white backdrop-blur-sm hover:bg-white/30 cursor-pointer transition-colors"
					onclick={() => lightboxState.index--}
				>
					<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="size-6">
						<path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
					</svg>
				</button>
			</div>
		{/if}

		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
		<img
			src={image.fullsize}
			alt={image.alt}
			class="max-h-full max-w-full object-contain"
			onclick={(e) => e.stopPropagation()}
		/>

		{#if lightboxState.images.length > 1 && lightboxState.index < lightboxState.images.length - 1}
			<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
			<div class="absolute right-4 z-10" onclick={(e) => e.stopPropagation()}>
				<button
					class="rounded-full bg-white/20 p-2 text-white backdrop-blur-sm hover:bg-white/30 cursor-pointer transition-colors"
					onclick={() => lightboxState.index++}
				>
					<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="size-6">
						<path stroke-linecap="round" stroke-linejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
					</svg>
				</button>
			</div>
		{/if}

		{#if lightboxState.images.length > 1}
			<div class="absolute bottom-6 flex gap-2">
				{#each lightboxState.images as _, i}
					<div class="size-2 rounded-full {i === lightboxState.index ? 'bg-white' : 'bg-white/40'}"></div>
				{/each}
			</div>
		{/if}
	</div>
{/if}
