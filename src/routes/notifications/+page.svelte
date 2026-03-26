<script lang="ts">
	/* eslint-disable svelte/no-navigation-without-resolve */
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { user } from '$lib/atproto/auth.svelte';
	import { loginModalState } from '$lib/LoginModal.svelte';
	import { notificationsCache, prefetchNotifications } from '$lib/cache.svelte';
	import { listNotifications, updateSeen } from '$lib/atproto/server/notifications.remote';
	import { Avatar } from '@foxui/core';
	import { Bell, Heart, Repeat2, UserPlus, MessageCircle, Quote, AtSign, Loader2, RefreshCw } from '@lucide/svelte';
	import type { AppBskyNotificationListNotifications } from '@atcute/bluesky';

	type Notification = AppBskyNotificationListNotifications.Notification;

	let loading = $derived(!notificationsCache.loaded);
	let loadingMore = $state(false);
	let refreshing = $state(false);

	async function loadInitial() {
		try {
			await prefetchNotifications();
		} catch (e) {
			console.error('Failed to load notifications:', e);
			notificationsCache.loaded = true;
		}
	}

	async function refresh() {
		refreshing = true;
		try {
			const result = await listNotifications({});
			notificationsCache.notifications = result.notifications as Notification[];
			notificationsCache.cursor = result.cursor;
			notificationsCache.seenAt = result.seenAt;
			notificationsCache.loaded = true;
		} catch (e) {
			console.error('Failed to refresh notifications:', e);
		} finally {
			refreshing = false;
		}
	}

	async function loadMore() {
		if (loadingMore || !notificationsCache.cursor) return;
		loadingMore = true;
		try {
			const result = await listNotifications({ cursor: notificationsCache.cursor });
			const newNotifs = result.notifications as Notification[];
			notificationsCache.notifications = [...notificationsCache.notifications, ...newNotifs];
			notificationsCache.cursor = result.cursor;
		} catch (e) {
			console.error('Failed to load more notifications:', e);
		} finally {
			loadingMore = false;
		}
	}

	function handleScroll() {
		if (loadingMore || !notificationsCache.cursor) return;
		const { scrollTop, scrollHeight, clientHeight } = document.documentElement;
		if (scrollHeight - scrollTop - clientHeight < 800) {
			loadMore();
		}
	}

	onMount(() => {
		if (user.did) {
			if (notificationsCache.loaded) {
				refresh();
			} else {
				loadInitial();
			}
			// Mark as seen — clear badge immediately
			notificationsCache.unreadCount = 0;
			updateSeen({}).catch(() => {});
		} else {
			notificationsCache.loaded = true;
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

	function reasonText(reason: string): string {
		switch (reason) {
			case 'like': return 'liked your post';
			case 'like-via-repost': return 'liked your repost';
			case 'repost': return 'reposted your post';
			case 'repost-via-repost': return 'reposted your repost';
			case 'follow': return 'followed you';
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

	function getPostText(notif: Notification): string {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const record = notif.record as any;
		if (record?.text) {
			return record.text.length > 120 ? record.text.slice(0, 120) + '...' : record.text;
		}
		return '';
	}

	function navigateToNotification(notif: Notification) {
		if (notif.reason === 'follow') {
			goto(`/p/${notif.author.handle}`);
			return;
		}

		// For reply, quote, mention - the notification URI is the new post
		if (['reply', 'quote', 'mention'].includes(notif.reason)) {
			const parts = notif.uri.split('/');
			const rkey = parts[parts.length - 1];
			goto(`/p/${notif.author.handle}/post/${rkey}`);
			return;
		}

		// For like, repost - reasonSubject is the original post that was liked/reposted
		if (notif.reasonSubject) {
			const parts = notif.reasonSubject.split('/');
			const rkey = parts[parts.length - 1];
			const did = parts[2];
			// Use the profile handle from user since it's our own post
			goto(`/p/${user.profile?.handle ?? did}/post/${rkey}`);
			return;
		}
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
	<div class="flex h-dvh flex-col">
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
			{:else if notificationsCache.notifications.length === 0}
				<div class="flex flex-col items-center justify-center py-20">
					<Bell class="text-base-300 dark:text-base-600 mb-3" size={40} />
					<p class="text-base-400 text-sm">No notifications yet</p>
				</div>
			{:else}
				<div class="divide-base-200 dark:divide-base-800 divide-y">
					{#each notificationsCache.notifications as notif, i (notif.uri + '-' + i)}
						{@const Icon = reasonIcon(notif.reason)}
						{@const postText = getPostText(notif)}
						<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
						<div
							class="hover:bg-base-100 dark:hover:bg-base-800/50 flex cursor-pointer gap-3 px-4 py-3 transition-colors {!notif.isRead ? 'bg-accent-50/50 dark:bg-accent-950/20' : ''}"
							onmousedown={(e) => {
								if (e.button !== 0) return;
								if ((e.target as HTMLElement).closest('a, button')) return;
								navigateToNotification(notif);
							}}
						>
							<!-- Content -->
							<div class="min-w-0 flex-1">
								<div class="mb-1 flex items-center gap-2">
									<button
										class="relative shrink-0"
										onmousedown={(e) => {
											e.stopPropagation();
											e.preventDefault();
											goto(`/p/${notif.author.handle}`);
										}}
									>
										<Avatar src={notif.author.avatar} class="size-8" />
										<div class="absolute -right-1 -bottom-1 rounded-full bg-white p-0.5 dark:bg-base-900">
											<Icon class={reasonColor(notif.reason)} size={12} />
										</div>
									</button>
									<div class="min-w-0 flex-1">
										<button
											class="text-base-900 dark:text-base-100 hover:underline text-sm font-medium"
											onmousedown={(e) => {
												e.stopPropagation();
												e.preventDefault();
												goto(`/p/${notif.author.handle}`);
											}}
										>
											@{notif.author.handle}
										</button>
										<span class="text-base-500 dark:text-base-400 text-sm">
											{reasonText(notif.reason)}
										</span>
									</div>
									<span class="text-base-400 shrink-0 text-xs">
										{formatTime(notif.indexedAt)}
									</span>
								</div>

								<!-- Post content preview for reply/quote/mention -->
								{#if ['reply', 'quote', 'mention'].includes(notif.reason) && postText}
									<p class="text-base-600 dark:text-base-400 ml-10 text-sm leading-relaxed">
										{postText}
									</p>
								{/if}
							</div>
						</div>
					{/each}
				</div>

				{#if loadingMore}
					<div class="flex justify-center py-6">
						<Loader2 class="text-base-400 animate-spin" size={24} />
					</div>
				{/if}

				{#if !notificationsCache.cursor && notificationsCache.notifications.length > 0}
					<p class="text-base-400 py-6 text-center text-sm">You've reached the end</p>
				{/if}

				<div class="pb-[max(0.75rem,env(safe-area-inset-bottom))]"></div>
			{/if}
		</div>
	</div>
{/if}
