/**
 * Reactive caches for feed, chat, and notifications.
 * Post/profile/identity persistence is handled by $lib/db.svelte.ts (Dexie).
 * Bulk reactive state (feed list, convo list, notifications) is persisted via the state store.
 */

import { browser } from '$app/environment';
import type { ChatBskyConvoDefs } from '@atcute/bluesky';
import type { AppBskyNotificationListNotifications } from '@atcute/bluesky';
import { getPostThread, loadFeed } from '$lib/atproto/server/feed.remote';
import { listConvos, getMessages } from '$lib/atproto/server/chat.remote';
import { listNotifications, getUnreadCount } from '$lib/atproto/server/notifications.remote';
import {
	postStore,
	threadStore,
	profileStore,
	messageStore,
	stateStore,
	cachePost,
	cachePosts,
	cacheProfile
} from '$lib/db.svelte';

type ConvoView = ChatBskyConvoDefs.ConvoView;
type Notification = AppBskyNotificationListNotifications.Notification;

// Re-export db helpers so existing imports still work
export { cachePost, cachePosts, cacheProfile };

// ---------------------------------------------------------------------------
// State persistence helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function saveState(key: string, value: any) {
	stateStore.set(key, value).catch(() => {});
}

// ---------------------------------------------------------------------------
// Profiles (async wrappers around db)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getCachedProfile(actor: string): Promise<any | undefined> {
	return profileStore.get(actor);
}

// ---------------------------------------------------------------------------
// Posts & Threads (async wrappers around db)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getCachedPost(uri: string): Promise<any | undefined> {
	return postStore.get(uri);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getCachedThread(uri: string): Promise<any | undefined> {
	return threadStore.get(uri);
}

export async function getThreadAge(uri: string): Promise<number | undefined> {
	return threadStore.getAge(uri);
}

export function prefetchThread(uri: string) {
	threadStore.get(uri).then((cached) => {
		if (cached) return;
		getPostThread({ uri })
			.then((data) => {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const thread = (data as any).thread;
				if (thread?.$type === 'app.bsky.feed.defs#threadViewPost') {
					threadStore.set(uri, thread).catch(() => {});
				}
			})
			.catch(() => {});
	}).catch(() => {});
}

// ---------------------------------------------------------------------------
// Messages (async wrappers around db)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getCachedMessages(convoId: string): Promise<any[] | undefined> {
	return messageStore.get(convoId);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function setCachedMessages(convoId: string, messages: any[]) {
	await messageStore.set(convoId, messages);
}

// ---------------------------------------------------------------------------
// Feed: reactive state for the main timeline
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _feedPosts = $state<any[]>([]);
let _feedCursor = $state<string | null>(null);
let _feedLoaded = $state(false);
let _feedScrollY = $state(0);

export const feedCache = {
	get posts() { return _feedPosts; },
	set posts(v) { _feedPosts = v; saveState('feed', { posts: v, cursor: _feedCursor }); },
	get cursor() { return _feedCursor; },
	set cursor(v) { _feedCursor = v; },
	get loaded() { return _feedLoaded; },
	set loaded(v) { _feedLoaded = v; },
	get scrollY() { return _feedScrollY; },
	set scrollY(v) { _feedScrollY = v; }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pendingFeedPosts = $state<any[]>([]);
let _pendingFeedCursor = $state<string | null>(null);
let _hasPendingFeed = $state(false);
let _feedPollInterval: ReturnType<typeof setInterval> | null = null;
let _feedUri: string | null = null;

export const pendingFeed = {
	get hasPending() { return _hasPendingFeed; }
};

export function setFeedUri(uri: string) {
	_feedUri = uri;
}

async function pollFeed() {
	if (!_feedUri) return;
	console.log('[poll] feed');
	try {
		const result = await loadFeed({ feedUri: _feedUri });
		_pendingFeedPosts = JSON.parse(JSON.stringify(result.posts));
		_pendingFeedCursor = result.cursor;
		_hasPendingFeed = true;
		cachePosts(_pendingFeedPosts);
	} catch {
		// silent
	}
}

export function applyPendingFeed() {
	if (!_hasPendingFeed) return;
	_feedPosts = _pendingFeedPosts;
	_feedCursor = _pendingFeedCursor;
	_feedLoaded = true;
	_feedScrollY = 0;
	_hasPendingFeed = false;
	saveState('feed', { posts: _feedPosts, cursor: _feedCursor });
	for (const fp of _feedPosts) {
		if (fp.post) prefetchThread(fp.post.uri);
	}
}

export function startFeedPoll() {
	if (_feedPollInterval) return;
	_feedPollInterval = setInterval(pollFeed, 60_000);
}

export function stopFeedPoll() {
	if (_feedPollInterval) {
		clearInterval(_feedPollInterval);
		_feedPollInterval = null;
	}
}

// ---------------------------------------------------------------------------
// Chat: reactive convo list
// ---------------------------------------------------------------------------

let _acceptedConvos = $state<ConvoView[]>([]);
let _requestConvos = $state<ConvoView[]>([]);
let _convoListLoaded = $state(false);

export const convoCache = {
	get acceptedConvos() { return _acceptedConvos; },
	set acceptedConvos(v) { _acceptedConvos = v; saveState('convos', { accepted: v, requests: _requestConvos }); },
	get requestConvos() { return _requestConvos; },
	set requestConvos(v) { _requestConvos = v; saveState('convos', { accepted: _acceptedConvos, requests: v }); },
	get loaded() { return _convoListLoaded; },
	set loaded(v) { _convoListLoaded = v; }
};

let _chatPrefetching = false;
let _chatPollInterval: ReturnType<typeof setInterval> | null = null;

let _unreadChatCount = $state(0);

export const chatUnreadCount = {
	get count() { return _unreadChatCount; },
	set count(v) { _unreadChatCount = v; }
};

function updateChatUnreadCount() {
	_unreadChatCount = _acceptedConvos.reduce((sum, c) => sum + (c.unreadCount ?? 0), 0);
}

export function markConvoRead(convoId: string) {
	const convo = _acceptedConvos.find((c) => c.id === convoId);
	if (convo && convo.unreadCount > 0) {
		convo.unreadCount = 0;
		_acceptedConvos = [..._acceptedConvos];
		updateChatUnreadCount();
	}
}

async function pollChats() {
	console.log('[poll] chats');
	try {
		const [accepted, requests] = await Promise.all([
			listConvos({ status: 'accepted' }),
			listConvos({ status: 'request' })
		]);
		_acceptedConvos = accepted.convos as ConvoView[];
		_requestConvos = requests.convos as ConvoView[];
		_convoListLoaded = true;
		updateChatUnreadCount();
		saveState('convos', { accepted: _acceptedConvos, requests: _requestConvos });
	} catch {
		// silent
	}
}

export function startChatPoll() {
	if (_chatPollInterval) return;
	pollChats();
	_chatPollInterval = setInterval(pollChats, 30_000);
}

export function stopChatPoll() {
	if (_chatPollInterval) {
		clearInterval(_chatPollInterval);
		_chatPollInterval = null;
	}
}

export async function prefetchChats() {
	if (_chatPrefetching || _convoListLoaded) return;
	_chatPrefetching = true;
	try {
		const [accepted, requests] = await Promise.all([
			listConvos({ status: 'accepted' }),
			listConvos({ status: 'request' })
		]);
		_acceptedConvos = accepted.convos as ConvoView[];
		_requestConvos = requests.convos as ConvoView[];
		_convoListLoaded = true;
		updateChatUnreadCount();
		saveState('convos', { accepted: _acceptedConvos, requests: _requestConvos });

		// Prefetch messages for top 10 accepted convos
		for (const convo of _acceptedConvos.slice(0, 10)) {
			const cached = await getCachedMessages(convo.id);
			if (cached) continue;
			getMessages({ convoId: convo.id })
				.then((res) => setCachedMessages(convo.id, res.messages))
				.catch(() => {});
		}
	} catch {
		// silent fail
	} finally {
		_chatPrefetching = false;
	}
}

// ---------------------------------------------------------------------------
// Notifications: reactive list + unread count
// ---------------------------------------------------------------------------

let _notifications = $state<Notification[]>([]);
let _notifLoaded = $state(false);
let _unreadCount = $state(0);
let _notifCursor = $state<string | null>(null);
let _seenAt = $state<string | null>(null);

export const notificationsCache = {
	get notifications() { return _notifications; },
	set notifications(v) { _notifications = v; saveState('notifications', { notifications: v, cursor: _notifCursor, seenAt: _seenAt }); },
	get loaded() { return _notifLoaded; },
	set loaded(v) { _notifLoaded = v; },
	get unreadCount() { return _unreadCount; },
	set unreadCount(v) { _unreadCount = v; },
	get cursor() { return _notifCursor; },
	set cursor(v) { _notifCursor = v; },
	get seenAt() { return _seenAt; },
	set seenAt(v) { _seenAt = v; }
};

let _notifPrefetching = false;
let _pollInterval: ReturnType<typeof setInterval> | null = null;

async function pollUnread() {
	console.log('[poll] notifications');
	try {
		const result = await getUnreadCount({});
		_unreadCount = result.count;
	} catch {
		// silent
	}
}

export function startUnreadPoll() {
	if (_pollInterval) return;
	pollUnread();
	_pollInterval = setInterval(pollUnread, 30_000);
}

export function stopUnreadPoll() {
	if (_pollInterval) {
		clearInterval(_pollInterval);
		_pollInterval = null;
	}
}

export async function prefetchNotifications() {
	if (_notifPrefetching || _notifLoaded) return;
	_notifPrefetching = true;
	try {
		const [notifResult, countResult] = await Promise.all([
			listNotifications({}),
			getUnreadCount({})
		]);
		_notifications = notifResult.notifications as Notification[];
		_notifCursor = notifResult.cursor;
		_seenAt = notifResult.seenAt;
		_unreadCount = countResult.count;
		_notifLoaded = true;
		saveState('notifications', { notifications: _notifications, cursor: _notifCursor, seenAt: _seenAt });
	} catch {
		// silent fail
	} finally {
		_notifPrefetching = false;
	}
}

// ---------------------------------------------------------------------------
// Hydrate: restore reactive state from Dexie on app start
// ---------------------------------------------------------------------------

export async function hydrateFromDb() {
	if (!browser) return;

	try {
		const [feedState, convosState, notifState] = await Promise.all([
			stateStore.get('feed'),
			stateStore.get('convos'),
			stateStore.get('notifications')
		]);

		if (feedState?.posts?.length) {
			_feedPosts = feedState.posts;
			_feedCursor = feedState.cursor ?? null;
			_feedLoaded = true;
		}

		if (convosState?.accepted?.length || convosState?.requests?.length) {
			_acceptedConvos = convosState.accepted ?? [];
			_requestConvos = convosState.requests ?? [];
			_convoListLoaded = true;
			updateChatUnreadCount();
		}

		if (notifState?.notifications?.length) {
			_notifications = notifState.notifications;
			_notifCursor = notifState.cursor ?? null;
			_seenAt = notifState.seenAt ?? null;
			_notifLoaded = true;
		}
	} catch (e) {
		console.warn('[cache] Failed to hydrate from db:', e);
	}
}
