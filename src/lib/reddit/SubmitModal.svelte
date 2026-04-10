<script lang="ts">
	import { untrack } from 'svelte';
	import { Modal, Button, Input, Textarea } from '@foxui/core';
	import { Loader2 } from '@lucide/svelte';
	import { createSubmission } from '$lib/reddit/server/submissions.remote';

	type Props = {
		open?: boolean;
		community: { handle: string; did: string };
		accentColor?: string;
		onSubmitted?: () => void;
	};

	let { open = $bindable(false), community, accentColor, onSubmitted }: Props = $props();

	let title = $state('');
	let postRef = $state('');
	let submitting = $state(false);
	let errorMsg = $state<string | null>(null);
	let successMsg = $state<string | null>(null);

	const communityShort = $derived(community.handle.split('.')[0]);

	function resetForm() {
		errorMsg = null;
		successMsg = null;
		title = '';
		postRef = '';
	}

	let wasOpen = false;
	$effect(() => {
		const isOpen = open;
		if (wasOpen && !isOpen) {
			untrack(() => resetForm());
		}
		wasOpen = isOpen;
	});

	async function onSubmit() {
		if (submitting || !postRef.trim()) return;
		submitting = true;
		errorMsg = null;
		successMsg = null;
		try {
			const result = await createSubmission({
				postRef: postRef.trim(),
				communityDid: community.did,
				title: title.trim() || undefined
			});
			if (!result.processed && result.reason === 'not-allowed') {
				errorMsg = "You're not allowed to post in this community.";
				return;
			}
			successMsg = result.processed
				? 'Posted! Your submission is now in the feed.'
				: 'Submitted! Your post will appear in the feed within a minute.';
			title = '';
			postRef = '';
			onSubmitted?.();
		} catch (e: unknown) {
			const err = e as { body?: { message?: string }; message?: string; status?: number };
			const raw = err?.body?.message ?? err?.message ?? 'Failed to submit';
			if (err?.status === 401 || raw.includes('Unauthorized')) {
				errorMsg = 'Please sign in to submit posts.';
			} else {
				errorMsg = raw;
			}
		} finally {
			submitting = false;
		}
	}
</script>

<Modal bind:open class={accentColor ?? ''}>
	<h2 class="text-lg font-semibold">Posting to c/{communityShort}</h2>
	<form
		onsubmit={(e) => {
			e.preventDefault();
			onSubmit();
		}}
		class="flex flex-col gap-4"
	>
		<label class="text-sm font-medium text-base-800 dark:text-base-200" for="submit-title"
			>Title (optional)</label
		>
		<Input
			id="submit-title"
			bind:value={title}
			placeholder="Optional title — leave blank to repost"
			disabled={submitting}
			maxlength={300}
		/>
		<label class="text-sm font-medium text-base-800 dark:text-base-200" for="submit-post"
			>Bluesky post</label
		>
		<Textarea
			id="submit-post"
			bind:value={postRef}
			placeholder="https://bsky.app/profile/..."
			rows={2}
			disabled={submitting}
		/>
		<p class="text-xs text-base-500 dark:text-base-400">
			Paste a bsky.app post URL or an at:// URI.
		</p>
		{#if errorMsg}
			<p class="text-sm text-red-500">{errorMsg}</p>
		{:else if successMsg}
			<p class="text-sm text-green-600 dark:text-green-400">{successMsg}</p>
		{/if}
		<div class="flex justify-end">
			<Button
				type="submit"
				variant="primary"
				disabled={submitting || !postRef.trim()}
				class="gap-2"
			>
				{#if submitting}<Loader2 size={14} class="animate-spin" />{/if}Submit
			</Button>
		</div>
	</form>
</Modal>
