<script lang="ts">
	/* eslint-disable svelte/no-navigation-without-resolve */
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { user } from '$lib/atproto/auth.svelte';
	import { loginModalState } from '$lib/LoginModal.svelte';
	import { listNotifications, updateSeen } from '$lib/atproto/server/notifications.remote';
	import { getPostHref } from '$lib/utils/post-href';
	import { blueskyPostToPostData } from '$lib/components';
	import { Post } from '$lib/components';
	import { wireEmbedClicks } from '$lib/components/embed';
	import { Avatar } from '@foxui/core';
	import { Bell, Heart, Repeat2, UserPlus, MessageCircle, Quote, AtSign, Loader2, RefreshCw } from '@lucide/svelte';
	import type { AppBskyNotificationListNotifications } from '@atcute/bluesky';

	type Notification = AppBskyNotificationListNotifications.Notification;

	interface GroupedNotification {
		reason: string;
		reasonSubject?: string;
		authors: Notification['author'][];
		notifications: Notification[];
		latestAt: string;
		isRead: boolean;
		_page: number;
	}

	let notifications = $state<Notification[]>([]);
	let notifCursor = $state<string | null>(null);
	let loading = $state(true);
	let loadingMore = $state(false);
	let refreshing = $state(false);
	// Track indices where new pages of notifications begin (don't group across pages)
	let loadMoreIndices = $state<number[]>([]);

	// Group notifications by reason + reasonSubject
	const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

	let grouped = $derived.by(() => {
		const notifs = notifications;
		const groups: GroupedNotification[] = [];
		const groupableReasons = ['like', 'like-via-repost', 'repost', 'repost-via-repost', 'follow'];

		// Determine which page each notification belongs to
		const sortedBreaks = [...loadMoreIndices].sort((a, b) => a - b);
		function getPage(index: number): number {
			let page = 0;
			for (const b of sortedBreaks) {
				if (index >= b) page++;
				else break;
			}
			return page;
		}

		for (let n = 0; n < notifs.length; n++) {
			const notif = notifs[n];
			const notifPage = getPage(n);

			if (groupableReasons.includes(notif.reason)) {
				const key = `${notif.reason}:${notif.reasonSubject ?? 'none'}`;
				const existing = groups.find((g) => {
					if (g._page !== notifPage) return false;
					if (`${g.reason}:${g.reasonSubject ?? 'none'}` !== key) return false;
					const timeDiff = Math.abs(new Date(g.latestAt).getTime() - new Date(notif.indexedAt).getTime());
					return timeDiff < TWENTY_FOUR_HOURS;
				});
				if (existing) {
					if (!existing.authors.some((a) => a.did === notif.author.did)) {
						existing.authors.push(notif.author);
					}
					existing.notifications.push(notif);
					if (!notif.isRead) existing.isRead = false;
					if (notif.indexedAt > existing.latestAt) existing.latestAt = notif.indexedAt;
					continue;
				}
			}

			groups.push({
				reason: notif.reason,
				reasonSubject: notif.reasonSubject,
				authors: [notif.author],
				notifications: [notif],
				latestAt: notif.indexedAt,
				isRead: notif.isRead,
				_page: notifPage
			});
		}

		return groups;
	});

	async function refresh() {
		refreshing = true;
		loadMoreIndices = [];
		try {
			const result = await listNotifications({});
			notifications = result.notifications as Notification[];
			notifCursor = result.cursor;
		} catch (e) {
			console.error('Failed to refresh notifications:', e);
		} finally {
			refreshing = false;
			loading = false;
		}
	}

	async function loadMore() {
		if (loadingMore || !notifCursor) return;
		loadingMore = true;
		try {
			const result = await listNotifications({ cursor: notifCursor });
			const newNotifs = result.notifications as Notification[];
			const boundaryIndex = notifications.length;
			notifications = [...notifications, ...newNotifs];
			notifCursor = result.cursor;
			loadMoreIndices = [...loadMoreIndices, boundaryIndex];
		} catch (e) {
			console.error('Failed to load more notifications:', e);
		} finally {
			loadingMore = false;
		}
	}

	function handleScroll() {
		if (loadingMore || !notifCursor) return;
		const { scrollTop, scrollHeight, clientHeight } = document.documentElement;
		if (scrollHeight - scrollTop - clientHeight < 800) {
			loadMore();
		}
	}

	onMount(() => {
		if (user.did) {
			refresh();
			updateSeen({}).catch(() => {});
		} else {
			loading = false;
		}

		window.addEventListener('scroll', handleScroll);
	});

	onDestroy(() => {
		if (typeof window !== 'undefined') window.removeEventListener('scroll', handleScroll);
	});

	function reasonIcon(reason: string) {
		switch (reason) {
			case 'like':
			case 'like-via-repost':
				return Heart;
			case 'repost':
			case 'repost-via-repost':
				return Repeat2;
			case 'follow':
				return UserPlus;
			case 'reply':
				return MessageCircle;
			case 'quote':
				return Quote;
			case 'mention':
				return AtSign;
			default:
				return Bell;
		}
	}

	function reasonColor(reason: string): string {
		switch (reason) {
			case 'like':
			case 'like-via-repost':
				return 'text-rose-500';
			case 'repost':
			case 'repost-via-repost':
				return 'text-emerald-500';
			case 'follow':
				return 'text-blue-500';
			case 'reply':
			case 'mention':
				return 'text-sky-500';
			case 'quote':
				return 'text-purple-500';
			default:
				return 'text-base-400';
		}
	}

	function reasonText(reason: string, count: number): string {
		const plural = count > 1;
		switch (reason) {
			case 'like': return 'liked your post';
			case 'like-via-repost': return 'liked your repost';
			case 'repost': return 'reposted your post';
			case 'repost-via-repost': return 'reposted your repost';
			case 'follow': return plural ? 'followed you' : 'followed you';
			case 'reply': return 'replied to your post';
			case 'quote': return 'quoted your post';
			case 'mention': return 'mentioned you';
			case 'starterpack-joined': return 'joined your starter pack';
			default: return 'interacted with you';
		}
	}

	function formatTime(dateStr: string): string {
		const date = new Date(dateStr);
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffMins = Math.floor(diffMs / (1000 * 60));
		const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
		const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

		if (diffMins < 1) return 'now';
		if (diffMins < 60) return `${diffMins}m`;
		if (diffHours < 24) return `${diffHours}h`;
		if (diffDays < 7) return `${diffDays}d`;
		return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
	}

	function navigateToGroup(group: GroupedNotification) {
		const notif = group.notifications[0];
		if (notif.reason === 'follow') {
			if (group.authors.length === 1) {
				goto(`/profile/${notif.author.handle}`);
			}
			return;
		}

		if (['reply', 'quote', 'mention'].includes(notif.reason)) {
			goto(getPostHref({
				uri: notif.uri,
				record: notif.record,
				author: notif.author
			}));
			return;
		}

		if (group.reasonSubject) {
			const parts = group.reasonSubject.split('/');
			const rkey = parts[parts.length - 1];
			const did = parts[2];
			goto(`/profile/${user.profile?.handle ?? did}/post/${rkey}`);
		}
	}

	function getSubjectPostText(group: GroupedNotification): string {
		// For reply/quote/mention, the notification record is the post
		const notif = group.notifications[0];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const text = (notif.record as any)?.text;
		if (text) return text.length > 150 ? text.slice(0, 150) + '...' : text;
		return '';
	}

	function authorNames(authors: Notification['author'][], max: number = 3): string {
		const names = authors.map((a) => a.displayName || `@${a.handle}`);
		if (names.length <= max) return names.join(', ');
		return `${names.slice(0, max).join(', ')} and ${names.length - max} other${names.length - max > 1 ? 's' : ''}`;
	}
</script>

{#if !user.isLoggedIn}
	<div class="flex min-h-screen items-center justify-center">
		<div class="text-center">
			<Bell class="text-base-400 mx-auto mb-4" size={48} />
			<p class="text-base-500 text-lg">Log in to view your notifications</p>
			<button
				onclick={() => loginModalState.open = true}
				class="text-accent-500 hover:text-accent-600 mt-2 text-sm"
			>
				Log in
			</button>
		</div>
	</div>
{:else}
	<div>
		<div class="mx-auto w-full max-w-lg">
			<!-- Header -->
			<div class="flex items-center justify-between px-4 pt-4 pb-3">
				<h1 class="text-base-900 dark:text-base-100 text-lg font-semibold">Notifications</h1>
				<button
					onclick={() => refresh()}
					disabled={refreshing}
					class="text-base-500 hover:text-base-700 dark:text-base-400 dark:hover:text-base-200 rounded-lg p-2 transition-colors"
				>
					{#if refreshing}
						<Loader2 class="animate-spin" size={18} />
					{:else}
						<RefreshCw size={18} />
					{/if}
				</button>
			</div>

			{#if loading}
				<div class="flex items-center justify-center py-12">
					<Loader2 class="text-base-400 animate-spin" size={28} />
				</div>
			{:else if grouped.length === 0}
				<div class="flex flex-col items-center justify-center py-20">
					<Bell class="text-base-300 dark:text-base-600 mb-3" size={40} />
					<p class="text-base-400 text-sm">No notifications yet</p>
				</div>
			{:else}
				<div class="divide-base-200 dark:divide-base-800 divide-y">
					{#each grouped as group, i (group.notifications[0].uri + '-' + i)}
						{@const Icon = reasonIcon(group.reason)}
						{@const postText = getSubjectPostText(group)}
						{@const notif = group.notifications[0]}
						<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
						<div
							class="hover:bg-base-100 dark:hover:bg-base-800/50 cursor-pointer px-4 py-3 transition-colors {!group.isRead ? 'bg-accent-50/50 dark:bg-accent-950/20' : ''}"
							onmousedown={(e) => {
								if (e.button !== 0) return;
								if ((e.target as HTMLElement).closest('a, button')) return;
								navigateToGroup(group);
							}}
						>
							<!-- Icon + content -->
							<div class="flex gap-3">
								<div class="flex shrink-0 flex-col items-center pt-0.5">
									<Icon class={reasonColor(group.reason)} size={18} />
								</div>
								<div class="min-w-0 flex-1">
									<!-- Avatars row -->
									<div class="mb-1.5 flex items-center gap-1">
										{#each group.authors.slice(0, 8) as author}
											<button
												class="shrink-0 cursor-pointer"
												onmousedown={(e) => {
													e.stopPropagation();
													e.preventDefault();
													goto(`/profile/${author.handle}`);
												}}
											>
												<Avatar src={author.avatar} class="size-7" />
											</button>
										{/each}
										{#if group.authors.length > 8}
											<span class="text-base-400 text-xs">+{group.authors.length - 8}</span>
										{/if}
									</div>

									<!-- Text -->
									<div class="text-sm">
										<span class="text-base-900 dark:text-base-100 font-medium">
											{authorNames(group.authors)}
										</span>
										<span class="text-base-500 dark:text-base-400">
											{reasonText(group.reason, group.authors.length)}
										</span>
										<span class="text-base-400 ml-1 text-xs">
											{formatTime(group.latestAt)}
										</span>
									</div>

									<!-- Subject post preview (only for like/repost, not reply/quote/mention which show inline) -->
									{#if postText && !['reply', 'quote', 'mention'].includes(group.reason)}
										<p class="text-base-500 dark:text-base-400 mt-1.5 text-sm leading-relaxed line-clamp-3">
											{postText}
										</p>
									{/if}

									<!-- Inline post for reply/quote/mention -->
									{#if ['reply', 'quote', 'mention'].includes(group.reason)}
										{@const replyPost = (() => {
											// Build a minimal PostView-like object from the notification
											return {
												uri: notif.uri,
												cid: notif.cid,
												author: notif.author,
												record: notif.record,
												indexedAt: notif.indexedAt,
												// eslint-disable-next-line @typescript-eslint/no-explicit-any
												embed: (notif as any).embed,
												likeCount: 0,
												replyCount: 0,
												repostCount: 0
											};
										})()}
										{@const { postData, embeds } = blueskyPostToPostData(replyPost, 'https://bsky.app')}
										{@const postHref = getPostHref(replyPost)}
										<div class="mt-2 rounded-xl border border-base-200 bg-base-100/50 dark:border-base-700 dark:bg-base-950/50 p-3">
											<Post
												compact
												data={postData}
												{embeds}
												href={postHref}
												onclickhandle={(handle) => goto(`/profile/${handle}`)}
												handleHref={(handle) => `/profile/${handle}`}
											/>
										</div>
									{/if}
								</div>
							</div>
						</div>
					{/each}
				</div>

				{#if loadingMore}
					<div class="flex justify-center py-6">
						<Loader2 class="text-base-400 animate-spin" size={24} />
					</div>
				{/if}

				{#if !notifCursor && notifications.length > 0}
					<p class="text-base-400 py-6 text-center text-sm">You've reached the end</p>
				{/if}

				<div class="pb-[max(0.75rem,env(safe-area-inset-bottom))]"></div>
			{/if}
		</div>
	</div>
{/if}
