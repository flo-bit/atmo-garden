<script lang="ts">
	import type { HTMLButtonAttributes } from 'svelte/elements';

	type Props = HTMLButtonAttributes & {
		children: () => any;
	};

	let { children, class: className, ...props }: Props = $props();
</script>

<button
	class={[
		'bg-accent-600 text-white hover:bg-accent-500 focus-visible:outline-accent-600',
		'inline-flex cursor-pointer justify-center rounded-full px-3 py-2 text-sm font-semibold shadow-sm focus-visible:outline focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
		className
	]}
	{...props}
>
	{@render children()}
</button>
