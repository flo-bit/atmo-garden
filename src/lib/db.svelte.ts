/**
 * Persistent client-side cache using Dexie (IndexedDB).
 *
 * Each store supports:
 * - get/set with TTL-based expiry
 * - getOrFetch (stale-while-revalidate or fetch-if-missing)
 * - maxEntries cap with LRU eviction
 * - Graceful fallback to in-memory if IndexedDB is unavailable
 */

import Dexie, { type EntityTable } from 'dexie';
import { browser } from '$app/environment';
import { isDid } from '@atcute/lexicons/syntax';
import type { Did } from '@atcute/lexicons';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

interface CacheEntry {
	key: string;
	value: string; // JSON-serialized
	expiresAt: number; // timestamp, 0 = no expiry
	accessedAt: number; // for LRU eviction
}

interface StoreConfig {
	ttl?: number; // ms, undefined = no expiry
	maxEntries?: number; // cap size, undefined = unlimited
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

class AppDatabase extends Dexie {
	identity!: EntityTable<CacheEntry, 'key'>;
	profiles!: EntityTable<CacheEntry, 'key'>;
	posts!: EntityTable<CacheEntry, 'key'>;
	threads!: EntityTable<CacheEntry, 'key'>;
	messages!: EntityTable<CacheEntry, 'key'>;
	state!: EntityTable<CacheEntry, 'key'>;

	constructor() {
		super('atmo-social');
		this.version(1).stores({
			identity: 'key, expiresAt, accessedAt',
			profiles: 'key, expiresAt, accessedAt',
			posts: 'key, expiresAt, accessedAt',
			threads: 'key, expiresAt, accessedAt',
			messages: 'key, expiresAt, accessedAt',
			state: 'key, expiresAt, accessedAt'
		});
	}
}

let db: AppDatabase | null = null;

function getDb(): AppDatabase | null {
	if (!browser) return null;
	if (!db) {
		try {
			db = new AppDatabase();
		} catch {
			console.warn('[db] IndexedDB unavailable, using in-memory only');
			return null;
		}
	}
	return db;
}

// In-memory fallback
const memoryFallback = new Map<string, Map<string, CacheEntry>>();

function getMemTable(table: string): Map<string, CacheEntry> {
	if (!memoryFallback.has(table)) memoryFallback.set(table, new Map());
	return memoryFallback.get(table)!;
}

// ---------------------------------------------------------------------------
// CacheStore — typed wrapper around a Dexie table
// ---------------------------------------------------------------------------

class CacheStore<T> {
	private tableName: string;
	private config: StoreConfig;

	constructor(tableName: string, config: StoreConfig = {}) {
		this.tableName = tableName;
		this.config = config;
	}

	private get table() {
		return getDb()?.[this.tableName as keyof AppDatabase] as EntityTable<CacheEntry, 'key'> | undefined;
	}

	/**
	 * Returns the age of a cached entry in ms, or undefined if not cached.
	 */
	async getAge(key: string): Promise<number | undefined> {
		const now = Date.now();
		try {
			const table = this.table;
			if (table) {
				const entry = await table.get(key);
				if (!entry) return undefined;
				if (entry.expiresAt > 0 && entry.expiresAt < now) return undefined;
				return now - entry.accessedAt;
			}
		} catch {
			// fall through to memory
		}
		const mem = getMemTable(this.tableName);
		const entry = mem.get(key);
		if (!entry) return undefined;
		if (entry.expiresAt > 0 && entry.expiresAt < now) return undefined;
		return now - entry.accessedAt;
	}

	async get(key: string): Promise<T | undefined> {
		const now = Date.now();

		try {
			const table = this.table;
			if (table) {
				const entry = await table.get(key);
				if (!entry) return undefined;
				if (entry.expiresAt > 0 && entry.expiresAt < now) {
					table.delete(key).catch(() => {});
					return undefined;
				}
				// Update accessedAt for LRU (fire and forget)
				table.update(key, { accessedAt: now }).catch(() => {});
				return JSON.parse(entry.value) as T;
			}
		} catch {
			// fall through to memory
		}

		const mem = getMemTable(this.tableName);
		const entry = mem.get(key);
		if (!entry) return undefined;
		if (entry.expiresAt > 0 && entry.expiresAt < now) {
			mem.delete(key);
			return undefined;
		}
		entry.accessedAt = now;
		return JSON.parse(entry.value) as T;
	}

	async set(key: string, value: T): Promise<void> {
		const now = Date.now();
		const entry: CacheEntry = {
			key,
			value: JSON.stringify(value),
			expiresAt: this.config.ttl ? now + this.config.ttl : 0,
			accessedAt: now
		};

		try {
			const table = this.table;
			if (table) {
				await table.put(entry);
				this.maybeEvict(table).catch(() => {});
				return;
			}
		} catch {
			// fall through to memory
		}

		const mem = getMemTable(this.tableName);
		mem.set(key, entry);
	}

	async setMany(entries: [string, T][]): Promise<void> {
		if (entries.length === 0) return;
		const now = Date.now();
		const records = entries.map(([key, value]) => ({
			key,
			value: JSON.stringify(value),
			expiresAt: this.config.ttl ? now + this.config.ttl : 0,
			accessedAt: now
		}));

		try {
			const table = this.table;
			if (table) {
				await table.bulkPut(records);
				this.maybeEvict(table).catch(() => {});
				return;
			}
		} catch {
			// fall through to memory
		}

		const mem = getMemTable(this.tableName);
		for (const record of records) {
			mem.set(record.key, record);
		}
	}

	async getOrFetch(key: string, fetcher: () => Promise<T>): Promise<T> {
		const cached = await this.get(key);
		if (cached !== undefined) return cached;
		const value = await fetcher();
		await this.set(key, value);
		return value;
	}

	async delete(key: string): Promise<void> {
		try {
			await this.table?.delete(key);
		} catch {
			// ignore
		}
		getMemTable(this.tableName).delete(key);
	}

	async clear(): Promise<void> {
		try {
			await this.table?.clear();
		} catch {
			// ignore
		}
		getMemTable(this.tableName).clear();
	}

	private async maybeEvict(table: EntityTable<CacheEntry, 'key'>) {
		if (!this.config.maxEntries) return;
		const count = await table.count();
		if (count <= this.config.maxEntries) return;
		const toDelete = count - this.config.maxEntries;
		const oldest = await table.orderBy('accessedAt').limit(toDelete).primaryKeys();
		await table.bulkDelete(oldest);
	}
}

// ---------------------------------------------------------------------------
// Store instances
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const identityStore = new CacheStore<string>('identity', {
	ttl: 7 * DAY,
	maxEntries: 5000
});

export const profileStore = new CacheStore<Record<string, unknown>>('profiles', {
	ttl: 1 * HOUR,
	maxEntries: 1000
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const postStore = new CacheStore<any>('posts', {
	ttl: 2 * HOUR,
	maxEntries: 2000
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const threadStore = new CacheStore<any>('threads', {
	ttl: 10 * 60 * 1000, // 10 minutes
	maxEntries: 200
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const messageStore = new CacheStore<any[]>('messages', {
	maxEntries: 100
	// no TTL — messages don't change
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const stateStore = new CacheStore<any>('state', {
	ttl: 7 * DAY
});

// ---------------------------------------------------------------------------
// High-level helpers
// ---------------------------------------------------------------------------

/**
 * Resolve an actor (handle or DID) to a DID.
 * Uses cached identity mapping, falls back to resolver.
 */
export async function getDid(
	actor: string,
	resolver: (handle: string) => Promise<string>
): Promise<Did> {
	if (isDid(actor)) return actor;
	const did = await identityStore.getOrFetch(actor, () => resolver(actor));
	return did as Did;
}

/**
 * Cache a post and its author's identity + profile.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function cachePost(post: any) {
	if (!post?.uri) return;
	postStore.set(post.uri, post).catch(() => {});
	if (post.author) {
		cacheProfile(post.author);
	}
}

/**
 * Cache multiple posts in a batch.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function cachePosts(feedPosts: any[]) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const postEntries: [string, any][] = [];
	const identityEntries: [string, string][] = [];
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const profileEntries: [string, any][] = [];

	for (const fp of feedPosts) {
		const post = fp.post ?? fp;
		if (!post?.uri) continue;
		postEntries.push([post.uri, post]);
		if (post.author?.handle && post.author?.did) {
			identityEntries.push([post.author.handle, post.author.did]);
			profileEntries.push([post.author.handle, post.author]);
			profileEntries.push([post.author.did, post.author]);
		}
	}

	postStore.setMany(postEntries).catch(() => {});
	identityStore.setMany(identityEntries).catch(() => {});
	profileStore.setMany(profileEntries).catch(() => {});
}

/**
 * Cache a profile (by both handle and DID).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function cacheProfile(profile: any) {
	if (profile?.handle) {
		profileStore.set(profile.handle, profile).catch(() => {});
		if (profile.did) {
			identityStore.set(profile.handle, profile.did).catch(() => {});
			profileStore.set(profile.did, profile).catch(() => {});
		}
	}
}
