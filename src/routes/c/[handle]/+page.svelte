<script lang="ts">
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import { Avatar } from '@foxui/core';
	import { Loader2 } from '@lucide/svelte';
	import { getCommunity, getCommunityPosts } from '$lib/reddit/server/communities.remote';
	import { getQuotedPosts } from '$lib/reddit/server/quoted-posts.remote';
	import RedditPostCard from '$lib/reddit/RedditPostCard.svelte';
	import type { PostRow } from '$lib/reddit/db';

	type CommunityInfo = Awaited<ReturnType<typeof getCommunity>>;

	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let community = $state<CommunityInfo>(null);
	let posts = $state<PostRow[]>([]);
	let quoted = $state<Record<string, unknown>>({});

	async function load(handle: string) {
		loading = true;
		loadError = null;
		community = null;
		posts = [];
		quoted = {};
		try {
			const info = await getCommunity({ handle });
			if (!info) {
				loadError = 'Community not found';
				loading = false;
				return;
			}
			community = info;
			const rows = await getCommunityPosts({ handle, limit: 50 });
			posts = rows;

			if (rows.length > 0) {
				const uris = rows.map((r) => r.quoted_post_uri);
				const res = await getQuotedPosts({ uris });
				quoted = res.posts;
			}
		} catch (e) {
			console.error(e);
			loadError = 'Failed to load community';
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		const handle = page.params.handle;
		if (handle) untrack(() => load(handle));
	});
</script>

<div class="mx-auto w-full max-w-lg px-4 py-6">
	{#if loading}
		<div class="flex items-center justify-center py-12">
			<Loader2 class="text-base-400 animate-spin" size={28} />
		</div>
	{:else if loadError}
		<p class="text-sm text-red-500">{loadError}</p>
	{:else if community}
		{@const communityShort = community.handle.split('.')[0]}
		<header class="mb-6 flex items-center gap-3">
			<Avatar src={community.avatar ?? undefined} class="size-14" />
			<div>
				<h1 class="text-xl font-bold">c/{communityShort}</h1>
				<a
					href={`https://bsky.app/profile/${community.handle}`}
					target="_blank"
					rel="noopener noreferrer"
					class="text-base-500 dark:text-base-400 text-sm hover:underline"
				>
					@{community.handle}
				</a>
				{#if community.description}
					<p class="text-base-600 dark:text-base-400 mt-1 text-sm">
						{community.description}
					</p>
				{/if}
			</div>
		</header>

		<div class="border-base-200 dark:border-base-800 mb-4 rounded-xl border bg-base-50 dark:bg-base-900/50 p-3 text-xs text-base-500 dark:text-base-400">
			Submit to this community by DM'ing <span class="font-mono">@{community.handle}</span> a Bluesky post link with your title.
		</div>

		{#if posts.length === 0}
			<p class="text-base-500 dark:text-base-400 py-8 text-center text-sm">
				No submissions yet.
			</p>
		{:else}
			<div class="divide-base-200 dark:divide-base-800 flex flex-col divide-y">
				{#each posts as p (p.uri)}
					<RedditPostCard row={p} quoted={(quoted[p.quoted_post_uri] ?? undefined) as never} />
				{/each}
			</div>
		{/if}
	{/if}
</div>
