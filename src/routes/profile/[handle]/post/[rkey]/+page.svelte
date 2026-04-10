<script lang="ts">
	/* eslint-disable svelte/no-navigation-without-resolve */
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Avatar } from '@foxui/core';
	import { user } from '$lib/atproto/auth.svelte';
	import { actorToDid } from '$lib/atproto/methods';
	import { blueskyPostToPostData } from '$lib/components';
	import { Post, NestedComments } from '$lib/components';
	import type { PostData } from '$lib/components';
	import { ArrowLeft, CornerUpLeft, Loader2 } from '@lucide/svelte';
	import { getPostThread } from '$lib/atproto/server/feed.remote';
	import { getCommunityPost } from '$lib/reddit/server/communities.remote';
	import { wireEmbedClicks } from '$lib/components/embed';
	import { toggleLike } from '$lib/actions.svelte';
	import { Bluesky } from '$lib/components/social-icons';
	import { isAccentColor } from '$lib/reddit/accent-colors';

	type CommunityPost = Awaited<ReturnType<typeof getCommunityPost>>;

	function fmtRelative(iso: string): string {
		const d = new Date(iso).getTime();
		const diff = Date.now() - d;
		const s = Math.floor(diff / 1000);
		if (s < 60) return `${s}s`;
		if (s < 3600) return `${Math.floor(s / 60)}m`;
		if (s < 86400) return `${Math.floor(s / 3600)}h`;
		return `${Math.floor(s / 86400)}d`;
	}

	let loading = $state(true);
	let loadingComments = $state(true);
	let error = $state<string | null>(null);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let mainPost = $state<any>(null);
	let comments = $state<PostData[]>([]);
	let communityPost = $state<CommunityPost>(null);
	let parentRef = $state<{ handle: string; rkey: string } | null>(null);
	const accentClass = $derived(
		isAccentColor(communityPost?.community_accent_color) ? communityPost!.community_accent_color : ''
	);
	const communityShort = $derived(communityPost?.community_handle?.split('.')[0] ?? '');

	// Map rkey -> raw post view (for comment like actions)
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let commentPosts: Record<string, any> = $state({});

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	function threadToComments(replies: any[]): PostData[] {
		return replies
			.filter((r) => r.$type === 'app.bsky.feed.defs#threadViewPost' && r.post)
			.map((r) => {
				const rkey = r.post.uri.split('/').pop();
				commentPosts[rkey] = r.post;
				const { postData } = blueskyPostToPostData(r.post);
				if (r.replies?.length) {
					postData.replies = threadToComments(r.replies);
				}
				return postData;
			});
	}

	function commentActions(comment: PostData) {
		if (!user.did) {
			return {
				reply: { count: comment.replyCount },
				repost: { count: comment.repostCount },
				like: { count: comment.likeCount }
			};
		}

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const postView: any = comment.id ? commentPosts[comment.id] : null;
		if (!postView) {
			return {
				reply: { count: comment.replyCount },
				repost: { count: comment.repostCount },
				like: { count: comment.likeCount }
			};
		}
		return {
			reply: { count: comment.replyCount },
			repost: { count: comment.repostCount },
			like: {
				count: postView.likeCount ?? 0,
				active: !!postView.viewer?.like,
				onclick: () => toggleLike(postView)
			}
		};
	}

	onMount(async () => {
		try {
			const did = await actorToDid(page.params.handle ?? '');
			const uri = `at://${did}/app.bsky.feed.post/${page.params.rkey ?? ''}`;

			// `?cpost=<at-uri>` is set by RedditPostCard when the post was
			// viewed inside a community feed. It's the AT URI of the community
			// account's quote/repost record for this post — we look it up in
			// our D1 cache to grab the title / timestamp / community metadata.
			const cpostParam = page.url.searchParams.get('cpost');
			const [threadData, cp] = await Promise.all([
				// Request parentHeight=1 so we can show "reply to @parent"
				// when this post is itself a reply.
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				getPostThread({ uri, parentHeight: 1 }) as Promise<any>,
				cpostParam
					? getCommunityPost({ uri: cpostParam }).catch(() => null)
					: Promise.resolve(null)
			]);
			communityPost = cp;

			if (!threadData.thread || threadData.thread.$type !== 'app.bsky.feed.defs#threadViewPost') {
				error = 'Post not found';
				return;
			}

			mainPost = threadData.thread.post;

			// Extract the immediate parent for the "reply to" link, if the
			// thread response included one. Skip notFound/blocked variants.
			const parent = threadData.thread.parent;
			if (
				parent &&
				parent.$type === 'app.bsky.feed.defs#threadViewPost' &&
				parent.post?.author?.handle &&
				parent.post?.uri
			) {
				parentRef = {
					handle: parent.post.author.handle,
					rkey: parent.post.uri.split('/').pop() ?? ''
				};
			}

			if (threadData.thread.replies?.length) {
				commentPosts = {};
				comments = threadToComments(threadData.thread.replies);
			}
		} catch (e) {
			console.error('Failed to load post:', e);
			error = 'Failed to load post';
		} finally {
			loading = false;
			loadingComments = false;
		}
	});

	function handleClickHandle(handle: string) {
		goto(`/profile/${handle}`);
	}
</script>

<div class={accentClass}>
	<div class="mx-auto w-full max-w-xl py-4">
		<button
			onclick={() => history.back()}
			class="text-base-500 hover:text-base-700 dark:text-base-400 dark:hover:text-base-200 mb-2 ml-4 rounded-lg p-1.5 transition-colors sm:ml-0"
		>
			<ArrowLeft size={20} />
		</button>
		{#if communityPost && communityShort}
			<div class="mb-4 px-4 sm:px-0">
				<a
					href={`/c/${communityShort}`}
					class="text-base-600 dark:text-base-400 flex items-center gap-2 text-xs leading-none hover:underline"
				>
					{#if communityPost.community_avatar}
						<Avatar src={communityPost.community_avatar} class="size-5" />
					{/if}
					<span class="text-accent-600 dark:text-accent-400 font-semibold">c/{communityShort}</span>
					<span>·</span>
					<span>{fmtRelative(communityPost.indexed_at)}</span>
				</a>
				{#if communityPost.title}
					<h1 class="mt-1 text-xl font-bold leading-tight">{communityPost.title}</h1>
				{/if}
			</div>
		{/if}
		{#if loading}
			<div class="flex items-center justify-center py-12">
				<Loader2 class="text-base-400 animate-spin" size={28} />
			</div>
		{:else if error}
			<div class="flex items-center justify-center px-4 py-12">
				<p class="text-sm text-red-500">{error}</p>
			</div>
		{:else if mainPost}
			{@const { postData, embeds } = blueskyPostToPostData(mainPost)}
			{@const bskyUrl = `https://bsky.app/profile/${mainPost.author.handle}/post/${mainPost.uri.split('/').pop()}`}
			{#snippet bskyLogo()}
				<Bluesky
					href={bskyUrl}
					target="_blank"
					rel="noopener noreferrer"
					svgClasses="size-4"
				/>
			{/snippet}
			{#if parentRef}
				<a
					href={`https://bsky.app/profile/${parentRef.handle}/post/${parentRef.rkey}`}
					target="_blank"
					rel="noopener noreferrer"
					class="text-base-500 dark:text-base-400 hover:text-accent-600 dark:hover:text-accent-400 mb-2 ml-4 flex items-center gap-1.5 text-xs transition-colors sm:ml-0"
				>
					<CornerUpLeft size={12} />
					<span>Reply to <span class="font-semibold">@{parentRef.handle}</span></span>
				</a>
			{/if}
			<div class="px-4 sm:px-0">
				<Post
					data={postData}
					embeds={wireEmbedClicks(embeds, (handle, rkey) => goto(`/profile/${handle}/post/${rkey}`), (handle) => goto(`/profile/${handle}`))}
					onclickhandle={handleClickHandle}
					handleHref={(handle) => `/profile/${handle}`}
					logo={bskyLogo}
					timestamp={{ href: bskyUrl }}
					actions={user.did
						? {
								like: {
									count: mainPost.likeCount ?? 0,
									active: !!mainPost.viewer?.like,
									onclick: () => toggleLike(mainPost)
								},
								reply: {
									count: postData.replyCount,
									href: bskyUrl,
									target: '_blank'
								},
								repost: { count: postData.repostCount }
							}
						: {
								like: { count: postData.likeCount },
								reply: {
									count: postData.replyCount,
									href: bskyUrl,
									target: '_blank'
								},
								repost: { count: postData.repostCount }
							}}
				/>
			</div>

			<div id="replies">
				{#if loadingComments}
					<div class="flex justify-center py-6">
						<Loader2 class="text-base-400 animate-spin" size={24} />
					</div>
				{:else if comments.length > 0}
					<div class="px-4 sm:px-0">
						<NestedComments {comments} onclickhandle={handleClickHandle} actions={commentActions} />
					</div>
				{/if}
			</div>
		{/if}
	</div>
</div>
