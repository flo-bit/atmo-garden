<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Play } from '@lucide/svelte';
	import { user } from '$lib/atproto/auth.svelte';
	import { putRecord, deleteRecord } from '$lib/atproto/server/repo.remote';
	import type { EmbedAppConfig } from './embed-registry';

	const { config, url, thumbnail }: { config: EmbedAppConfig; url: string; thumbnail?: string } = $props();

	let wrapperEl: HTMLDivElement | undefined = $state(undefined);
	let iframeEl: HTMLIFrameElement | undefined = $state(undefined);
	let activated = $state(!config.requireClick);
	let embedSrc = $state('');

	const ACCENT_COLORS = [
		'red',
		'orange',
		'amber',
		'yellow',
		'lime',
		'green',
		'emerald',
		'teal',
		'cyan',
		'sky',
		'blue',
		'indigo',
		'violet',
		'purple',
		'fuchsia',
		'pink',
		'rose'
	];

	/** Walk up the DOM from `el` looking for an ancestor that has one of
	  * the tailwind accent color classes (set on each community's card /
	  * page wrapper by RedditPostCard + the community layout). */
	function findAncestorAccent(el: HTMLElement | null | undefined): string | null {
		let current: HTMLElement | null = el ?? null;
		while (current) {
			for (const color of ACCENT_COLORS) {
				if (current.classList.contains(color)) return color;
			}
			current = current.parentElement;
		}
		return null;
	}

	// Build embed URL with theme + auth params. `base` is hardcoded to
	// `neutral` so embeds read cleanly inside our rounded-card frame
	// regardless of whatever base palette the host page uses. `accent`
	// comes from the nearest ancestor element that carries a community
	// accent class — so an atmo.rsvp embed inside a blue community
	// renders with blue controls, inside a pink community renders pink.
	function buildEmbedUrl(): string {
		const embedUrl = new URL(config.embedUrl(url));
		const accent = findAncestorAccent(wrapperEl) ?? 'pink';
		const dark = document.documentElement.classList.contains('dark');

		embedUrl.searchParams.set('base', 'neutral');
		embedUrl.searchParams.set('accent', accent);
		embedUrl.searchParams.set('dark', dark ? '1' : '0');

		if (user.did) {
			embedUrl.searchParams.set('did', user.did);
		}

		return embedUrl.toString();
	}

	// Handle postMessage from the iframe
	async function handleMessage(event: MessageEvent) {
		try {
			const origin = new URL(event.origin);
			if (!origin.hostname.endsWith(config.domain) && origin.hostname !== config.domain) {
				return;
			}
		} catch {
			return;
		}

		const { type, id, ...payload } = event.data ?? {};
		if (!type || !id) return;

		try {
			let result: unknown;

			if (type === 'createRecord') {
				if (!config.allowedCollections.includes(payload.collection)) {
					sendResponse(id, null, `Collection '${payload.collection}' is not allowed for this embed`);
					return;
				}
				result = await putRecord({
					collection: payload.collection,
					rkey: payload.rkey,
					record: payload.record
				});
			} else if (type === 'deleteRecord') {
				if (!config.allowedCollections.includes(payload.collection)) {
					sendResponse(id, null, `Collection '${payload.collection}' is not allowed for this embed`);
					return;
				}
				result = await deleteRecord({
					collection: payload.collection,
					rkey: payload.rkey
				});
			} else {
				return;
			}

			sendResponse(id, result, null);
		} catch (e) {
			sendResponse(id, null, String(e));
		}
	}

	function sendResponse(id: string, result: unknown, error: string | null) {
		iframeEl?.contentWindow?.postMessage(
			{ type: 'response', id, result, error },
			new URL(config.embedUrl(url)).origin
		);
	}

	onMount(() => {
		window.addEventListener('message', handleMessage);
		// If this embed auto-loads (no click-to-load overlay), compute the
		// embed URL now — `wrapperEl` is bound by the time onMount fires,
		// so findAncestorAccent() can walk the DOM for the community class.
		if (!config.requireClick) {
			embedSrc = buildEmbedUrl();
		}
	});

	onDestroy(() => {
		window.removeEventListener('message', handleMessage);
	});

	function onActivate() {
		activated = true;
		embedSrc = buildEmbedUrl();
	}
</script>

<div
	bind:this={wrapperEl}
	class="border-base-300 dark:border-base-600/30 relative w-full overflow-hidden rounded-2xl border"
	style="aspect-ratio: {config.aspectRatio.width} / {config.aspectRatio.height}"
>
	{#if activated}
		<iframe
			bind:this={iframeEl}
			src={embedSrc}
			title="Embedded content from {config.domain}"
			class="h-full w-full border-0"
			sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
			loading="lazy"
		></iframe>
	{:else}
		<button
			class="bg-base-200 dark:bg-base-800 relative flex h-full w-full cursor-pointer flex-col items-center justify-center gap-2 overflow-hidden transition-colors hover:brightness-110"
			onclick={onActivate}
		>
			{#if thumbnail}
				<img src={thumbnail} alt="" class="absolute inset-0 h-full w-full object-cover" />
				<div class="absolute inset-0 bg-black/40"></div>
			{/if}
			<div class="relative z-10 rounded-full bg-black/50 p-3 backdrop-blur-sm">
				<Play size={24} class="text-white" />
			</div>
			<span class="relative z-10 text-sm font-medium text-white drop-shadow">
				{config.label ?? `Load content from ${config.domain}`}
			</span>
		</button>
	{/if}
</div>
