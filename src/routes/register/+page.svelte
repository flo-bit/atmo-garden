<script lang="ts">
	/* eslint-disable svelte/no-navigation-without-resolve */
	import { goto } from '$app/navigation';
	import { Button } from '@foxui/core';
	import { Loader2, CheckCircle2 } from '@lucide/svelte';
	import { register } from '$lib/reddit/server/communities.remote';

	let identifier = $state('');
	let password = $state('');
	let submitting = $state(false);
	let errorMsg = $state<string | null>(null);
	let success = $state<{ handle: string } | null>(null);

	async function onSubmit(e: Event) {
		e.preventDefault();
		if (submitting) return;
		errorMsg = null;
		success = null;
		submitting = true;
		try {
			const result = await register({
				identifier: identifier.trim(),
				password: password.trim()
			});
			success = { handle: result.handle };
			identifier = '';
			password = '';
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			errorMsg = msg.replace(/^Registration failed:\s*/, '') || 'Registration failed';
		} finally {
			submitting = false;
		}
	}
</script>

<div class="mx-auto w-full max-w-md px-4 py-8">
	<h1 class="mb-2 text-2xl font-bold">Register a community</h1>
	<p class="text-base-500 dark:text-base-400 mb-6 text-sm">
		Use an existing Bluesky account as the community. Submissions DM'd to this account will be
		turned into quote posts automatically.
	</p>

	<form onsubmit={onSubmit} class="flex flex-col gap-4">
		<label class="flex flex-col gap-1">
			<span class="text-sm font-medium">Bluesky handle</span>
			<input
				type="text"
				bind:value={identifier}
				placeholder="cooking.bsky.social"
				required
				disabled={submitting}
				class="border-base-300 dark:border-base-700 bg-base-50 dark:bg-base-900 rounded-lg border px-3 py-2 text-sm outline-none focus:border-accent-500"
			/>
		</label>

		<label class="flex flex-col gap-1">
			<span class="text-sm font-medium">App password</span>
			<input
				type="password"
				bind:value={password}
				placeholder="xxxx-xxxx-xxxx-xxxx"
				required
				disabled={submitting}
				class="border-base-300 dark:border-base-700 bg-base-50 dark:bg-base-900 rounded-lg border px-3 py-2 text-sm outline-none focus:border-accent-500"
			/>
			<span class="text-base-500 dark:text-base-400 text-xs">
				Create one at <a href="https://bsky.app/settings/app-passwords" target="_blank" rel="noopener" class="underline">bsky.app/settings/app-passwords</a>. Needs chat access.
			</span>
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
					Registered <span class="font-semibold">@{success.handle}</span>.
					<button
						type="button"
						class="ml-1 underline"
						onclick={() => goto(`/community/${success!.handle}`)}
					>
						View community →
					</button>
				</div>
			</div>
		{/if}

		<Button type="submit" variant="primary" disabled={submitting} class="gap-2">
			{#if submitting}
				<Loader2 size={14} class="animate-spin" />
				Registering…
			{:else}
				Register community
			{/if}
		</Button>
	</form>
</div>
