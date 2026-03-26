<script lang="ts">
	import { ArrowUp } from '@lucide/svelte';

	let visible = $state(false);

	function onscroll() {
		visible = window.scrollY > 800;
	}

	function scrollToTop() {
		window.scrollTo({ top: 0, behavior: 'smooth' });
	}
</script>

<svelte:window {onscroll} />

{#if visible}
	<button
		onclick={scrollToTop}
		class="fixed bottom-20 right-6 z-40 lg:bottom-6 cursor-pointer rounded-full bg-base-900/80 p-3 text-white shadow-lg backdrop-blur-sm transition-opacity hover:bg-base-900 dark:bg-base-100/80 dark:text-base-900 dark:hover:bg-base-100"
	>
		<ArrowUp size={20} />
	</button>
{/if}
