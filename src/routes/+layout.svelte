<script lang="ts">
	/* eslint-disable svelte/no-navigation-without-resolve */
	import '../app.css';
	import { Head, Avatar, Button, ThemeToggle } from '@foxui/core';
	import { House, Users } from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { user } from '$lib/atproto/auth.svelte';
	import LoginModal, { loginModalState } from '$lib/LoginModal.svelte';
	import ImageLightbox from '$lib/components/embed/ImageLightbox.svelte';
	import ScrollToTop from '$lib/components/ScrollToTop.svelte';
	import Sidebar from '$lib/Sidebar.svelte';
	let { children } = $props();

	let path = $derived(page.url?.pathname ?? '/');
	function isActive(href: string): boolean {
		if (href === '/') return path === '/';
		return path.startsWith(href);
	}
	function navClass(href: string): string {
		return isActive(href) ? 'text-accent-600 dark:text-accent-400' : '';
	}
</script>

<Sidebar>
	<Button href="/" onmousedown={(e: MouseEvent) => { e.preventDefault(); window.scrollTo(0, 0); goto('/'); }} variant="ghost" size="icon" class={navClass('/')}>
		<House size={20} strokeWidth={isActive('/') ? 2.5 : 2} />
	</Button>
	<Button href="/communities" onmousedown={(e: MouseEvent) => { e.preventDefault(); goto('/communities'); }} variant="ghost" size="icon" class={navClass('/communities')}>
		<Users size={20} strokeWidth={isActive('/communities') ? 2.5 : 2} />
	</Button>
	<div class="mt-auto"><ThemeToggle /></div>
	{#if user.did}
		{@const profileHref = `/profile/${user.profile?.handle ?? user.did}`}
		<Button href={profileHref} onmousedown={(e: MouseEvent) => { e.preventDefault(); goto(profileHref); }} variant="ghost" size="icon" class="mb-2">
			<Avatar src={user.profile?.avatar} class="size-8" />
		</Button>
	{:else}
		<Button onclick={() => loginModalState.open = true} variant="ghost" size="icon" class="mb-2">
			<Avatar class="size-6" />
		</Button>
	{/if}
</Sidebar>

<div class="overflow-x-hidden pb-18 lg:ml-20 lg:pb-0">
	{@render children()}
</div>

<!-- Mobile bottom navbar -->
<nav class="border-base-400/40 dark:border-base-300/10 bg-base-200/80 dark:bg-base-950/80 inset-shadow-base-800/10 fixed bottom-2 left-3 right-3 z-50 overflow-hidden rounded-3xl border p-1.5 backdrop-blur-lg lg:hidden dark:inset-shadow-black/50" style="padding-bottom: max(0.375rem, env(safe-area-inset-bottom));">
	<div class="flex items-center justify-around">
		<a
			href="/"
			onmousedown={(e) => { e.preventDefault(); window.scrollTo(0, 0); goto('/'); }}
			class="flex items-center justify-center p-2 {navClass('/')}"
		>
			<House size={22} strokeWidth={isActive('/') ? 2.5 : 2} />
		</a>
		<a
			href="/communities"
			onmousedown={(e) => { e.preventDefault(); goto('/communities'); }}
			class="flex items-center justify-center p-2 {navClass('/communities')}"
		>
			<Users size={22} strokeWidth={isActive('/communities') ? 2.5 : 2} />
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
	</div>
</nav>

<LoginModal />
<ImageLightbox />
<ScrollToTop />

<Head
	title="atmo.garden"
	emojiFavicon="🌺"
	description="communities on bsky"
/>
