/**
 * Unified client-side cache for the app.
 * Persists across navigations within the same session.
 */

import type { ChatBskyConvoDefs } from '@atcute/bluesky';
import type { AppBskyNotificationListNotifications } from '@atcute/bluesky';
import { getPostThread, loadFeed } from '$lib/atproto/server/feed.remote';
import { listConvos, getMessages } from '$lib/atproto/server/chat.remote';
import { listNotifications, getUnreadCount } from '$lib/atproto/server/notifications.remote';

type ConvoView = ChatBskyConvoDefs.ConvoView;
type Notification = AppBskyNotificationListNotifications.Notification;

// ---------------------------------------------------------------------------
// Identity: handle <-> DID resolution cache
// ---------------------------------------------------------------------------

export const identityCache = new Map<string, string>();

// ---------------------------------------------------------------------------
// Profiles: actor (handle or DID) -> profile data
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _profiles = new Map<string, any>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function cacheProfile(profile: any) {
	if (profile?.handle) _profiles.set(profile.handle, profile);
	if (profile?.did) _profiles.set(profile.did, profile);
	if (profile?.handle && profile?.did) {
		identityCache.set(profile.handle, profile.did);
	}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getCachedProfile(actor: string): any | undefined {
	return _profiles.get(actor);
}

// ---------------------------------------------------------------------------
// Posts: URI -> post view, URI -> thread
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _posts = new Map<string, any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _threads = new Map<string, any>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function cachePost(post: any) {
	if (!post?.uri) return;
	_posts.set(post.uri, post);
	if (post.author) cacheProfile(post.author);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getCachedPost(uri: string): any | undefined {
	return _posts.get(uri);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getCachedThread(uri: string): any | undefined {
	return _threads.get(uri);
}

export function prefetchThread(uri: string) {
	if (_threads.has(uri)) return;
	getPostThread({ uri })
		.then((data) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			if ((data as any).thread?.$type === 'app.bsky.feed.defs#threadViewPost') {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				_threads.set(uri, (data as any).thread);
			}
		})
		.catch(() => {});
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
	set posts(v) { _feedPosts = v; },
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
	console.log('[poll] refreshing feed');
	try {
		const result = await loadFeed({ feedUri: _feedUri });
		_pendingFeedPosts = JSON.parse(JSON.stringify(result.posts));
		_pendingFeedCursor = result.cursor;
		_hasPendingFeed = true;
		// Cache post authors for instant profile/DID resolution
		for (const fp of _pendingFeedPosts) {
			if (fp.post) cachePost(fp.post);
		}
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
// Chat: reactive convo list + per-convo message cache
// ---------------------------------------------------------------------------

let _acceptedConvos = $state<ConvoView[]>([]);
let _requestConvos = $state<ConvoView[]>([]);
let _convoListLoaded = $state(false);

export const convoCache = {
	get acceptedConvos() { return _acceptedConvos; },
	set acceptedConvos(v) { _acceptedConvos = v; },
	get requestConvos() { return _requestConvos; },
	set requestConvos(v) { _requestConvos = v; },
	get loaded() { return _convoListLoaded; },
	set loaded(v) { _convoListLoaded = v; }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _messages = new Map<string, any[]>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getCachedMessages(convoId: string): any[] | undefined {
	return _messages.get(convoId);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setCachedMessages(convoId: string, messages: any[]) {
	_messages.set(convoId, messages);
}

export function markConvoRead(convoId: string) {
	const convo = _acceptedConvos.find((c) => c.id === convoId);
	if (convo && convo.unreadCount > 0) {
		convo.unreadCount = 0;
		_acceptedConvos = [..._acceptedConvos]; // trigger reactivity
		updateChatUnreadCount();
	}
}

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

async function pollChats() {
	console.log('[poll] refreshing chats');
	try {
		const [accepted, requests] = await Promise.all([
			listConvos({ status: 'accepted' }),
			listConvos({ status: 'request' })
		]);
		_acceptedConvos = accepted.convos as ConvoView[];
		_requestConvos = requests.convos as ConvoView[];
		_convoListLoaded = true;
		updateChatUnreadCount();
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

		// Prefetch messages for top 10 accepted convos
		for (const convo of _acceptedConvos.slice(0, 10)) {
			if (_messages.has(convo.id)) continue;
			getMessages({ convoId: convo.id })
				.then((res) => _messages.set(convo.id, res.messages))
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
	set notifications(v) { _notifications = v; },
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
	console.log('[poll] refreshing notification count');
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
	} catch {
		// silent fail
	} finally {
		_notifPrefetching = false;
	}
}
