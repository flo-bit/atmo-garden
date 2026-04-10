<script lang="ts">
	import type { PostSort } from './db';
	type TopSort = 'top-day' | 'top-week' | 'top-month';
	type PrimaryTab = 'hot' | 'new' | 'top';

	const TOP_SORT_LABELS: Record<TopSort, string> = {
		'top-day': 'Today',
		'top-week': 'This week',
		'top-month': 'This month'
	};
	const TOP_SORT_OPTIONS: TopSort[] = ['top-day', 'top-week', 'top-month'];

	let {
		sort = $bindable<PostSort>('hot'),
		onchange,
		class: className
	}: {
		sort?: PostSort;
		onchange?: (next: PostSort) => void;
		class?: string;
	} = $props();

	const primaryTab = $derived<PrimaryTab>(
		sort === 'hot' ? 'hot' : sort === 'new' ? 'new' : 'top'
	);

	function setSort(next: PostSort) {
		if (next === sort) return;
		sort = next;
		onchange?.(next);
	}

	function setPrimaryTab(tab: PrimaryTab) {
		if (tab === primaryTab) return;
		const next: PostSort =
			tab === 'hot' ? 'hot' : tab === 'new' ? 'new' : 'top-day';
		setSort(next);
	}

	// Centralized button class so light/dark selected look stays consistent.
	// `accent-800` in dark mode reads as a muted, darker pill that still
	// reads as "selected" without the saturated glare of `accent-500` on a
	// near-black page background.
	const primaryBtnClass = (active: boolean) =>
		`rounded-full px-4 py-1.5 font-semibold transition-colors ${
			active
				? 'bg-accent-500 text-white shadow-sm dark:bg-accent-800'
				: 'text-base-800 dark:text-base-200 hover:bg-base-200 dark:hover:bg-base-800'
		}`;

	const subBtnClass = (active: boolean) =>
		`rounded-full px-3 py-1 font-medium transition-colors ${
			active
				? 'bg-accent-500 text-white shadow-sm dark:bg-accent-800'
				: 'text-base-800 dark:text-base-200 hover:bg-base-200 dark:hover:bg-base-800'
		}`;
</script>

<div class="flex flex-col gap-2 {className ?? ''}">
	<div class="flex items-center gap-1 text-sm">
		<button type="button" onclick={() => setPrimaryTab('hot')} class={primaryBtnClass(primaryTab === 'hot')}>
			Hot
		</button>
		<button type="button" onclick={() => setPrimaryTab('new')} class={primaryBtnClass(primaryTab === 'new')}>
			New
		</button>
		<button type="button" onclick={() => setPrimaryTab('top')} class={primaryBtnClass(primaryTab === 'top')}>
			Top
		</button>
	</div>
	{#if primaryTab === 'top'}
		<div class="flex w-fit items-center gap-1 rounded-full bg-base-100 p-1 text-xs dark:bg-base-900/60">
			{#each TOP_SORT_OPTIONS as option (option)}
				<button type="button" onclick={() => setSort(option)} class={subBtnClass(sort === option)}>
					{TOP_SORT_LABELS[option]}
				</button>
			{/each}
		</div>
	{/if}
</div>
