<script lang="ts">
	/* eslint-disable svelte/no-navigation-without-resolve */
	import { goto } from '$app/navigation';
	import { Avatar } from '@foxui/core';
	import { Heart, MessageCircle, Repeat2 } from '@lucide/svelte';
	import { wireEmbedClicks } from '$lib/components/embed';
	import { blueskyPostToPostData } from '$lib/components';
	import { Post } from '$lib/components';
	import type { PostRow, PostWithCommunity } from './db';
	type PostView = Record<string, unknown> & {
		uri: string;
		author: { handle: string };
	};

	type CardRow = PostRow | PostWithCommunity;

	let {
		row,
		quoted,
		showCommunity = false
	}: {
		row: CardRow;
		quoted?: PostView | null;
		showCommunity?: boolean;
	} = $props();

	const communityHandle = $derived(
		'community_handle' in row ? (row as PostWithCommunity).community_handle : undefined
	);
	const communityShort = $derived(communityHandle ? communityHandle.split('.')[0] : undefined);
	const communityAvatar = $derived(
		'community_avatar' in row ? ((row as PostWithCommunity).community_avatar ?? undefined) : undefined
	);

	const quotedEmbeds = $derived.by(() => {
		if (!quoted) return [];
		const { embeds } = blueskyPostToPostData(quoted as never, 'https://bsky.app');
		return wireEmbedClicks(
			embeds,
			(handle, rkey) => goto(`/profile/${handle}/post/${rkey}`),
			(handle) => goto(`/profile/${handle}`)
		);
	});

	const quotedPostData = $derived.by(() => {
		if (!quoted) return null;
		const { postData } = blueskyPostToPostData(quoted as never, 'https://bsky.app');
		return postData;
	});

	function fmtRelative(iso: string): string {
		const d = new Date(iso).getTime();
		const diff = Date.now() - d;
		const s = Math.floor(diff / 1000);
		if (s < 60) return `${s}s`;
		if (s < 3600) return `${Math.floor(s / 60)}m`;
		if (s < 86400) return `${Math.floor(s / 3600)}h`;
		return `${Math.floor(s / 86400)}d`;
	}
</script>

<article class="py-3">
	{#if showCommunity && communityShort}
		<a
			href={`/c/${communityShort}`}
			class="flex items-center gap-2 text-xs leading-none text-base-600 dark:text-base-400 hover:underline"
		>
			<Avatar src={communityAvatar} class="size-5" />
			<span class="font-semibold">c/{communityShort}</span>
			<span>·</span>
			<span>{fmtRelative(row.indexed_at)}</span>
		</a>
	{:else}
		<div class="text-xs leading-none text-base-500 dark:text-base-400">
			{fmtRelative(row.indexed_at)}
		</div>
	{/if}

	<h2 class="mb-2 mt-1 text-lg font-semibold leading-tight">{row.title}</h2>

	{#if quoted && quotedPostData}
		<div class="border-base-300 dark:border-base-600/30 bg-base-500/10 dark:bg-black/30 mb-2 rounded-2xl border p-3">
			<Post
				data={quotedPostData}
				embeds={quotedEmbeds}
				compact
				href={`/profile/${quoted.author.handle}/post/${quoted.uri.split('/').pop()}`}
				handleHref={(handle) => `/profile/${handle}`}
				onclickhandle={(handle) => goto(`/profile/${handle}`)}
			/>
		</div>
	{:else if quoted === null}
		<div class="text-base-500 dark:text-base-400 mb-2 text-xs italic">
			(quoted post unavailable)
		</div>
	{:else}
		<div class="border-base-300 dark:border-base-700 bg-base-200/50 dark:bg-base-800/50 mb-2 animate-pulse rounded-2xl border p-3">
			<div class="h-3 w-32 rounded bg-base-300 dark:bg-base-700"></div>
			<div class="mt-2 h-3 w-full rounded bg-base-300 dark:bg-base-700"></div>
			<div class="mt-1 h-3 w-3/4 rounded bg-base-300 dark:bg-base-700"></div>
		</div>
	{/if}

	<div class="flex items-center gap-4 text-xs text-base-500 dark:text-base-400">
		<span class="flex items-center gap-1">
			<Heart size={14} /> {row.like_count}
		</span>
		<span class="flex items-center gap-1">
			<MessageCircle size={14} /> {row.reply_count}
		</span>
		<span class="flex items-center gap-1">
			<Repeat2 size={14} /> {row.repost_count}
		</span>
	</div>
</article>
