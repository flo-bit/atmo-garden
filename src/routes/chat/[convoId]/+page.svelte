<script lang="ts">
	/* eslint-disable svelte/no-navigation-without-resolve */
	import { untrack } from 'svelte';
	import { user } from '$lib/atproto/auth.svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { getMessages, sendMessage, acceptConvo, updateRead } from '$lib/atproto/server/chat.remote';
	import { convoCache, getCachedMessages, setCachedMessages, markConvoRead } from '$lib/cache.svelte';
	import type { ChatBskyConvoDefs } from '@atcute/bluesky';
	import { ArrowLeft, Send, Loader2 } from '@lucide/svelte';
	import { Avatar } from '@foxui/core';

	type MessageView = ChatBskyConvoDefs.MessageView;
	type DeletedMessageView = ChatBskyConvoDefs.DeletedMessageView;
	type ConvoView = ChatBskyConvoDefs.ConvoView;

	let convoId = $derived(page.params.convoId);

	let loading = $state(true);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let messages = $state<any[]>([]);
	let convo = $state<ConvoView | null>(null);
	let isRequest = $derived(convo?.status === 'request');
	let member = $derived(
		convo ? (convo.members.find((m) => m.did !== user.did) ?? convo.members[0]) : null
	);

	let extraMessages = $state<MessageView[]>([]);
	let pendingMessages = $state<{ id: string; text: string; sentAt: string }[]>([]);
	let messageText = $state('');
	let loadingOlder = $state(false);
	let cursor = $state<string | null>(null);
	let messagesContainer: HTMLDivElement | undefined = $state(undefined);

	let allMessages = $derived([...[...messages].reverse(), ...extraMessages]);

	function isMessageView(msg: MessageView | DeletedMessageView): msg is MessageView {
		return msg.$type !== 'chat.bsky.convo.defs#deletedMessageView';
	}

	function formatMessageTime(dateStr: string): string {
		return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	}

	function shouldShowHeader(index: number): boolean {
		if (index === 0) return true;
		const current = allMessages[index];
		const prev = allMessages[index - 1];
		if (!current || !prev) return true;
		if (!isMessageView(prev)) return true;
		if (current.sender.did !== prev.sender.did) return true;
		const diff = new Date(current.sentAt).getTime() - new Date(prev.sentAt).getTime();
		return diff > 5 * 60 * 1000;
	}

	function scrollToBottom() {
		if (messagesContainer) {
			messagesContainer.scrollTop = messagesContainer.scrollHeight;
		}
	}

	async function loadConvo() {
		// Try cache for instant display
		const allConvos = [...convoCache.acceptedConvos, ...convoCache.requestConvos];
		convo = allConvos.find((c) => c.id === convoId) ?? null;

		const cached = await getCachedMessages(convoId);
		if (cached) {
			messages = cached;
			loading = false;
			extraMessages = [];
			requestAnimationFrame(scrollToBottom);
		} else {
			loading = true;
		}

		// Always fetch fresh messages
		try {
			const msgsRes = await getMessages({ convoId });
			messages = msgsRes.messages;
			cursor = msgsRes.cursor;
			setCachedMessages(convoId, messages);
			extraMessages = [];

			updateRead({ convoId }).catch(() => {});
			markConvoRead(convoId);
			requestAnimationFrame(scrollToBottom);
		} catch (e) {
			console.error('Failed to load conversation:', e);
		} finally {
			loading = false;
		}
	}

	async function loadOlder() {
		if (loadingOlder || !cursor || !convoId) return;
		loadingOlder = true;
		const prevHeight = messagesContainer?.scrollHeight ?? 0;
		try {
			const res = await getMessages({ convoId, cursor });
			messages = [...messages, ...res.messages];
			cursor = res.cursor;
			setCachedMessages(convoId, messages);
			// Preserve scroll position
			requestAnimationFrame(() => {
				if (messagesContainer) {
					messagesContainer.scrollTop = messagesContainer.scrollHeight - prevHeight;
				}
			});
		} catch (e) {
			console.error('Failed to load older messages:', e);
		} finally {
			loadingOlder = false;
		}
	}

	function handleMessagesScroll() {
		if (!messagesContainer || loadingOlder || !cursor) return;
		if (messagesContainer.scrollTop < 200) {
			loadOlder();
		}
	}

	$effect(() => {
		convoId; // track
		untrack(() => loadConvo());
	});

	async function handleAccept() {
		try {
			await acceptConvo({ convoId });
			await loadConvo();
		} catch (e) {
			console.error('Failed to accept convo:', e);
		}
	}

	async function handleSend() {
		if (!messageText.trim()) return;
		const text = messageText.trim();
		const pendingId = `pending-${Date.now()}`;
		messageText = '';

		// Show immediately as pending
		pendingMessages = [...pendingMessages, { id: pendingId, text, sentAt: new Date().toISOString() }];
		requestAnimationFrame(scrollToBottom);

		try {
			const result = await sendMessage({ convoId, text });
			// Replace pending with real message
			pendingMessages = pendingMessages.filter((m) => m.id !== pendingId);
			extraMessages = [...extraMessages, result as MessageView];
		} catch {
			// Keep pending message visible but could mark as failed
			pendingMessages = pendingMessages.filter((m) => m.id !== pendingId);
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	}
</script>

{#if loading}
	<div class="flex flex-1 items-center justify-center">
		<Loader2 class="text-base-400 animate-spin" size={28} />
	</div>
{:else if !member}
	<div class="flex flex-1 items-center justify-center">
		<p class="text-base-400 text-sm">Conversation not found</p>
	</div>
{:else}
	<!-- Header -->
	<div class="border-base-200 bg-base-50 dark:border-base-800 dark:bg-base-900 flex items-center gap-3 border-b px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3">
		<a
			href="/chat"
			class="text-base-500 hover:text-base-700 dark:hover:text-base-200 transition-colors md:hidden"
		>
			<ArrowLeft size={20} />
		</a>

		<button onclick={() => goto(`/p/${member.handle}`)} class="cursor-pointer">
			<Avatar src={member.avatar} class="size-8" />
		</button>

		<button onclick={() => goto(`/p/${member.handle}`)} class="cursor-pointer text-left">
			<p class="text-base-900 dark:text-base-100 text-sm font-medium">
				{member.displayName ?? member.handle}
			</p>
			<p class="text-base-400 text-xs">@{member.handle}</p>
		</button>
	</div>

	<!-- Messages -->
	<div
		bind:this={messagesContainer}
		onscroll={handleMessagesScroll}
		class="flex flex-1 flex-col gap-2 overflow-y-auto px-4 py-4"
	>
		{#if loadingOlder}
			<div class="flex justify-center py-2">
				<Loader2 class="text-base-400 animate-spin" size={18} />
			</div>
		{/if}
		{#if allMessages.length === 0}
			<div class="flex flex-1 items-center justify-center">
				<p class="text-base-400 text-sm">No messages yet. Say hello!</p>
			</div>
		{:else}
			{#each allMessages as msg, i (msg.id)}
				{@const isOwn = msg.sender.did === user.did}
				{@const showHeader = shouldShowHeader(i)}
				{#if isMessageView(msg)}
					<div class="flex items-start gap-3 px-1 {showHeader ? 'mt-2 py-0.5' : 'py-0'}">
						{#if showHeader}
							<button class="shrink-0 cursor-pointer" onmousedown={() => goto(`/p/${isOwn ? (user.profile?.handle ?? user.did) : member.handle}`)}>
								<Avatar src={isOwn ? user.profile?.avatar : member.avatar} class="mt-0.5 size-8" />
							</button>
						{:else}
							<div class="w-8 shrink-0"></div>
						{/if}
						<div class="min-w-0 flex-1">
							{#if showHeader}
								<div class="flex items-baseline gap-2">
									<button class="cursor-pointer text-sm font-medium hover:underline {isOwn ? 'text-accent-500' : 'text-base-900 dark:text-base-100'}" onmousedown={() => goto(`/p/${isOwn ? (user.profile?.handle ?? user.did) : member.handle}`)}>
										{isOwn ? (user.profile?.displayName ?? 'You') : (member.displayName ?? member.handle)}
									</button>
									<span class="text-base-400 text-[10px]">
										{formatMessageTime(msg.sentAt)}
									</span>
								</div>
							{/if}
							<p class="text-base-800 dark:text-base-200 whitespace-pre-wrap break-words text-sm">{msg.text}</p>
						</div>
					</div>
				{:else}
					<div class="px-1 py-0.5">
						<p class="text-base-400 text-xs italic">Message deleted</p>
					</div>
				{/if}
			{/each}

			<!-- Pending messages -->
			{#each pendingMessages as msg (msg.id)}
				{@const showHeader = allMessages.length === 0 && pendingMessages[0]?.id === msg.id
					? true
					: (() => {
						const lastReal = allMessages[allMessages.length - 1];
						const prevPendingIdx = pendingMessages.indexOf(msg) - 1;
						const prev = prevPendingIdx >= 0 ? pendingMessages[prevPendingIdx] : lastReal;
						if (!prev) return true;
						const prevDid = 'sender' in prev ? prev.sender.did : user.did;
						if (prevDid !== user.did) return true;
						const prevTime = 'sentAt' in prev ? prev.sentAt : '';
						return new Date(msg.sentAt).getTime() - new Date(prevTime).getTime() > 5 * 60 * 1000;
					})()}
				<div class="group flex animate-pulse items-start gap-3 px-1 opacity-60 {showHeader ? 'mt-2 py-0.5' : 'py-0'}">
					{#if showHeader}
						<Avatar src={user.profile?.avatar} class="mt-0.5 size-8 shrink-0" />
					{:else}
						<div class="w-8 shrink-0"></div>
					{/if}
					<div class="min-w-0 flex-1">
						{#if showHeader}
							<div class="flex items-baseline gap-2">
								<span class="text-accent-500 text-sm font-medium">
									{user.profile?.displayName ?? 'You'}
								</span>
								<span class="text-base-400 text-[10px]">
									{formatMessageTime(msg.sentAt)}
								</span>
							</div>
						{/if}
						<p class="text-base-800 dark:text-base-200 whitespace-pre-wrap break-words text-sm">{msg.text}</p>
					</div>
				</div>
			{/each}
		{/if}
	</div>

	<!-- Input / Accept bar -->
	{#if isRequest}
		<div class="border-base-200 bg-base-50 dark:border-base-800 dark:bg-base-900 border-t px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
			<div class="flex flex-col items-center gap-2">
				<p class="text-base-500 dark:text-base-400 text-sm">
					<span class="text-base-700 dark:text-base-200 font-medium">{member.displayName ?? member.handle}</span> wants to message you
				</p>
				<div class="flex gap-2">
					<button
						type="button"
						onclick={handleAccept}
						class="bg-accent-500 hover:bg-accent-600 rounded-full px-5 py-2 text-sm font-medium text-white transition-colors"
					>
						Accept
					</button>
					<a
						href="/chat"
						class="border-base-300 text-base-600 hover:bg-base-100 dark:border-base-600 dark:text-base-300 dark:hover:bg-base-800 rounded-full border px-5 py-2 text-sm font-medium transition-colors"
					>
						Ignore
					</a>
				</div>
			</div>
		</div>
	{:else}
		<div class="border-base-200 bg-base-50 dark:border-base-800 dark:bg-base-900 border-t px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
			<div class="flex items-center gap-2">
				<input
					type="text"
					bind:value={messageText}
					onkeydown={handleKeydown}
					placeholder="Type a message..."
		class="border-base-200 text-base-900 placeholder:text-base-400 focus:border-accent-400 focus:ring-accent-400 dark:border-base-700 dark:bg-base-800 dark:text-base-100 dark:placeholder:text-base-500 dark:focus:border-accent-500 flex-1 rounded-full border bg-white px-4 py-2 text-base focus:ring-1 focus:outline-none disabled:opacity-50"
				/>
				<button
					type="button"
					onclick={handleSend}
					disabled={!messageText.trim()}
					class="bg-accent-500 hover:bg-accent-600 disabled:hover:bg-accent-500 flex h-9 w-9 items-center justify-center rounded-full text-white transition-colors disabled:opacity-40"
				>
					<Send size={16} />
				</button>
			</div>
		</div>
	{/if}
{/if}
