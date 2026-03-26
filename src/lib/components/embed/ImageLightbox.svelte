<script module lang="ts">
	import type { ImageData } from './types';

	export const lightboxState = $state<{ open: boolean; images: ImageData[]; index: number }>({ open: false, images: [], index: 0 });

	export function openLightbox(images: ImageData[], index = 0) {
		lightboxState.images = images;
		lightboxState.index = index;
		lightboxState.open = true;
	}
</script>

<script lang="ts">
	function close() {
		lightboxState.open = false;
	}

	async function download() {
		const img = lightboxState.images[lightboxState.index];
		if (!img?.fullsize) return;
		try {
			const res = await fetch(img.fullsize);
			const blob = await res.blob();
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `image-${lightboxState.index + 1}.jpg`;
			a.click();
			URL.revokeObjectURL(url);
		} catch {
			// Fallback: open in new tab
			window.open(img.fullsize, '_blank');
		}
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
		<!-- Top bar: close and download -->
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
		<div class="absolute top-4 right-4 z-10 flex gap-2" onclick={(e) => e.stopPropagation()}>
			<button
				class="rounded-full bg-white/20 p-2 text-white backdrop-blur-sm hover:bg-white/30 cursor-pointer transition-colors"
				onclick={download}
				aria-label="Download image"
			>
				<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="size-5">
					<path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
				</svg>
			</button>
			<button
				class="rounded-full bg-white/20 p-2 text-white backdrop-blur-sm hover:bg-white/30 cursor-pointer transition-colors"
				onclick={close}
				aria-label="Close"
			>
				<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="size-5">
					<path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
				</svg>
			</button>
		</div>

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

		<img
			src={image.fullsize}
			alt={image.alt}
			class="h-full w-full object-contain"
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
