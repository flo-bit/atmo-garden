<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from '@foxui/core';
	import { CalendarCheck, CalendarX } from '@lucide/svelte';
	import { user } from '$lib/atproto/auth.svelte';
	import { createRsvp, deleteRsvp } from '$lib/atproto/server/feed.remote';

	const { url }: { url: string } = $props();

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let event = $state<any>(null);
	let loading = $state(true);
	let rsvpLoading = $state(false);

	// Current user's RSVP state
	let myRsvpUri = $state<string | null>(null);
	let isRsvpd = $derived(myRsvpUri !== null);

	// Local count adjustments
	let goingDelta = $state(0);

	onMount(async () => {
		try {
			const res = await fetch(`${url}/data.json`);
			if (res.ok) {
				event = await res.json();
				findMyRsvp();
			}
		} catch {
			// silent
		} finally {
			loading = false;
		}
	});

	function findMyRsvp() {
		if (!user.did || !event?.rsvps) return;
		// Check all RSVP status categories
		for (const statusKey of Object.keys(event.rsvps)) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const rsvp = event.rsvps[statusKey]?.find((r: any) => r.did === user.did);
			if (rsvp) {
				myRsvpUri = rsvp.uri;
				return;
			}
		}
	}

	async function toggleRsvp() {
		if (!event?.record || rsvpLoading) return;
		rsvpLoading = true;
		try {
			if (isRsvpd) {
				await deleteRsvp({ rsvpUri: myRsvpUri! });
				myRsvpUri = null;
				goingDelta--;
			} else {
				const result = await createRsvp({
					eventUri: event.uri,
					eventCid: event.cid
				});
				myRsvpUri = result.uri;
				goingDelta++;
			}
		} catch (e) {
			console.error('Failed to toggle RSVP:', e);
		} finally {
			rsvpLoading = false;
		}
	}

	function formatDate(dateStr: string): string {
		const d = new Date(dateStr);
		return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
	}

	function formatTime(dateStr: string): string {
		return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	function getThumbnail(): string | null {
		if (!event?.record?.media) return null;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const thumb = event.record.media.find((m: any) => m.role === 'thumbnail');
		if (!thumb?.content?.ref?.$link) return null;
		return `https://cdn.bsky.app/img/avatar/plain/${event.did}/${thumb.content.ref.$link}@jpeg`;
	}
</script>

{#if loading}
	<div class="border-base-300 dark:border-base-600/30 bg-base-200/50 dark:bg-base-800/50 flex h-24 items-center justify-center rounded-2xl border">
		<div class="text-base-400 animate-pulse text-sm">Loading event...</div>
	</div>
{:else if event?.record}
	<div class="border-base-300 dark:border-base-600/30 bg-base-200/50 dark:bg-base-800/50 overflow-hidden rounded-2xl border">
		<a
			href={url}
			target="_blank"
			rel="noopener noreferrer"
			class="hover:bg-base-200 dark:hover:bg-base-800 flex items-center gap-4 p-4 transition-colors"
		>
			{#if getThumbnail()}
				<img src={getThumbnail()} alt="" class="size-18 shrink-0 rounded-xl object-cover" />
			{/if}
			<div class="min-w-0 flex-1">
				<h3 class="text-base-900 dark:text-base-100 line-clamp-2 text-lg font-bold leading-tight">
					{event.record.name}
				</h3>
				<div class="text-base-500 dark:text-base-400 mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
					{#if event.record.startsAt}
						<span>{formatDate(event.record.startsAt)}, {formatTime(event.record.startsAt)}</span>
					{/if}
					{#if (event.rsvpsGoingCount + goingDelta) > 0 || event.rsvpsInterestedCount > 0}
						<span>{event.rsvpsGoingCount + goingDelta} going, {event.rsvpsInterestedCount} interested</span>
					{/if}
				</div>
			</div>
		</a>
		{#if user.did}
			<div class="border-base-300/50 dark:border-base-600/20 border-t px-4 py-2.5">
				<Button
					variant={isRsvpd ? 'secondary' : 'primary'}
					size="sm"
					onclick={toggleRsvp}
					disabled={rsvpLoading}
					class="w-full gap-1.5"
				>
					{#if isRsvpd}
						<CalendarX size={14} />
						Cancel RSVP
					{:else}
						<CalendarCheck size={14} />
						RSVP Going
					{/if}
				</Button>
			</div>
		{/if}
	</div>
{/if}
