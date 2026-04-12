<script lang="ts">
	/* eslint-disable svelte/no-navigation-without-resolve */
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Avatar, Button, Input, Textarea } from '@foxui/core';
	import { ColorSelect } from '@foxui/colors';
	import { Loader2, ImagePlus, X, ArrowLeft } from '@lucide/svelte';
	import { getCommunity, editCommunity } from '$lib/reddit/server/communities.remote';
	import { user } from '$lib/atproto/auth.svelte';
	import { loginModalState } from '$lib/LoginModal.svelte';
	import {
		countGraphemes,
		PROFILE_DESCRIPTION_MAX_GRAPHEMES
	} from '$lib/utils/graphemes';
	import {
		ACCENT_COLORS,
		DEFAULT_ACCENT_COLOR,
		isAccentColor,
		type AccentColor
	} from '$lib/reddit/accent-colors';

	type CommunityInfo = Awaited<ReturnType<typeof getCommunity>>;

	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let community = $state<CommunityInfo>(null);

	// Form state
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

	const accentOptions = ACCENT_COLORS.map((label) => ({
		class: `text-${label}-500`,
		label
	}));

	const isCreator = $derived(!!community && !!user.did && community.creator === user.did);
	const communityShort = $derived(community?.handle.split('.')[0] ?? '');

	// Grapheme budget for the description (matches register page logic).
	const prefixGraphemes = $derived(
		countGraphemes(`https://${community?.handle ?? 'xxxx.atmo.garden'}\n\n`)
	);
	const descriptionBudget = $derived(PROFILE_DESCRIPTION_MAX_GRAPHEMES - prefixGraphemes);
	const descriptionGraphemes = $derived(countGraphemes(description));
	const descriptionTooLong = $derived(descriptionGraphemes > descriptionBudget);

	const ALLOWED_AVATAR_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
	const MAX_AVATAR_BYTES = 1024 * 1024;

	async function load(handle: string) {
		loading = true;
		loadError = null;
		try {
			const info = await getCommunity({ handle });
			if (!info) {
				loadError = 'Community not found';
				return;
			}
			community = info;
			description = info.description ?? '';
			accentColor = {
				class: `text-${info.accentColor}-500`,
				label: info.accentColor
			};
			whoCanSubmit = info.whoCanSubmit ?? 'everyone';
			// If the community has a list URI, pre-fill the input with
			// the bsky.app URL form (more user-friendly than the at-uri).
			// The server normalizes back to at-uri on save.
			if (info.listUri) {
				const m = info.listUri.match(
					/^at:\/\/(did:[^/]+)\/app\.bsky\.graph\.list\/([^/]+)$/
				);
				listUrl = m
					? `https://bsky.app/profile/${m[1]}/lists/${m[2]}`
					: info.listUri;
			} else {
				listUrl = '';
			}
		} catch (e) {
			console.error('[edit] load failed', e);
			loadError = 'Failed to load community';
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		const handle = page.params.handle;
		if (handle) untrack(() => load(handle));
	});

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
		if (submitting || !community) return;
		if (descriptionTooLong) {
			errorMsg = `Description is ${descriptionGraphemes - descriptionBudget} graphemes over the limit`;
			return;
		}
		if (whoCanSubmit === 'list' && !listUrl.trim()) {
			errorMsg = 'Please enter a list URL (or switch to "everyone").';
			return;
		}
		errorMsg = null;
		submitting = true;
		try {
			const payload: {
				handle: string;
				description?: string;
				accentColor?: AccentColor;
				avatar?: { base64: string; mimeType: 'image/jpeg' | 'image/png' | 'image/webp' };
				whoCanSubmit?: 'everyone' | 'list';
				listUrl?: string;
			} = { handle: community.handle };

			// Only send description if it changed. Empty string is a valid
			// "clear the bio" intent — the server re-prepends the atmo.garden
			// link so the profile always has at least that.
			if (description !== (community.description ?? '')) {
				payload.description = description;
			}
			if (accentColor.label !== community.accentColor) {
				payload.accentColor = accentColor.label;
			}
			if (avatarFile) {
				payload.avatar = {
					base64: await fileToBase64(avatarFile),
					mimeType: avatarFile.type as 'image/jpeg' | 'image/png' | 'image/webp'
				};
			}
			if (whoCanSubmit !== (community.whoCanSubmit ?? 'everyone')) {
				payload.whoCanSubmit = whoCanSubmit;
			}
			if (whoCanSubmit === 'list') {
				payload.listUrl = listUrl.trim();
			}

			if (
				!payload.description &&
				!payload.accentColor &&
				!payload.avatar &&
				!payload.whoCanSubmit &&
				!payload.listUrl
			) {
				errorMsg = 'Nothing changed.';
				return;
			}

			await editCommunity(payload);
			await goto(`/c/${communityShort}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			errorMsg = msg.replace(/^Update failed:\s*/, '') || 'Update failed';
		} finally {
			submitting = false;
		}
	}
</script>

<div class="mx-auto w-full max-w-md px-4 py-8 {isAccentColor(accentColor.label) ? accentColor.label : ''}">
	<button
		onclick={() => history.back()}
		class="text-base-500 hover:text-base-700 dark:text-base-400 dark:hover:text-base-200 mb-4 flex items-center gap-1 text-sm transition-colors"
	>
		<ArrowLeft size={16} />
		Back
	</button>

	<h1 class="mb-6 text-2xl font-bold">Edit community</h1>

	{#if loading}
		<div class="flex items-center justify-center py-12">
			<Loader2 class="text-base-400 animate-spin" size={28} />
		</div>
	{:else if loadError}
		<p class="text-sm text-red-500">{loadError}</p>
	{:else if !user.did}
		<div class="border-base-200 dark:border-base-800 bg-base-50 dark:bg-base-900 rounded-lg border p-4 text-sm">
			<p class="mb-3">You need to be signed in to edit a community.</p>
			<Button variant="primary" onclick={() => (loginModalState.open = true)}>
				Sign in
			</Button>
		</div>
	{:else if !community?.creator}
		<div class="rounded-lg bg-red-100 px-3 py-2 text-sm text-red-800 dark:bg-red-900/30 dark:text-red-300">
			This community was created before edits were supported. Ask an admin to update it.
		</div>
	{:else if !isCreator}
		<div class="rounded-lg bg-red-100 px-3 py-2 text-sm text-red-800 dark:bg-red-900/30 dark:text-red-300">
			Only the community creator can edit this.
		</div>
	{:else if community}
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
						{:else if community.avatar}
							<img src={community.avatar} alt="Current avatar" class="size-full object-cover" />
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
							<X size={12} /> Undo
						</button>
					{/if}
				</div>

				<div class="flex flex-1 flex-col gap-1">
					<span class="text-sm font-medium">Community</span>
					<div class="flex items-center gap-2 text-sm">
						<Avatar src={community.avatar ?? undefined} class="size-6" />
						<span class="font-mono">c/{communityShort}</span>
					</div>
					<span class="text-base-500 dark:text-base-400 text-xs">
						Handle and name can't be changed after creation.
					</span>
				</div>
			</div>

			<label class="flex flex-col gap-1">
				<span class="text-sm font-medium">Description</span>
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
						Paste a Bluesky list URL or at-URI. Only accounts on that list will be able to submit posts.
					</span>
				{/if}
			</fieldset>

			{#if errorMsg}
				<div class="rounded-lg bg-red-100 px-3 py-2 text-sm text-red-800 dark:bg-red-900/30 dark:text-red-300">
					{errorMsg}
				</div>
			{/if}

			<div class="flex items-center gap-2">
				<Button
					type="submit"
					variant="primary"
					disabled={submitting || descriptionTooLong}
					class="gap-2"
				>
					{#if submitting}
						<Loader2 size={14} class="animate-spin" />
						Saving…
					{:else}
						Save changes
					{/if}
				</Button>
				<Button
					type="button"
					variant="secondary"
					onclick={() => goto(`/c/${communityShort}`)}
					disabled={submitting}
				>
					Cancel
				</Button>
			</div>
		</form>
	{/if}
</div>
