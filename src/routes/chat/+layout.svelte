<script lang="ts">
	/* eslint-disable svelte/no-navigation-without-resolve */
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { user } from '$lib/atproto/auth.svelte';
	import { page } from '$app/state';
	import { MessageCircle, Loader2, RefreshCw } from '@lucide/svelte';
	import { Avatar } from '@foxui/core';
	import { listConvos } from '$lib/atproto/server/chat.remote';
	import { loginModalState } from '$lib/LoginModal.svelte';
	import type { ChatBskyConvoDefs } from '@atcute/bluesky';

	type ConvoView = ChatBskyConvoDefs.ConvoView;

	let { children } = $props();

	let tab = $state<'accepted' | 'request'>('accepted');
	let loading = $state(true);
	let refreshing = $state(false);
	let acceptedConvos = $state<ConvoView[]>([]);
	let requestConvos = $state<ConvoView[]>([]);
	let displayedConvos = $derived(tab === 'accepted' ? acceptedConvos : requestConvos);

	let activeConvoId = $derived(page.params.convoId ?? null);
	let isInConvo = $derived(!!activeConvoId);

	async function refreshConvos() {
		refreshing = true;
		try {
			const [accepted, requests] = await Promise.all([
				listConvos({ status: 'accepted' }),
				listConvos({ status: 'request' })
			]);
			acceptedConvos = accepted.convos as ConvoView[];
			requestConvos = requests.convos as ConvoView[];
		} catch (e) {
			console.error('Failed to load conversations:', e);
		} finally {
			refreshing = false;
			loading = false;
		}
	}

	onMount(() => {
		if (user.did) {
			refreshConvos();
		} else {
			loading = false;
		}
	});

	function isMessageView(msg: unknown): msg is ChatBskyConvoDefs.MessageView {
		return !!msg && typeof msg === 'object' && '$type' in msg && msg.$type !== 'chat.bsky.convo.defs#deletedMessageView';
	}

	function otherMember(convo: ConvoView) {
		return convo.members.find((m) => m.did !== user.did) ?? convo.members[0];
	}

	function formatTime(dateStr: string): string {
		const date = new Date(dateStr);
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

		if (diffDays === 0) {
			return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		} else if (diffDays === 1) {
			return 'Yesterday';
		} else if (diffDays < 7) {
			return date.toLocaleDateString([], { weekday: 'short' });
		}
		return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
	}

	function lastMessagePreview(convo: ConvoView): string {
		if (!convo.lastMessage) return '';
		if (!isMessageView(convo.lastMessage)) return 'Message deleted';
		return convo.lastMessage.text.length > 50
			? convo.lastMessage.text.slice(0, 50) + '...'
			: convo.lastMessage.text;
	}

</script>

{#if !user.isLoggedIn}
	<div class="flex min-h-screen items-center justify-center">
		<div class="text-center">
			<MessageCircle class="text-base-400 mx-auto mb-4" size={48} />
			<p class="text-base-500 text-lg">Log in to view your messages</p>
			<button
				onclick={() => loginModalState.open = true}
				class="text-accent-500 hover:text-accent-600 mt-2 text-sm"
			>
				Log in
			</button>
		</div>
	</div>
{:else}
	<div class="flex h-dvh overflow-hidden lg:ml-20">
		<!-- Sidebar -->
		<div
			class="border-base-400/40 dark:border-base-300/10 bg-base-200/80 dark:bg-base-950/90 inset-shadow-base-800/10 w-full flex-shrink-0 flex-col overflow-hidden inset-shadow-sm backdrop-blur-lg md:flex md:w-80 lg:fixed lg:top-8 lg:bottom-8 lg:left-[4.25rem] lg:z-40 lg:w-80 lg:rounded-r-2xl lg:border dark:inset-shadow-black/50 {isInConvo ? 'hidden' : 'flex'}"
		>
			<div class="flex items-center justify-between px-4 pt-4 pb-3">
				<h1 class="text-base-900 dark:text-base-100 text-lg font-semibold">Messages</h1>
				<button
					onclick={() => refreshConvos()}
					disabled={refreshing}
					class="text-base-500 hover:text-base-700 dark:text-base-400 dark:hover:text-base-200 rounded-lg p-1.5 transition-colors"
				>
					{#if refreshing}
						<Loader2 class="animate-spin" size={16} />
					{:else}
						<RefreshCw size={16} />
					{/if}
				</button>
			</div>

			<!-- Tabs -->
			<div class="border-base-200/50 dark:border-base-800/50 flex border-b">
				<button
					type="button"
					onclick={() => (tab = 'accepted')}
					class="flex-1 py-2.5 text-center text-sm font-medium transition-colors {tab === 'accepted'
						? 'border-accent-500 text-accent-600 dark:text-accent-400 border-b-2'
						: 'text-base-500 hover:text-base-700 dark:text-base-400 dark:hover:text-base-200'}"
				>
					Chats
				</button>
				<button
					type="button"
					onclick={() => (tab = 'request')}
					class="relative flex-1 py-2.5 text-center text-sm font-medium transition-colors {tab === 'request'
						? 'border-accent-500 text-accent-600 dark:text-accent-400 border-b-2'
						: 'text-base-500 hover:text-base-700 dark:text-base-400 dark:hover:text-base-200'}"
				>
					Requests
					{#if requestConvos.length > 0}
						<span class="bg-accent-500 ml-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-medium text-white">
							{requestConvos.length}
						</span>
					{/if}
				</button>
			</div>

			{#if loading}
				<div class="flex flex-1 items-center justify-center">
					<Loader2 class="text-base-400 animate-spin" size={28} />
				</div>
			{:else if displayedConvos.length === 0}
				<div class="flex flex-1 flex-col items-center justify-center gap-2">
					<MessageCircle class="text-base-300 dark:text-base-600" size={40} />
					<p class="text-base-400 text-sm">
						{tab === 'accepted' ? 'No conversations yet' : 'No message requests'}
					</p>
				</div>
			{:else}
				<div class="flex-1 overflow-y-auto">
					{#each displayedConvos as convo (convo.id)}
						{@const member = otherMember(convo)}
						<a
							href="/chat/{convo.id}"
							data-sveltekit-noscroll
							onmousedown={(e) => { e.preventDefault(); goto(`/chat/${convo.id}`); }}
							class="hover:bg-base-100 dark:hover:bg-base-800 flex w-full items-center gap-3 px-4 py-3 text-left transition-colors {activeConvoId === convo.id ? 'bg-accent-50 hover:bg-accent-100 dark:bg-accent-950 dark:hover:bg-accent-900' : ''}"
						>
							<Avatar src={member.avatar} class="size-10 shrink-0" />

							<div class="min-w-0 flex-1">
								<div class="flex items-center justify-between">
									<span class="text-base-900 dark:text-base-100 truncate text-sm font-medium">
										{member.displayName ?? member.handle}
									</span>
									{#if convo.lastMessage && isMessageView(convo.lastMessage)}
										<span class="text-base-400 ml-2 shrink-0 text-xs">
											{formatTime(convo.lastMessage.sentAt)}
										</span>
									{/if}
								</div>
								<div class="flex items-center justify-between">
									<p class="text-base-500 dark:text-base-400 truncate text-xs">
										{lastMessagePreview(convo)}
									</p>
									{#if convo.unreadCount > 0}
										<span class="bg-accent-500 ml-2 flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-xs font-medium text-white">
											{convo.unreadCount}
										</span>
									{/if}
								</div>
							</div>
						</a>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Right panel -->
		<div class="flex-1 flex-col lg:ml-80 {isInConvo ? 'flex' : 'hidden md:flex'}">
			<div class="mx-auto flex h-full w-full max-w-2xl flex-col">
				{@render children()}
			</div>
		</div>
	</div>
{/if}
