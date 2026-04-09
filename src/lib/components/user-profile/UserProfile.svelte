<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Avatar, Button, cn, sanitize, Prose } from '@foxui/core';

	let { profile, class: className, children }: { profile: {
		banner?: string;
		avatar?: string;
		displayName?: string;
		handle?: string;
		description?: string;
	}, class: string; children?: Snippet } = $props();

	function linkify(text: string): string {
		// Escape HTML first
		let escaped = text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');
		// Convert newlines
		escaped = escaped.replace(/\n/g, '<br/>');
		// Linkify URLs
		escaped = escaped.replace(
			/(https?:\/\/[^\s<]+)/g,
			'<a href="$1" target="_blank" rel="noopener noreferrer nofollow">$1</a>'
		);
		// Linkify @mentions (handle format: word chars, dots, hyphens, colons)
		escaped = escaped.replace(
			/@([\w.-]+(?:\.[\w.-]+)+)/g,
			'<a href="/profile/$1">@$1</a>'
		);
		return escaped;
	}
</script>

{#if profile}
	<div class={cn("mx-auto max-w-full sm:max-w-2xl sm:py-6", className)}>
		<div>
			{#if profile.banner}
				<img
					class="aspect-3/1 w-full border-b border-base-800 object-cover sm:rounded-xl sm:border"
					src={profile.banner}
					alt=""
				/>
			{:else}
				<div class="aspect-8/1 w-full"></div>
			{/if}
		</div>
		<div
			class={cn(
				profile.banner ? '-mt-11' : '-mt-8',
				'flex max-w-full items-end space-x-5 px-4 sm:-mt-16 sm:px-6 lg:px-8'
			)}
		>
			<Avatar src={profile.avatar} class="border-base-50 dark:border-base-800 border-2 size-24 sm:size-32" />
			<div
				class="flex min-w-0 flex-1 flex-row sm:flex-row sm:items-center sm:justify-end sm:space-x-6 sm:pb-1"
			>
				<div
					class={cn(
						profile.banner ? 'mt-4 sm:mt-0' : '-mt-18 sm:-mt-26',
						'flex min-w-0 max-w-full flex-1 flex-col items-baseline'
					)}
				>
					<h1
						class="max-w-full truncate text-lg font-bold text-base-900 dark:text-base-100 sm:text-xl"
					>
						{profile.displayName || profile.handle}
					</h1>
					<div class="truncate text-xs text-base-900 dark:text-base-400 sm:text-sm">
						{profile.handle}
					</div>
				</div>
			</div>

			<!-- <Button>Follow</Button> -->
		</div>

		{#if children}
			<div class="px-4 sm:px-6 lg:px-8 pt-3">
				{@render children()}
			</div>
		{/if}

		<div class="profile-description px-4 sm:px-6 lg:px-8 py-4 text-xs sm:text-sm text-base-800 dark:text-base-200">
			{@html sanitize(linkify(profile.description ?? ''), { ADD_ATTR: ['target', 'rel'] })}
		</div>
	</div>
{/if}

<style>
	.profile-description :global(a) {
		color: var(--color-accent-600);
	}
	:global(.dark) .profile-description :global(a) {
		color: var(--color-accent-400);
	}
	.profile-description :global(a:hover) {
		text-decoration: underline;
	}
</style>
