<script lang="ts">
	/* eslint-disable svelte/no-navigation-without-resolve */
	import { untrack } from 'svelte';
	import { user } from '$lib/atproto/auth.svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { getMessages, sendMessage, acceptConvo, updateRead, addReaction, removeReaction, deleteMessage } from '$lib/atproto/server/chat.remote';
	import { convoCache, getCachedMessages, setCachedMessages, markConvoRead } from '$lib/cache.svelte';
	import type { ChatBskyConvoDefs } from '@atcute/bluesky';
	import { ArrowLeft, Send, Loader2, SmilePlus, Trash2 } from '@lucide/svelte';
	import { Avatar, sanitize } from '@foxui/core';
	import { PopoverEmojiPicker } from '$lib/components/emoji-picker';
	import { RichText, resolveHrefs, convertEmbed } from '$lib/components/bluesky-post';
	import type { Embed } from '$lib/components/embed';
	import Embed_ from '$lib/components/embed/Embed.svelte';

	type MessageView = ChatBskyConvoDefs.MessageView;
	type DeletedMessageView = ChatBskyConvoDefs.DeletedMessageView;
	type ConvoView = ChatBskyConvoDefs.ConvoView;

	const QUICK_EMOJIS = ['❤️', '😂', '👍', '😮', '🔥'];

	const hrefs = resolveHrefs('https://bsky.app', {
		profile: (handle, did) => `/profile/${did ?? handle}`,
		post: (handle, postId) => `/profile/${handle}/post/${postId}`,
		hashtag: (tag) => `/hashtag/${tag}`
	});

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
	let hoveredMessageId = $state<string | null>(null);
	let emojiPickerMessageId = $state<string | null>(null);

	// Optimistic state: pending reactions and deletions
	let pendingReactions = $state<Record<string, { value: string; adding: boolean }[]>>({});
	let pendingDeletions = $state<Set<string>>(new Set());

	let allMessages = $derived([...[...messages].reverse(), ...extraMessages]);

	function isMessageView(msg: MessageView | DeletedMessageView): msg is MessageView {
		return msg.$type !== 'chat.bsky.convo.defs#deletedMessageView';
	}

	function isDeleted(msgId: string): boolean {
		return pendingDeletions.has(msgId);
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

	function renderMessageHtml(msg: MessageView): string {
		if (!msg.text) return '';
		const html = RichText({ text: msg.text, facets: msg.facets }, hrefs);
		return html.replace(/\n/g, '<br>');
	}

	function getMessageEmbeds(msg: MessageView): Embed[] {
		if (!msg.embed) return [];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const embed = convertEmbed(msg.embed as any, hrefs);
		return embed ? [embed] : [];
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	function getReactions(msg: any): { value: string; count: number; mine: boolean; pending: boolean }[] {
		const grouped = new Map<string, { count: number; mine: boolean; pending: boolean }>();

		// Real reactions from API
		if (msg.reactions?.length) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			for (const r of msg.reactions) {
				const existing = grouped.get(r.value);
				if (existing) {
					existing.count++;
					if (r.sender?.did === user.did) existing.mine = true;
				} else {
					grouped.set(r.value, { count: 1, mine: r.sender?.did === user.did, pending: false });
				}
			}
		}

		// Apply optimistic reactions
		const pending = pendingReactions[msg.id] ?? [];
		for (const p of pending) {
			const existing = grouped.get(p.value);
			if (p.adding) {
				if (existing) {
					if (!existing.mine) { existing.count++; existing.mine = true; existing.pending = true; }
				} else {
					grouped.set(p.value, { count: 1, mine: true, pending: true });
				}
			} else {
				if (existing?.mine) {
					existing.count--;
					existing.mine = false;
					existing.pending = true;
					if (existing.count <= 0) grouped.delete(p.value);
				}
			}
		}

		return [...grouped.entries()].map(([value, data]) => ({ value, ...data }));
	}

	async function handleReaction(messageId: string, emoji: string, alreadyMine: boolean) {
		emojiPickerMessageId = null;
		const adding = !alreadyMine;

		// Optimistic update
		pendingReactions[messageId] = [...(pendingReactions[messageId] ?? []), { value: emoji, adding }];
		pendingReactions = { ...pendingReactions }; // trigger reactivity

		try {
			if (adding) {
				await addReaction({ convoId, messageId, value: emoji });
			} else {
				await removeReaction({ convoId, messageId, value: emoji });
			}
			// Refresh to get confirmed state
			const msgsRes = await getMessages({ convoId });
			messages = msgsRes.messages;
			cursor = msgsRes.cursor;
			setCachedMessages(convoId, messages);
			extraMessages = [];
		} catch (e) {
			console.error('Failed to toggle reaction:', e);
		} finally {
			// Clear pending for this message
			delete pendingReactions[messageId];
			pendingReactions = { ...pendingReactions };
		}
	}

	async function handleDelete(messageId: string) {
		// Optimistic update
		pendingDeletions = new Set([...pendingDeletions, messageId]);

		try {
			await deleteMessage({ convoId, messageId });
			// Update real state
			messages = messages.map((m) =>
				m.id === messageId
					? { ...m, $type: 'chat.bsky.convo.defs#deletedMessageView', text: undefined }
					: m
			);
			extraMessages = extraMessages.filter((m) => m.id !== messageId);
			setCachedMessages(convoId, messages);
		} catch (e) {
			console.error('Failed to delete message:', e);
		} finally {
			const next = new Set(pendingDeletions);
			next.delete(messageId);
			pendingDeletions = next;
		}
	}

	function scrollToBottom() {
		if (messagesContainer) {
			messagesContainer.scrollTop = messagesContainer.scrollHeight;
		}
	}

	async function loadConvo() {
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
		convoId;
		untrack(() => {
			pendingReactions = {};
			pendingDeletions = new Set();
			emojiPickerMessageId = null;
			loadConvo();
		});
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

		pendingMessages = [...pendingMessages, { id: pendingId, text, sentAt: new Date().toISOString() }];
		requestAnimationFrame(scrollToBottom);

		try {
			const result = await sendMessage({ convoId, text });
			pendingMessages = pendingMessages.filter((m) => m.id !== pendingId);
			extraMessages = [...extraMessages, result as MessageView];
		} catch {
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

<div class="flex min-h-0 flex-1 flex-col">
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

		<button onclick={() => goto(`/profile/${member.handle}`)} class="cursor-pointer">
			<Avatar src={member.avatar} class="size-8" />
		</button>

		<button onclick={() => goto(`/profile/${member.handle}`)} class="cursor-pointer text-left">
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
				{@const deleted = isDeleted(msg.id)}
				{#if deleted || !isMessageView(msg)}
					<div class="flex items-start gap-3 px-1 {showHeader ? 'mt-2 py-0.5' : 'py-0'} {deleted ? 'animate-pulse opacity-40' : ''}">
						{#if showHeader}
							<div class="mt-0.5 size-8 shrink-0"></div>
						{:else}
							<div class="w-8 shrink-0"></div>
						{/if}
						<p class="text-base-400 text-xs italic">Message deleted</p>
					</div>
				{:else}
					{@const html = renderMessageHtml(msg)}
					{@const embeds = getMessageEmbeds(msg)}
					{@const reactions = getReactions(msg)}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="group relative flex items-start gap-3 px-1 {showHeader ? 'mt-2 py-0.5' : 'py-0'}"
						onmouseenter={() => hoveredMessageId = msg.id}
						onmouseleave={() => { if (emojiPickerMessageId !== msg.id) hoveredMessageId = null; }}
					>
						{#if showHeader}
							<button class="shrink-0 cursor-pointer" onmousedown={() => goto(`/profile/${isOwn ? (user.profile?.handle ?? user.did) : member.handle}`)}>
								<Avatar src={isOwn ? user.profile?.avatar : member.avatar} class="mt-0.5 size-8" />
							</button>
						{:else}
							<div class="w-8 shrink-0"></div>
						{/if}
						<div class="min-w-0 flex-1">
							{#if showHeader}
								<div class="flex items-baseline gap-2">
									<button class="cursor-pointer text-sm font-medium hover:underline {isOwn ? 'text-accent-500' : 'text-base-900 dark:text-base-100'}" onmousedown={() => goto(`/profile/${isOwn ? (user.profile?.handle ?? user.did) : member.handle}`)}>
										{isOwn ? (user.profile?.displayName ?? 'You') : (member.displayName ?? member.handle)}
									</button>
									<span class="text-base-400 text-[10px]">
										{formatMessageTime(msg.sentAt)}
									</span>
								</div>
							{/if}
							{#if html}
								<div class="chat-message text-base-800 dark:text-base-200 whitespace-pre-wrap break-words text-sm">
									{@html sanitize(html, { ADD_ATTR: ['target', 'rel'] })}
								</div>
							{/if}
							{#if embeds.length > 0}
								{#each embeds as embed}
									<Embed_ {embed} />
								{/each}
							{/if}

							<!-- Reactions -->
							{#if reactions.length > 0}
								<div class="mt-1 flex flex-wrap gap-1">
									{#each reactions as reaction}
										<button
											class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors cursor-pointer
												{reaction.mine ? 'border-accent-400 bg-accent-50 dark:bg-accent-950/30 dark:border-accent-600' : 'border-base-200 dark:border-base-700 hover:bg-base-100 dark:hover:bg-base-800'}
												{reaction.pending ? 'animate-pulse opacity-60' : ''}"
											onclick={() => handleReaction(msg.id, reaction.value, reaction.mine)}
										>
											<span>{reaction.value}</span>
											{#if reaction.count > 1}
												<span class="text-base-500">{reaction.count}</span>
											{/if}
										</button>
									{/each}
								</div>
							{/if}
						</div>

						<!-- Hover actions: quick emojis + emoji picker + delete -->
						{#if hoveredMessageId === msg.id || emojiPickerMessageId === msg.id}
							<div class="absolute -top-3 right-1 flex items-center gap-0.5 rounded-lg border border-base-200 bg-white px-1 py-0.5 shadow-sm dark:border-base-700 dark:bg-base-900">
								{#each QUICK_EMOJIS as emoji}
									{@const alreadyMine = reactions.some((r) => r.value === emoji && r.mine)}
									<button
										class="cursor-pointer rounded px-1 py-0.5 text-sm transition-all hover:scale-110 {alreadyMine ? 'bg-accent-100 dark:bg-accent-900/30' : 'hover:bg-base-100 dark:hover:bg-base-800'}"
										onclick={() => handleReaction(msg.id, emoji, alreadyMine)}
										title={emoji}
									>
										{emoji}
									</button>
								{/each}
								<PopoverEmojiPicker
									open={emojiPickerMessageId === msg.id}
									onOpenChange={(v) => { emojiPickerMessageId = v ? msg.id : null; if (!v) hoveredMessageId = null; }}
									onpicked={(emoji) => handleReaction(msg.id, emoji.unicode, false)}
									triggerClasses="!p-1 !min-w-0 !h-auto !rounded text-base-400 hover:text-base-600 dark:hover:text-base-200"
									triggerVariant="ghost"
									triggerSize="icon"
									side="top"
									class="z-50"
								>
									{#snippet child({ props })}
										<button {...props} class="rounded p-1 text-base-400 hover:text-base-600 dark:hover:text-base-200 cursor-pointer transition-colors" title="More reactions">
											<SmilePlus size={14} />
										</button>
									{/snippet}
								</PopoverEmojiPicker>
								{#if isOwn}
									<button
										class="rounded p-1 text-base-400 hover:text-red-500 cursor-pointer transition-colors"
										onclick={() => handleDelete(msg.id)}
										title="Delete for me"
									>
										<Trash2 size={14} />
									</button>
								{/if}
							</div>
						{/if}
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
</div>

<style>
	.chat-message :global(a) {
		color: var(--color-accent-600);
	}
	:global(.dark) .chat-message :global(a) {
		color: var(--color-accent-400);
	}
	.chat-message :global(a:hover) {
		text-decoration: underline;
	}
</style>
