import type { Component } from 'svelte';
import type { EmbedExternalData } from '../types';
import YouTubeEmbed from './YouTubeEmbed.svelte';
import TenorEmbed from './TenorEmbed.svelte';
import PlyrEmbed, { toPlyrEmbed } from './PlyrEmbed.svelte';
import AppEmbed from './AppEmbed.svelte';
import { findEmbedApp, type EmbedAppConfig } from './embed-registry';

export type SpecialEmbed = {
	match: (data: EmbedExternalData) => boolean;
	component: Component<{ data: EmbedExternalData; config?: EmbedAppConfig }>;
	/** If set, this is an app embed with iframe + postMessage support */
	appConfig?: EmbedAppConfig;
};

export const specialEmbeds: SpecialEmbed[] = [
	{
		match: (data) => {
			const href = data.external.href;
			return /^https?:\/\/(www\.)?(youtube\.com\/watch|youtu\.be\/|youtube\.com\/shorts\/)/.test(href);
		},
		component: YouTubeEmbed
	},
	{
		match: (data) => {
			return /^https?:\/\/(www\.|media\.)?tenor\.com\//.test(data.external.href);
		},
		component: TenorEmbed
	},
	{
		match: (data) => toPlyrEmbed(data.external.href) !== null,
		component: PlyrEmbed
	}
];

export function findSpecialEmbed(data: EmbedExternalData): SpecialEmbed | undefined {
	// Check hardcoded special embeds first
	const special = specialEmbeds.find((e) => e.match(data));
	if (special) return special;

	// Check app embed registry (atmo.rsvp, stream.place)
	const appConfig = findEmbedApp(data.external.href);
	if (appConfig) {
		return {
			match: () => true,
			component: AppEmbed,
			appConfig
		};
	}

	return undefined;
}

export { findEmbedApp, type EmbedAppConfig } from './embed-registry';
