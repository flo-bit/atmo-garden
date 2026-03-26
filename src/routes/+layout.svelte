<script lang="ts">
	import '../app.css';
	import { onMount, onDestroy } from 'svelte';
	import { Head, ThemeToggle, Avatar, Button } from '@foxui/core';
	import { House, MessageCircle, Bell } from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import { user } from '$lib/atproto/auth.svelte';
	import { notificationsCache, startUnreadPoll, stopUnreadPoll, chatUnreadCount, startChatPoll, stopChatPoll, applyPendingFeed, startFeedPoll, stopFeedPoll } from '$lib/cache.svelte';
	import LoginModal, { loginModalState } from '$lib/LoginModal.svelte';
	import Sidebar from '$lib/Sidebar.svelte';
	let { children } = $props();

	onMount(() => {
		if (user.did) {
			startUnreadPoll();
			startChatPoll();
			startFeedPoll();
		}
	});

	onDestroy(() => {
		stopUnreadPoll();
		stopChatPoll();
		stopFeedPoll();
	});
</script>

<Sidebar>
	<Button href="/" onmousedown={(e: MouseEvent) => { e.preventDefault(); applyPendingFeed(); window.scrollTo(0, 0); goto('/'); }} variant="ghost" size="icon">
		<House size={20} />
	</Button>
	<Button href="/chat" onmousedown={(e: MouseEvent) => { e.preventDefault(); goto('/chat'); }} variant="ghost" size="icon" class="relative">
		<MessageCircle size={20} />
		{#if chatUnreadCount.count > 0}
			<span class="bg-accent-500 absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white">
				{chatUnreadCount.count > 99 ? '99+' : chatUnreadCount.count}
			</span>
		{/if}
	</Button>
	<Button href="/notifications" onmousedown={(e: MouseEvent) => { e.preventDefault(); goto('/notifications'); }} variant="ghost" size="icon" class="relative">
		<Bell size={20} />
		{#if notificationsCache.unreadCount > 0}
			<span class="bg-accent-500 absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white">
				{notificationsCache.unreadCount > 99 ? '99+' : notificationsCache.unreadCount}
			</span>
		{/if}
	</Button>
	<ThemeToggle class="mt-auto" />
	{#if user.did}
		{@const profileHref = `/p/${user.profile?.handle ?? user.did}`}
		<Button href={profileHref} onmousedown={(e: MouseEvent) => { e.preventDefault(); goto(profileHref); }} variant="ghost" size="icon" class="mb-2">
			<Avatar src={user.profile?.avatar} class="size-8" />
		</Button>
	{:else}
		<Button onclick={() => loginModalState.open = true} variant="ghost" size="icon" class="mb-2">
			<Avatar class="size-8" />
		</Button>
	{/if}
</Sidebar>

<div class="lg:ml-20">
	{@render children()}
</div>

<LoginModal />

<Head
	title="statusphere"
	emojiFavicon="🥳"
	description="svelte + cloudflare workers statusphere"
	image="/og.png"
/>
