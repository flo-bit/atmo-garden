<script lang="ts">
	import type { EmbedExternalData } from '../types';
	import type { EmbedAppConfig } from './embed-registry';
	import IframeEmbed from './IframeEmbed.svelte';

	const { data, config }: { data: EmbedExternalData; config?: EmbedAppConfig } = $props();
</script>

{#if config}
	<IframeEmbed {config} url={data.external.href} />
{/if}
