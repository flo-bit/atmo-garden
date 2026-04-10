<script lang="ts">
	import { cn, sanitize, Avatar } from '@foxui/core';
	import type { WithElementRef } from 'bits-ui';
	import type { HTMLAttributes } from 'svelte/elements';
	import type { PostProps } from './types';
	import Embed from '../embed/Embed.svelte';
	import PostHeader from './PostHeader.svelte';
	import { ActionButtons } from '../action-buttons';

	let {
		ref = $bindable(),
		data,
		class: className,

		embeds,
		showSensitive = true,

		actions,

		href,
		onclickhandle,
		handleHref,
		onclickavatar,

		timestamp,

		children,

		logo,

		showAvatar = true,
		compact = false,
		target = '_blank',
		extraEmbeds
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & PostProps = $props();
</script>

<div
	bind:this={ref}
	class={cn('text-base-950 dark:text-base-50 relative min-w-0 transition-colors duration-200', className)}
>
	{#if href}
		<a {href} class="absolute inset-0 z-0" aria-label="Open post"></a>
	{/if}

	{#if data.reposted}
		<div class="relative z-[1] mb-3 inline-flex items-center gap-2 text-xs">
			<svg
				xmlns="http://www.w3.org/2000/svg"
				viewBox="0 0 24 24"
				fill="currentColor"
				class="size-3"
			>
				<path
					fill-rule="evenodd"
					d="M4.755 10.059a7.5 7.5 0 0 1 12.548-3.364l1.903 1.903h-3.183a.75.75 0 1 0 0 1.5h4.992a.75.75 0 0 0 .75-.75V4.356a.75.75 0 0 0-1.5 0v3.18l-1.9-1.9A9 9 0 0 0 3.306 9.67a.75.75 0 1 0 1.45.388Zm15.408 3.352a.75.75 0 0 0-.919.53 7.5 7.5 0 0 1-12.548 3.364l-1.902-1.903h3.183a.75.75 0 0 0 0-1.5H2.984a.75.75 0 0 0-.75.75v4.992a.75.75 0 0 0 1.5 0v-3.18l1.9 1.9a9 9 0 0 0 15.059-4.035.75.75 0 0 0-.53-.918Z"
					clip-rule="evenodd"
				/>
			</svg>

			<div class="inline-flex gap-1">
				reposted by
				{#if onclickhandle}
					<a
						href={handleHref?.(data.reposted!.handle) ?? data.reposted!.href}
						class="hover:text-accent-600 dark:hover:text-accent-400 font-bold no-underline"
						onclick={(e) => { e.preventDefault(); onclickhandle(data.reposted!.handle, data.reposted!.href); }}
					>
						@{data.reposted.handle}
					</a>
				{:else}
					<a
						href={data.reposted.href}
						{target}
						class="hover:text-accent-600 dark:hover:text-accent-400 font-bold"
					>
						@{data.reposted.handle}
					</a>
				{/if}
			</div>
		</div>
	{/if}
	{#if data.replyTo}
		<div class="relative z-[1] mb-3 inline-flex items-center gap-2 text-xs">
			<svg
				xmlns="http://www.w3.org/2000/svg"
				viewBox="0 0 24 24"
				fill="currentColor"
				class="size-3"
			>
				<path
					fill-rule="evenodd"
					d="M14.47 2.47a.75.75 0 0 1 1.06 0l6 6a.75.75 0 0 1 0 1.06l-6 6a.75.75 0 1 1-1.06-1.06l4.72-4.72H9a5.25 5.25 0 1 0 0 10.5h3a.75.75 0 0 1 0 1.5H9a6.75 6.75 0 0 1 0-13.5h10.19l-4.72-4.72a.75.75 0 0 1 0-1.06Z"
					clip-rule="evenodd"
				/>
			</svg>

			<div class="inline-flex gap-1">
				replying to
				{#if onclickhandle}
					<a
						href={handleHref?.(data.replyTo!.handle) ?? data.replyTo!.href}
						class="hover:text-accent-600 dark:hover:text-accent-400 font-bold no-underline"
						onclick={(e) => { e.preventDefault(); onclickhandle(data.replyTo!.handle, data.replyTo!.href); }}
					>
						@{data.replyTo.handle}
					</a>
				{:else}
					<a
						href={data.replyTo.href}
						{target}
						class="hover:text-accent-600 dark:hover:text-accent-400 font-bold"
					>
						@{data.replyTo.handle}
					</a>
				{/if}
			</div>
		</div>
	{/if}

	<div class="flex min-w-0 items-start gap-4">
		{#if showAvatar}
			{@const avatarClass = compact ? 'size-7' : 'size-10'}
			<div class="relative z-[1] shrink-0">
				{#if onclickavatar}
					<button class="cursor-pointer" onclick={onclickavatar}>
						<Avatar src={data.author.avatar} class={avatarClass} />
					</button>
				{:else if onclickhandle}
					<a href={handleHref?.(data.author.handle) ?? data.author.href} onclick={(e) => { e.preventDefault(); onclickhandle(data.author.handle, data.author.href); }}>
						<Avatar src={data.author.avatar} class={avatarClass} />
					</a>
				{:else}
					<a href={data.author.href} {target}>
						<Avatar src={data.author.avatar} class={avatarClass} />
					</a>
				{/if}
			</div>
		{/if}

		<div class="w-full min-w-0">
			<div class="relative z-[1]">
				<PostHeader
					author={data.author}
					createdAt={data.createdAt}
					{timestamp}
					{onclickhandle}
					{handleHref}
					showAvatar={false}
					{compact}
					{logo}
					{target}
				/>
			</div>

			<div
				class={cn(
					'post-content break-words',
					'[&_a]:text-accent-600 dark:[&_a]:text-accent-400 [&_a]:relative [&_a]:z-10',
					compact ? 'text-sm' : 'text-base'
				)}
				style="overflow-wrap: anywhere;"
			>
				{#if data.htmlContent}
					{@html sanitize(data.htmlContent, { ADD_ATTR: ['target'] })}
				{:else}
					{@render children?.()}
				{/if}
			</div>

			{#if embeds?.length}
				<div class="relative z-[1]">
					{#each embeds as embed}
						<Embed {embed} {showSensitive} />
					{/each}
				</div>
			{/if}

			{#if extraEmbeds}
				<div class="relative z-[1] flex flex-col gap-2 pt-3 text-sm">
					{@render extraEmbeds()}
				</div>
			{/if}

			{#if actions}
				<div class="relative z-[1]">
					<ActionButtons
						{...actions}
						class={cn('mt-3', actions.class)}
					/>
				</div>
			{/if}
		</div>
	</div>
</div>

