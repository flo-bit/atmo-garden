<script lang="ts">
	/* eslint-disable svelte/no-navigation-without-resolve */
	import { goto } from '$app/navigation';
	import { Avatar } from '@foxui/core';
	import { Heart, MessageCircle, Repeat2 } from '@lucide/svelte';
	import { wireEmbedClicks } from '$lib/components/embed';
	import { blueskyPostToPostData } from '$lib/components';
	import { Post } from '$lib/components';
	import { likePost, unlikePost } from '$lib/atproto/server/feed.remote';
	import { user } from '$lib/atproto/auth.svelte';
	import { loginModalState } from '$lib/LoginModal.svelte';
	import { isAccentColor } from './accent-colors';
	import type { PostRow, PostWithCommunity } from './db';

	// `getQuotedPosts` uses the authenticated appview client, so this view
	// already includes per-viewer state like `viewer.like` plus the live
	// like/reply/repost counts. We treat the QUOTED post as the canonical
	// thing users interact with — the community's wrapping quote post is
	// just a forwarder.
	type PostView = {
		uri: string;
		cid: string;
		author: { handle: string };
		likeCount?: number;
		replyCount?: number;
		repostCount?: number;
		viewer?: { like?: string; repost?: string };
		[key: string]: unknown;
	};

	type CardRow = PostRow | PostWithCommunity;

	let {
		row,
		quoted,
		showCommunity = false,
		/** Tailwind color label, e.g. "pink". Only needed when `row` is a bare
		  * PostRow (no community_accent_color). On a PostWithCommunity the row
		  * already carries the cached accent color. */
		accentColor: accentColorProp
	}: {
		row: CardRow;
		quoted?: PostView | null;
		showCommunity?: boolean;
		accentColor?: string | null;
	} = $props();

	const communityHandle = $derived(
		'community_handle' in row ? (row as PostWithCommunity).community_handle : undefined
	);
	const communityShort = $derived(communityHandle ? communityHandle.split('.')[0] : undefined);
	const communityAvatar = $derived(
		'community_avatar' in row ? ((row as PostWithCommunity).community_avatar ?? undefined) : undefined
	);

	// Prefer the value carried on the row (home feed uses JOIN), fall back
	// to the explicit prop (community page passes it in), else leave empty
	// so the ambient page theme bleeds through.
	const accentClass = $derived.by(() => {
		const fromRow =
			'community_accent_color' in row
				? (row as PostWithCommunity).community_accent_color
				: null;
		const candidate = fromRow ?? accentColorProp ?? null;
		return isAccentColor(candidate) ? candidate : '';
	});

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

	// All counts + viewer state come straight from the quoted PostView.
	// We track optimistic state locally so the heart flips instantly on
	// click without waiting for a server roundtrip.
	let likeUri = $state<string | null>(null);
	let likeDelta = $state(0);
	let likeBusy = $state(false);
	const isLiked = $derived(likeUri !== null);
	const baseLikeCount = $derived(quoted?.likeCount ?? 0);
	const displayLikeCount = $derived(baseLikeCount + likeDelta);
	const replyCount = $derived(quoted?.replyCount ?? 0);
	const repostCount = $derived(quoted?.repostCount ?? 0);

	$effect(() => {
		// Re-seed optimistic state whenever the parent swaps in a fresh
		// PostView. Reading inside the effect keeps it reactive.
		likeUri = quoted?.viewer?.like ?? null;
		likeDelta = 0;
	});

	async function onLikeClick(e: Event) {
		e.preventDefault();
		e.stopPropagation();
		if (!user.did) {
			loginModalState.open = true;
			return;
		}
		if (likeBusy || !quoted) return;
		likeBusy = true;
		const wasLiked = isLiked;
		// Optimistic flip.
		if (wasLiked) {
			likeDelta = -1;
			const prevUri = likeUri;
			likeUri = null;
			try {
				if (prevUri) await unlikePost({ likeUri: prevUri });
			} catch (err) {
				console.error('[RedditPostCard] unlike failed', err);
				likeUri = prevUri;
				likeDelta = 0;
			}
		} else {
			likeDelta = 1;
			try {
				const result = await likePost({ uri: quoted.uri, cid: quoted.cid });
				likeUri = result.uri;
			} catch (err) {
				console.error('[RedditPostCard] like failed', err);
				likeDelta = 0;
			}
		}
		likeBusy = false;
	}
</script>

<article class="py-3 {accentClass}">
	{#if showCommunity && communityShort}
		<a
			href={`/c/${communityShort}`}
			class="flex items-center gap-2 text-xs leading-none text-base-600 dark:text-base-400 hover:underline {row.title ? '' : 'mb-2'}"
		>
			{#if communityAvatar}
				<Avatar src={communityAvatar} class="size-5" />
			{/if}
			<span class="text-accent-600 dark:text-accent-400 font-semibold">c/{communityShort}</span>
			<span>·</span>
			<span>{fmtRelative(row.indexed_at)}</span>
		</a>
	{:else}
		<div class="text-xs leading-none text-base-500 dark:text-base-400 {row.title ? '' : 'mb-2'}">
			{fmtRelative(row.indexed_at)}
		</div>
	{/if}

	{#if row.title}
		<h2 class="mb-2 mt-1 text-lg font-semibold leading-tight">{row.title}</h2>
	{/if}

	{#if quoted && quotedPostData}
		<div class="border-base-300 dark:border-base-600/30 bg-base-500/10 dark:bg-black/30 rounded-2xl border p-3">
			<Post
				data={quotedPostData}
				embeds={quotedEmbeds}
				compact
				href={`/profile/${quoted.author.handle}/post/${quoted.uri.split('/').pop()}`}
				handleHref={(handle) => `/profile/${handle}`}
				onclickhandle={(handle) => goto(`/profile/${handle}`)}
			/>

			<div class="mt-4 flex items-center gap-4 text-xs text-base-500 dark:text-base-400">
				<button
					type="button"
					onclick={onLikeClick}
					disabled={likeBusy}
					class="hover:text-accent-500 flex cursor-pointer items-center gap-1 transition-colors {isLiked ? 'text-accent-500' : ''}"
					aria-label={isLiked ? 'Unlike' : 'Like'}
				>
					<Heart size={14} fill={isLiked ? 'currentColor' : 'none'} />
					{displayLikeCount}
				</button>
				<span class="flex items-center gap-1">
					<MessageCircle size={14} /> {replyCount}
				</span>
				<span class="flex items-center gap-1">
					<Repeat2 size={14} /> {repostCount}
				</span>
			</div>
		</div>
	{:else if quoted === null}
		<div class="text-base-500 dark:text-base-400 text-xs italic">
			(quoted post unavailable)
		</div>
	{:else}
		<div class="border-base-300 dark:border-base-700 bg-base-200/50 dark:bg-base-800/50 animate-pulse rounded-2xl border p-3">
			<div class="h-3 w-32 rounded bg-base-300 dark:bg-base-700"></div>
			<div class="mt-2 h-3 w-full rounded bg-base-300 dark:bg-base-700"></div>
			<div class="mt-1 h-3 w-3/4 rounded bg-base-300 dark:bg-base-700"></div>
		</div>
	{/if}
</article>
