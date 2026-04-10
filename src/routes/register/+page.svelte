<script lang="ts">
	/* eslint-disable svelte/no-navigation-without-resolve */
	import { goto } from '$app/navigation';
	import { Button, Input, Textarea } from '@foxui/core';
	import { ColorSelect } from '@foxui/colors';
	import { Loader2, CheckCircle2, ImagePlus, X } from '@lucide/svelte';
	import { register } from '$lib/reddit/server/communities.remote';
	import { user } from '$lib/atproto/auth.svelte';
	import { loginModalState } from '$lib/LoginModal.svelte';
	import {
		countGraphemes,
		PROFILE_DESCRIPTION_MAX_GRAPHEMES
	} from '$lib/utils/graphemes';
	import { ACCENT_COLORS, DEFAULT_ACCENT_COLOR, type AccentColor } from '$lib/reddit/accent-colors';

	let shortHandle = $state('');
	let description = $state('');
	let accentColor = $state<{ class: string; label: AccentColor }>({
		class: `text-${DEFAULT_ACCENT_COLOR}-500`,
		label: DEFAULT_ACCENT_COLOR
	});
	let avatarFile = $state<File | null>(null);
	let avatarPreview = $state<string | null>(null);
	let whoCanSubmit = $state<'everyone' | 'list'>('everyone');
	let listUrl = $state('');
	let submitting = $state(false);
	let errorMsg = $state<string | null>(null);
	let success = $state<{ handle: string } | null>(null);

	const accentOptions = ACCENT_COLORS.map((label) => ({
		class: `text-${label}-500`,
		label
	}));

	// Mirrors the server-side regex `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$` by
	// normalizing as the user types: lowercase, convert spaces/dots to
	// dashes, drop anything else. Leading/trailing-dash enforcement is
	// left to server validation so the user can type freely.
	function sanitizeHandle(raw: string): string {
		return raw
			.toLowerCase()
			.replace(/[\s.]/g, '-')
			.replace(/[^a-z0-9-]/g, '');
	}

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

	const ALLOWED_AVATAR_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
	const MAX_AVATAR_BYTES = 1024 * 1024;

	function onAvatarChange(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		if (!ALLOWED_AVATAR_MIMES.has(file.type)) {
			errorMsg = 'Avatar must be a JPEG, PNG, or WebP image.';
			input.value = '';
			return;
		}
		if (file.size > MAX_AVATAR_BYTES) {
			errorMsg = `Avatar too large (${(file.size / 1024).toFixed(0)} KB). Max 1 MB.`;
			input.value = '';
			return;
		}
		errorMsg = null;
		avatarFile = file;
		avatarPreview = URL.createObjectURL(file);
	}

	function clearAvatar() {
		if (avatarPreview) URL.revokeObjectURL(avatarPreview);
		avatarFile = null;
		avatarPreview = null;
	}

	async function fileToBase64(file: File): Promise<string> {
		const buf = await file.arrayBuffer();
		const bytes = new Uint8Array(buf);
		let bin = '';
		for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
		return btoa(bin);
	}

	async function onSubmit(e: Event) {
		e.preventDefault();
		if (submitting) return;
		if (descriptionTooLong) {
			errorMsg = `Description is ${descriptionGraphemes - descriptionBudget} graphemes over the limit`;
			return;
		}
		if (whoCanSubmit === 'list' && !listUrl.trim()) {
			errorMsg = 'Please enter a list URL (or switch to "everyone").';
			return;
		}
		errorMsg = null;
		success = null;
		submitting = true;
		try {
			const trimmedDesc = description.trim();
			const avatarPayload = avatarFile
				? {
						base64: await fileToBase64(avatarFile),
						mimeType: avatarFile.type as 'image/jpeg' | 'image/png' | 'image/webp'
					}
				: undefined;
			const result = await register({
				shortHandle: shortHandle.trim(),
				...(trimmedDesc ? { description: trimmedDesc } : {}),
				accentColor: accentColor.label,
				...(avatarPayload ? { avatar: avatarPayload } : {}),
				whoCanSubmit,
				...(whoCanSubmit === 'list' ? { listUrl: listUrl.trim() } : {})
			});
			success = { handle: result.handle };
			shortHandle = '';
			description = '';
			clearAvatar();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			errorMsg = msg.replace(/^Registration failed:\s*/, '') || 'Registration failed';
		} finally {
			submitting = false;
		}
	}
</script>

<div class="mx-auto w-full max-w-md px-4 py-8 {accentColor.label}">
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
		<div class="flex items-start gap-4">
			<div class="shrink-0">
				<span class="mb-1 block text-sm font-medium">Avatar</span>
				<label class="border-base-300 dark:border-base-700 bg-base-50 dark:bg-base-900 hover:border-accent-500 relative flex size-20 cursor-pointer items-center justify-center overflow-hidden rounded-full border-2 border-dashed transition-colors">
					<input
						type="file"
						accept="image/jpeg,image/png,image/webp"
						onchange={onAvatarChange}
						disabled={submitting}
						class="sr-only"
					/>
					{#if avatarPreview}
						<img src={avatarPreview} alt="Avatar preview" class="size-full object-cover" />
					{:else}
						<ImagePlus size={24} class="text-base-400" />
					{/if}
				</label>
				{#if avatarPreview}
					<button
						type="button"
						onclick={clearAvatar}
						disabled={submitting}
						class="text-base-500 dark:text-base-400 mt-1 flex w-20 items-center justify-center gap-1 text-xs hover:underline"
					>
						<X size={12} /> Clear
					</button>
				{/if}
			</div>

			<label class="flex flex-1 flex-col gap-1">
				<span class="text-sm font-medium">Community name</span>
				<Input
					type="text"
					bind:value={shortHandle}
					oninput={() => (shortHandle = sanitizeHandle(shortHandle))}
					placeholder="cooking"
					required
					maxlength={32}
					disabled={submitting}
					sizeVariant="lg"
				/>
				<span class="text-base-500 dark:text-base-400 text-xs">
					Your handle will be <span class="font-mono">@{handlePreview}</span>.
				</span>
			</label>
		</div>

		<label class="flex flex-col gap-1">
			<span class="text-sm font-medium">Description <span class="text-base-500 dark:text-base-400 font-normal">(optional)</span></span>
			<Textarea
				bind:value={description}
				placeholder="What's this community about?"
				disabled={submitting}
				rows={3}
				sizeVariant="sm"
			/>
			<div class="flex items-start justify-between gap-2 text-xs">
				<span class="text-base-500 dark:text-base-400">
					Shown on the community page. A link back to atmo.garden is added automatically to the Bluesky profile.
				</span>
				<span class={descriptionTooLong ? 'shrink-0 text-red-500' : 'text-base-500 dark:text-base-400 shrink-0'}>
					{descriptionGraphemes}/{descriptionBudget}
				</span>
			</div>
		</label>

		<div class="flex flex-col gap-2">
			<span class="text-sm font-medium">Accent color</span>
			<ColorSelect bind:selected={accentColor} colors={accentOptions} />
		</div>

		<fieldset class="flex flex-col gap-2">
			<legend class="mb-1 text-sm font-medium">Who can post</legend>
			{#each [
				{ value: 'everyone' as const, label: 'Everyone' },
				{ value: 'list' as const, label: 'Only members of a list' }
			] as option (option.value)}
				<label class="group flex cursor-pointer items-center gap-3 text-sm">
					<input
						type="radio"
						name="whoCanSubmit"
						value={option.value}
						bind:group={whoCanSubmit}
						disabled={submitting}
						class="peer sr-only"
					/>
					<span
						aria-hidden="true"
						class="
							border-accent-500/40 bg-accent-100/60
							dark:border-accent-500/20 dark:bg-accent-950/20
							peer-checked:border-accent-500/60 peer-checked:bg-accent-200/60
							dark:peer-checked:border-accent-500/30 dark:peer-checked:bg-accent-900/40
							peer-focus-visible:outline-accent-500
							peer-disabled:cursor-not-allowed peer-disabled:opacity-50
							flex size-5 shrink-0 items-center justify-center rounded-full border backdrop-blur-lg
							transition-colors duration-100
							peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2
							before:size-2 before:rounded-full before:bg-accent-600 dark:before:bg-accent-400
							before:opacity-0 peer-checked:before:opacity-100 before:transition-opacity
							before:content-['']
						"
					></span>
					<span>{option.label}</span>
				</label>
			{/each}
			{#if whoCanSubmit === 'list'}
				<Input
					type="url"
					bind:value={listUrl}
					placeholder="https://bsky.app/profile/…/lists/…"
					disabled={submitting}
					sizeVariant="sm"
					class="mt-1"
				/>
				<span class="text-base-500 dark:text-base-400 text-xs">
					Paste a Bluesky list URL or at-URI. Only accounts on that list will be able to submit posts by DM'ing the community.
				</span>
			{/if}
		</fieldset>

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
