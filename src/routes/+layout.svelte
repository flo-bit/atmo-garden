<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { Head, Avatar, Button, ThemeToggle } from '@foxui/core';
	import { House, MessageCircle, Bell, Search, Bookmark, Settings, Menu, X } from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { user } from '$lib/atproto/auth.svelte';
	import { getUnreadCount } from '$lib/atproto/server/notifications.remote';
	import { listConvos } from '$lib/atproto/server/chat.remote';
	import LoginModal, { loginModalState } from '$lib/LoginModal.svelte';
	import ImageLightbox from '$lib/components/embed/ImageLightbox.svelte';
	import ScrollToTop from '$lib/components/ScrollToTop.svelte';
	import Sidebar from '$lib/Sidebar.svelte';
	let { children } = $props();

	let menuOpen = $state(false);
	let notifUnread = $state(0);
	let chatUnread = $state(0);
	let path = $derived(page.url?.pathname ?? '/');
	function isActive(href: string): boolean {
		if (href === '/') return path === '/';
		return path.startsWith(href);
	}
	function navClass(href: string): string {
		return isActive(href) ? 'text-accent-600 dark:text-accent-400' : '';
	}

	onMount(async () => {
		if (!user.did) return;
		try {
			const [notifRes, convosRes] = await Promise.all([
				getUnreadCount({}),
				listConvos({ status: 'accepted' })
			]);
			notifUnread = notifRes.count;
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			chatUnread = (convosRes.convos as any[]).reduce((s, c) => s + (c.unreadCount ?? 0), 0);
		} catch {
			// silent
		}
	});
</script>

<Sidebar>
	<Button href="/" onmousedown={(e: MouseEvent) => { e.preventDefault(); window.scrollTo(0, 0); goto('/'); }} variant="ghost" size="icon" class={navClass('/')}>
		<House size={20} strokeWidth={isActive('/') ? 2.5 : 2} />
	</Button>
	<Button href="/search" onmousedown={(e: MouseEvent) => { e.preventDefault(); goto('/search'); }} variant="ghost" size="icon" class={navClass('/search')}>
		<Search size={20} strokeWidth={isActive('/search') ? 2.5 : 2} />
	</Button>
	<Button href="/chat" onmousedown={(e: MouseEvent) => { e.preventDefault(); goto('/chat'); }} variant="ghost" size="icon" class="relative {navClass('/chat')}">
		<MessageCircle size={20} strokeWidth={isActive('/chat') ? 2.5 : 2} />
		{#if chatUnread > 0}
			<span class="bg-accent-500 absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white">
				{chatUnread > 99 ? '99+' : chatUnread}
			</span>
		{/if}
	</Button>
	<Button href="/notifications" onmousedown={(e: MouseEvent) => { e.preventDefault(); goto('/notifications'); }} variant="ghost" size="icon" class="relative {navClass('/notifications')}">
		<Bell size={20} strokeWidth={isActive('/notifications') ? 2.5 : 2} />
		{#if notifUnread > 0}
			<span class="bg-accent-500 absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white">
				{notifUnread > 99 ? '99+' : notifUnread}
			</span>
		{/if}
	</Button>
	{#if user.did}
		<Button href="/bookmarks" onmousedown={(e: MouseEvent) => { e.preventDefault(); goto('/bookmarks'); }} variant="ghost" size="icon" class={navClass('/bookmarks')}>
			<Bookmark size={20} strokeWidth={isActive('/bookmarks') ? 2.5 : 2} />
		</Button>
	{/if}
	<Button href="/settings" onmousedown={(e: MouseEvent) => { e.preventDefault(); goto('/settings'); }} variant="ghost" size="icon" class="mt-auto {navClass('/settings')}">
		<Settings size={20} strokeWidth={isActive('/settings') ? 2.5 : 2} />
	</Button>
	<ThemeToggle />
	{#if user.did}
		{@const profileHref = `/profile/${user.profile?.handle ?? user.did}`}
		<Button href={profileHref} onmousedown={(e: MouseEvent) => { e.preventDefault(); goto(profileHref); }} variant="ghost" size="icon" class="mb-2">
			<Avatar src={user.profile?.avatar} class="size-8" />
		</Button>
	{:else}
		<Button onclick={() => loginModalState.open = true} variant="ghost" size="icon" class="mb-2">
			<Avatar class="size-8" />
		</Button>
	{/if}
</Sidebar>

<div class="overflow-x-hidden pb-18 lg:ml-20 lg:pb-0">
	{@render children()}
</div>

<!-- Mobile menu overlay -->
{#if menuOpen}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="fixed inset-0 z-40 bg-black/30 backdrop-blur-xs lg:hidden" onclick={() => menuOpen = false}></div>
{/if}

<!-- Mobile bottom navbar -->
<nav class="border-base-400/40 dark:border-base-300/10 bg-base-200/80 dark:bg-base-950/80 inset-shadow-base-800/10 fixed bottom-2 left-3 right-3 z-50 overflow-hidden rounded-3xl border p-1.5 backdrop-blur-lg lg:hidden dark:inset-shadow-black/50" style="padding-bottom: max(0.375rem, env(safe-area-inset-bottom));">
	{#if menuOpen}
		<!-- Expanded menu -->
		<div class="relative flex flex-col gap-0.5 px-1 py-1">
			<button
				onclick={() => menuOpen = false}
				class="absolute top-1 right-1 flex items-center justify-center rounded-full p-2 cursor-pointer text-accent-600 dark:text-accent-400"
			>
				<X size={22} strokeWidth={2.5} />
			</button>
			<a
				href="/"
				onmousedown={(e) => { e.preventDefault(); menuOpen = false; window.scrollTo(0, 0); goto('/'); }}
				class="flex items-center gap-3 rounded-full px-4 py-2 text-sm transition-colors {navClass('/')}"
			>
				<House size={20} strokeWidth={isActive('/') ? 2.5 : 2} />
				<span class="font-medium">Home</span>
			</a>
			<a
				href="/search"
				onmousedown={(e) => { e.preventDefault(); menuOpen = false; goto('/search'); }}
				class="flex items-center gap-3 rounded-full px-4 py-2 text-sm transition-colors {navClass('/search')}"
			>
				<Search size={20} strokeWidth={isActive('/search') ? 2.5 : 2} />
				<span class="font-medium">Search</span>
			</a>
			<a
				href="/chat"
				onmousedown={(e) => { e.preventDefault(); menuOpen = false; goto('/chat'); }}
				class="relative flex items-center gap-3 rounded-full px-4 py-2 text-sm transition-colors {navClass('/chat')}"
			>
				<MessageCircle size={20} strokeWidth={isActive('/chat') ? 2.5 : 2} />
				<span class="font-medium">Messages</span>
				{#if chatUnread > 0}
					<span class="bg-accent-500 ml-auto flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] font-bold text-white">
						{chatUnread > 99 ? '99+' : chatUnread}
					</span>
				{/if}
			</a>
			<a
				href="/notifications"
				onmousedown={(e) => { e.preventDefault(); menuOpen = false; goto('/notifications'); }}
				class="relative flex items-center gap-3 rounded-full px-4 py-2 text-sm transition-colors {navClass('/notifications')}"
			>
				<Bell size={20} strokeWidth={isActive('/notifications') ? 2.5 : 2} />
				<span class="font-medium">Notifications</span>
				{#if notifUnread > 0}
					<span class="bg-accent-500 ml-auto flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] font-bold text-white">
						{notifUnread > 99 ? '99+' : notifUnread}
					</span>
				{/if}
			</a>
			{#if user.did}
				<a
					href="/bookmarks"
					onmousedown={(e) => { e.preventDefault(); menuOpen = false; goto('/bookmarks'); }}
					class="flex items-center gap-3 rounded-full px-4 py-2 text-sm transition-colors {navClass('/bookmarks')}"
				>
					<Bookmark size={20} strokeWidth={isActive('/bookmarks') ? 2.5 : 2} />
					<span class="font-medium">Bookmarks</span>
				</a>
				{@const profileHref = `/profile/${user.profile?.handle ?? user.did}`}
				<a
					href={profileHref}
					onmousedown={(e) => { e.preventDefault(); menuOpen = false; goto(profileHref); }}
					class="flex items-center gap-3 rounded-full px-4 py-2 text-sm transition-colors {navClass('/profile')}"
				>
					<Avatar src={user.profile?.avatar} class="size-5" />
					<span class="font-medium">Profile</span>
				</a>
			{/if}
			<a
				href="/settings"
				onmousedown={(e) => { e.preventDefault(); menuOpen = false; goto('/settings'); }}
				class="flex items-center gap-3 rounded-full px-4 py-2 text-sm transition-colors {navClass('/settings')}"
			>
				<Settings size={20} strokeWidth={isActive('/settings') ? 2.5 : 2} />
				<span class="font-medium">Settings</span>
			</a>
		</div>
	{:else}
		<!-- Collapsed navbar icons -->
		<div class="flex items-center justify-around">
			<a
				href="/"
				onmousedown={(e) => { e.preventDefault(); window.scrollTo(0, 0); goto('/'); }}
				class="flex items-center justify-center p-2 {navClass('/')}"
			>
				<House size={22} strokeWidth={isActive('/') ? 2.5 : 2} />
			</a>
			<a
				href="/chat"
				onmousedown={(e) => { e.preventDefault(); goto('/chat'); }}
				class="relative flex items-center justify-center p-2 {navClass('/chat')}"
			>
				<MessageCircle size={22} strokeWidth={isActive('/chat') ? 2.5 : 2} />
				{#if chatUnread > 0}
					<span class="bg-accent-500 absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white">
						{chatUnread > 99 ? '99+' : chatUnread}
					</span>
				{/if}
			</a>
			<a
				href="/notifications"
				onmousedown={(e) => { e.preventDefault(); goto('/notifications'); }}
				class="relative flex items-center justify-center p-2 {navClass('/notifications')}"
			>
				<Bell size={22} strokeWidth={isActive('/notifications') ? 2.5 : 2} />
				{#if notifUnread > 0}
					<span class="bg-accent-500 absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white">
						{notifUnread > 99 ? '99+' : notifUnread}
					</span>
				{/if}
			</a>
			{#if user.did}
				{@const profileHref = `/profile/${user.profile?.handle ?? user.did}`}
				<a
					href={profileHref}
					onmousedown={(e) => { e.preventDefault(); goto(profileHref); }}
					class="flex items-center justify-center p-2"
				>
					<Avatar src={user.profile?.avatar} class="size-6" />
				</a>
			{:else}
				<button
					onclick={() => loginModalState.open = true}
					class="flex items-center justify-center p-2 cursor-pointer"
				>
					<Avatar class="size-6" />
				</button>
			{/if}
			<button
				onclick={() => menuOpen = true}
				class="flex items-center justify-center p-2 cursor-pointer"
			>
				<Menu size={22} />
			</button>
		</div>
	{/if}
</nav>

<LoginModal />
<ImageLightbox />
<ScrollToTop />

<Head
	title="atmo.social"
	emojiFavicon="🌩️"
	description="bsky client"
/>
