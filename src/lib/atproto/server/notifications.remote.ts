import { error } from '@sveltejs/kit';
import { command, getRequestEvent } from '$app/server';
import * as v from 'valibot';

export const listNotifications = command(
	v.object({
		cursor: v.optional(v.string())
	}),
	async (input) => {
		const { locals } = getRequestEvent();
		if (!locals.client || !locals.did) error(401, 'Not authenticated');

		const res = await locals.client.get('app.bsky.notification.listNotifications', {
			params: {
				limit: 30,
				...(input.cursor ? { cursor: input.cursor } : {})
			}
		});

		if (!res.ok) error(res.status, 'Failed to list notifications');
		return {
			notifications: res.data.notifications,
			cursor: res.data.cursor ?? null,
			seenAt: res.data.seenAt ?? null
		};
	}
);

export const getUnreadCount = command(
	v.object({}),
	async () => {
		const { locals } = getRequestEvent();
		if (!locals.client || !locals.did) error(401, 'Not authenticated');

		const res = await locals.client.get('app.bsky.notification.getUnreadCount', {
			params: {}
		});

		if (!res.ok) error(res.status, 'Failed to get unread count');
		return { count: res.data.count };
	}
);

export const updateSeen = command(
	v.object({}),
	async () => {
		const { locals } = getRequestEvent();
		if (!locals.client || !locals.did) error(401, 'Not authenticated');

		const res = await locals.client.post('app.bsky.notification.updateSeen', {
			as: null,
			input: {
				seenAt: new Date().toISOString()
			}
		});

		if (!res.ok) error(res.status, 'Failed to update seen');
		return { ok: true };
	}
);
