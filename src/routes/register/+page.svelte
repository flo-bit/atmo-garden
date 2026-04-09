<script lang="ts">
	/* eslint-disable svelte/no-navigation-without-resolve */
	import { goto } from '$app/navigation';
	import { Button } from '@foxui/core';
	import { Loader2, CheckCircle2 } from '@lucide/svelte';
	import { register } from '$lib/reddit/server/communities.remote';
	import { user } from '$lib/atproto/auth.svelte';
	import { loginModalState } from '$lib/LoginModal.svelte';
	import {
		countGraphemes,
		PROFILE_DESCRIPTION_MAX_GRAPHEMES
	} from '$lib/utils/graphemes';

	let shortHandle = $state('');
	let description = $state('');
	let submitting = $state(false);
	let errorMsg = $state<string | null>(null);
	let success = $state<{ handle: string } | null>(null);

	const handlePreview = $derived(
		shortHandle ? `${shortHandle}.atmo.garden` : 'yourname.atmo.garden'
	);

	// The on-network Bluesky profile description is
	// `https://<handle>\n\n<user desc>`. Bluesky caps the whole field at
	// 256 graphemes, so the budget for the user's text shrinks with longer
	// handles. Use a placeholder handle while the field is empty so the
	// counter is always meaningful.
	const prefixGraphemes = $derived(
		countGraphemes(`https://${shortHandle || 'xxxx'}.atmo.garden\n\n`)
	);
	const descriptionBudget = $derived(
		PROFILE_DESCRIPTION_MAX_GRAPHEMES - prefixGraphemes
	);
	const descriptionGraphemes = $derived(countGraphemes(description));
	const descriptionTooLong = $derived(descriptionGraphemes > descriptionBudget);

	async function onSubmit(e: Event) {
		e.preventDefault();
		if (submitting) return;
		if (descriptionTooLong) {
			errorMsg = `Description is ${descriptionGraphemes - descriptionBudget} graphemes over the limit`;
			return;
		}
		errorMsg = null;
		success = null;
		submitting = true;
		try {
			const trimmedDesc = description.trim();
			const result = await register({
				shortHandle: shortHandle.trim(),
				...(trimmedDesc ? { description: trimmedDesc } : {})
			});
			success = { handle: result.handle };
			shortHandle = '';
			description = '';
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			errorMsg = msg.replace(/^Registration failed:\s*/, '') || 'Registration failed';
		} finally {
			submitting = false;
		}
	}
</script>

<div class="mx-auto w-full max-w-md px-4 py-8">
	<h1 class="mb-2 text-2xl font-bold">Create a community</h1>
	<p class="text-base-500 dark:text-base-400 mb-6 text-sm">
		Pick a name. We'll create a new Bluesky account for your community on <code class="text-xs">pds.atmo.garden</code> and set it up so people can submit posts by DM'ing it a link.
	</p>

	{#if !user.did}
		<div class="border-base-200 dark:border-base-800 bg-base-50 dark:bg-base-900 rounded-lg border p-4 text-sm">
			<p class="mb-3">You need to be signed in with Bluesky to create a community.</p>
			<Button variant="primary" onclick={() => (loginModalState.open = true)}>
				Sign in
			</Button>
		</div>
	{:else}
	<form onsubmit={onSubmit} class="flex flex-col gap-4">
		<label class="flex flex-col gap-1">
			<span class="text-sm font-medium">Community name</span>
			<input
				type="text"
				bind:value={shortHandle}
				placeholder="cooking"
				required
				disabled={submitting}
				class="border-base-300 dark:border-base-700 bg-base-50 dark:bg-base-900 focus:border-accent-500 rounded-lg border px-3 py-2 text-sm outline-none"
			/>
			<span class="text-base-500 dark:text-base-400 text-xs">
				Lowercase letters, digits, and dashes. Your handle will be <span class="font-mono">@{handlePreview}</span>.
			</span>
		</label>

		<label class="flex flex-col gap-1">
			<span class="text-sm font-medium">Description <span class="text-base-500 dark:text-base-400 font-normal">(optional)</span></span>
			<textarea
				bind:value={description}
				placeholder="What's this community about?"
				disabled={submitting}
				rows="3"
				class="border-base-300 dark:border-base-700 bg-base-50 dark:bg-base-900 focus:border-accent-500 resize-none rounded-lg border px-3 py-2 text-sm outline-none"
			></textarea>
			<div class="flex items-start justify-between gap-2 text-xs">
				<span class="text-base-500 dark:text-base-400">
					Shown on the community page. A link back to atmo.garden is added automatically to the Bluesky profile.
				</span>
				<span class={descriptionTooLong ? 'shrink-0 text-red-500' : 'text-base-500 dark:text-base-400 shrink-0'}>
					{descriptionGraphemes}/{descriptionBudget}
				</span>
			</div>
		</label>

		{#if errorMsg}
			<div class="rounded-lg bg-red-100 px-3 py-2 text-sm text-red-800 dark:bg-red-900/30 dark:text-red-300">
				{errorMsg}
			</div>
		{/if}

		{#if success}
			<div class="flex items-start gap-2 rounded-lg bg-green-100 px-3 py-2 text-sm text-green-800 dark:bg-green-900/30 dark:text-green-300">
				<CheckCircle2 size={16} class="mt-0.5 shrink-0" />
				<div>
					Community <span class="font-semibold">@{success.handle}</span> is ready.
					<button
						type="button"
						class="ml-1 underline"
						onclick={() => success && goto(`/c/${success.handle.split('.')[0]}`)}
					>
						View community →
					</button>
				</div>
			</div>
		{/if}

		<Button
			type="submit"
			variant="primary"
			disabled={submitting || descriptionTooLong || !shortHandle.trim()}
			class="gap-2"
		>
			{#if submitting}
				<Loader2 size={14} class="animate-spin" />
				Creating…
			{:else}
				Create community
			{/if}
		</Button>
	</form>
	{/if}
</div>
