import { error } from '@sveltejs/kit';
import { command, getRequestEvent } from '$app/server';
import { Client } from '@atcute/client';
import type { Did } from '@atcute/lexicons';
import * as v from 'valibot';

function getChatClient() {
	const { locals } = getRequestEvent();
	if (!locals.session || !locals.did) error(401, 'Not authenticated');

	return new Client({
		handler: locals.session,
		proxy: { did: 'did:web:api.bsky.chat' as Did, serviceId: '#bsky_chat' }
	});
}

export const listConvos = command(
	v.object({
		status: v.optional(v.string()),
		cursor: v.optional(v.string())
	}),
	async (input) => {
		const client = getChatClient();

		const res = await client.get('chat.bsky.convo.listConvos', {
			params: {
				limit: 50,
				...(input.status ? { status: input.status } : {}),
				...(input.cursor ? { cursor: input.cursor } : {})
			}
		});

		if (!res.ok) error(res.status, 'Failed to list conversations');
		return { convos: res.data.convos, cursor: res.data.cursor ?? null };
	}
);

export const getMessages = command(
	v.object({
		convoId: v.string(),
		cursor: v.optional(v.string())
	}),
	async (input) => {
		const client = getChatClient();

		const res = await client.get('chat.bsky.convo.getMessages', {
			params: {
				convoId: input.convoId,
				limit: 50,
				...(input.cursor ? { cursor: input.cursor } : {})
			}
		});

		if (!res.ok) error(res.status, 'Failed to load messages');
		return { messages: res.data.messages, cursor: res.data.cursor ?? null };
	}
);

export const sendMessage = command(
	v.object({
		convoId: v.string(),
		text: v.string()
	}),
	async (input) => {
		const client = getChatClient();

		const res = await client.post('chat.bsky.convo.sendMessage', {
			input: {
				convoId: input.convoId,
				message: { text: input.text }
			}
		});

		if (!res.ok) error(res.status, 'Failed to send message');
		return res.data;
	}
);

export const acceptConvo = command(
	v.object({
		convoId: v.string()
	}),
	async (input) => {
		const client = getChatClient();

		const res = await client.post('chat.bsky.convo.acceptConvo', {
			input: { convoId: input.convoId }
		});

		if (!res.ok) error(res.status, 'Failed to accept conversation');
		return { ok: true };
	}
);

export const updateRead = command(
	v.object({
		convoId: v.string()
	}),
	async (input) => {
		const client = getChatClient();

		await client.post('chat.bsky.convo.updateRead', {
			input: { convoId: input.convoId }
		}).catch(() => {});

		return { ok: true };
	}
);
