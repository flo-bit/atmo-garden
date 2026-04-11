<script lang="ts">
	/* eslint-disable svelte/no-navigation-without-resolve */
	import { goto } from '$app/navigation';
	import { Avatar } from '@foxui/core';
	import { Heart, MessageCircle, Repeat2 } from '@lucide/svelte';
	import { wireEmbedClicks } from '$lib/components/embed';
	import { blueskyPostToPostData, numberToHumanReadable } from '$lib/components';
	import { Post } from '$lib/components';
	import { likePost, unlikePost } from '$lib/atproto/server/feed.remote';
	import { user } from '$lib/atproto/auth.svelte';
	import { loginModalState } from '$lib/LoginModal.svelte';
	import { Bluesky } from '$lib/components/social-icons';
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

	/**
	 * Return a shallow copy of `post` with any mention facets targeting
	 * `communityDid` cut out of the record text, and surviving facets'
	 * byte indices re-shifted to match the shortened text.
	 *
	 * Bluesky facet indices are UTF-8 byte offsets, so we do all surgery
	 * on `TextEncoder()`-encoded bytes rather than JS string char indices.
	 * Adjacent whitespace is swallowed alongside each mention (preferring
	 * one leading space, falling back to one trailing space) so we don't
	 * leave dangling "  " between words after stripping.
	 */
	function stripCommunityMention(post: PostView, communityDid: string): PostView {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const record = (post as any).record as
			| {
					text?: string;
					facets?: Array<{
						index: { byteStart: number; byteEnd: number };
						features: Array<{ $type: string; did?: string }>;
					}>;
			  }
			| undefined
			| null;
		if (!record?.text || !record.facets || record.facets.length === 0) return post;

		const isTargetMention = (f: NonNullable<typeof record.facets>[number]) =>
			f.features.some(
				(feat) =>
					feat.$type === 'app.bsky.richtext.facet#mention' && feat.did === communityDid
			);

		const toRemove = record.facets.filter(isTargetMention);
		if (toRemove.length === 0) return post;

		const textBytes = new TextEncoder().encode(record.text);

		// Expand each removal to swallow one adjacent whitespace byte —
		// leading if possible, else trailing. We only care about 0x20
		// (space) and 0x0a (newline) — anything else is rare enough to
		// leave as-is.
		const isSpace = (b: number) => b === 0x20 || b === 0x0a;
		const expanded = toRemove
			.map((f) => {
				let start = f.index.byteStart;
				let end = f.index.byteEnd;
				if (start > 0 && isSpace(textBytes[start - 1])) start -= 1;
				else if (end < textBytes.length && isSpace(textBytes[end])) end += 1;
				return { start, end };
			})
			// Non-overlapping (facets don't overlap) so start order = byte order.
			.sort((a, b) => a.start - b.start);

		// Splice out the holes.
		const pieces: Uint8Array[] = [];
		let cursor = 0;
		for (const { start, end } of expanded) {
			if (start > cursor) pieces.push(textBytes.slice(cursor, start));
			cursor = end;
		}
		if (cursor < textBytes.length) pieces.push(textBytes.slice(cursor));

		const totalLen = pieces.reduce((n, p) => n + p.length, 0);
		const merged = new Uint8Array(totalLen);
		let offset = 0;
		for (const p of pieces) {
			merged.set(p, offset);
			offset += p.length;
		}
		const newText = new TextDecoder().decode(merged);

		// For each surviving facet, subtract the total bytes removed
		// strictly BEFORE its position. `expanded` is sorted and
		// non-overlapping, so one linear pass per lookup is fine.
		const shiftByte = (byte: number): number => {
			let removed = 0;
			for (const r of expanded) {
				if (r.end <= byte) removed += r.end - r.start;
				else break;
			}
			return byte - removed;
		};

		const removeSet = new Set(toRemove);
		const newFacets = record.facets
			.filter((f) => !removeSet.has(f))
			.map((f) => ({
				...f,
				index: {
					byteStart: shiftByte(f.index.byteStart),
					byteEnd: shiftByte(f.index.byteEnd)
				}
			}));

		return {
			...post,
			record: {
				...record,
				text: newText,
				facets: newFacets
			}
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any;
	}

	type CardRow = PostRow | PostWithCommunity;

	let {
		row,
		quoted,
		showCommunity = false,
		/** Tailwind color label, e.g. "pink". Only needed when `row` is a bare
		  * PostRow (no community_accent_color). On a PostWithCommunity the row
		  * already carries the cached accent color. */
		accentColor: accentColorProp,
		/** Resolved profile of the user who submitted this post via DM.
		  * Caller is responsible for fetching the handle by `row.author_did`. */
		submitter
	}: {
		row: CardRow;
		quoted?: PostView | null;
		showCommunity?: boolean;
		accentColor?: string | null;
		submitter?: { handle: string; displayName: string | null } | null;
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

	// Direct link to the original post on bsky.app. Derived from the quoted
	// PostView so it updates as soon as the appview response arrives.
	const bskyUrl = $derived(
		quoted
			? `https://bsky.app/profile/${quoted.author.handle}/post/${quoted.uri.split('/').pop()}`
			: null
	);

	// The mention-based submission flow (see `processCommunityMentions` in
	// src/lib/reddit/bot.ts) reposts any top-level bsky post that tags the
	// community's handle. By the time we're rendering that post inside the
	// community feed, the `@community.atmo.garden` mention is just noise —
	// the UI already tells the viewer which community they're looking at.
	// Strip any mention facet pointing at `row.community_did` from the
	// quoted PostView before handing it to `blueskyPostToPostData`, so the
	// rendered text and the rebuilt byte-indexed facets stay in sync.
	const communityDid = $derived(row.community_did);
	const strippedQuoted = $derived.by(() => {
		if (!quoted || !communityDid) return quoted ?? null;
		return stripCommunityMention(quoted, communityDid);
	});

	const quotedEmbeds = $derived.by(() => {
		if (!strippedQuoted) return [];
		const { embeds } = blueskyPostToPostData(strippedQuoted as never, 'https://bsky.app');
		return wireEmbedClicks(
			embeds,
			(handle, rkey) => goto(`/profile/${handle}/post/${rkey}`),
			(handle) => goto(`/profile/${handle}`)
		);
	});

	const quotedPostData = $derived.by(() => {
		if (!strippedQuoted) return null;
		const { postData } = blueskyPostToPostData(strippedQuoted as never, 'https://bsky.app');
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
	<div class="flex items-center gap-2 text-xs leading-none text-base-600 dark:text-base-400 {row.title ? '' : 'mb-2'}">
		{#if showCommunity && communityShort}
			<a
				href={`/c/${communityShort}`}
				class="flex items-center gap-2 hover:underline"
			>
				{#if communityAvatar}
					<Avatar src={communityAvatar} class="size-5" />
				{/if}
				<span class="text-accent-600 dark:text-accent-400 font-semibold">c/{communityShort}</span>
			</a>
			<span>·</span>
		{/if}
		{#if bskyUrl}
			<a href={bskyUrl} target="_blank" rel="noopener noreferrer" class="hover:underline">
				{fmtRelative(row.indexed_at)}
			</a>
		{:else}
			<span>{fmtRelative(row.indexed_at)}</span>
		{/if}
		{#if submitter}
			<span>·</span>
			<span>submitted by</span>
			<a
				href={`/profile/${submitter.handle}`}
				class="hover:underline"
			>
				@{submitter.handle}
			</a>
		{/if}
	</div>

	{#if row.title}
		<h2 class="mb-2 mt-1 text-lg font-semibold leading-tight">{row.title}</h2>
	{/if}

	{#if quoted && quotedPostData}
		{@const detailHref = `/profile/${quoted.author.handle}/post/${quoted.uri.split('/').pop()}${communityShort ? `?cpost=${encodeURIComponent(row.uri)}` : ''}`}
		<div class="border-base-300 dark:border-base-600/30 bg-base-500/10 dark:bg-black/30 rounded-2xl border p-3">
			<Post
				data={quotedPostData}
				embeds={quotedEmbeds}
				compact
				href={detailHref}
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
					{numberToHumanReadable(displayLikeCount)}
				</button>
				{#if bskyUrl}
					<a
						href={bskyUrl}
						target="_blank"
						rel="noopener noreferrer"
						onclick={(e) => e.stopPropagation()}
						class="hover:text-accent-500 flex items-center gap-1 transition-colors"
						aria-label="Reply on Bluesky"
					>
						<MessageCircle size={14} /> {numberToHumanReadable(replyCount)}
					</a>
				{:else}
					<span class="flex items-center gap-1">
						<MessageCircle size={14} /> {numberToHumanReadable(replyCount)}
					</span>
				{/if}
				<span class="flex items-center gap-1">
					<Repeat2 size={14} /> {numberToHumanReadable(repostCount)}
				</span>
				{#if bskyUrl}
					<Bluesky
						href={bskyUrl}
						target="_blank"
						rel="noopener noreferrer"
						class="ml-auto"
					/>
				{/if}
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
