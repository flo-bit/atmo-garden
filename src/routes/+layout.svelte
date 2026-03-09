<script lang="ts">
	import '../app.css';
	import { AtprotoLoginModal } from '@foxui/social';
	import { login, signup } from '$lib/atproto';
	import { ThemeToggle } from '@foxui/core';

	let { children } = $props();
</script>

{@render children()}

<AtprotoLoginModal
	login={async (handle) => {
		await login(handle);
		return true;
	}}
	signup={async () => {
		signup();
		return true;
	}}
/>

<ThemeToggle class="absolute top-2 left-2" />