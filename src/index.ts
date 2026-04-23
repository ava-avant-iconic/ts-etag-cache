/**
 * ts-etag-cache - HTTP ETag-based conditional request cache
 *
 * Caches HTTP responses keyed by URL, tracks ETag and Last-Modified headers,
 * and automatically sends conditional requests (If-None-Match / If-Modified-Since)
 * on subsequent fetches. Returns cached data on 304 Not Modified responses.
 */

// ─── Types ────────────────────────────────────────────────────────────

/** Configuration options for the ETagCache instance */
export interface ETagCacheOptions {
  /** Time-to-live for cache entries in milliseconds. Default: 3600000 (1 hour) */
  ttlMs?: number;
  /** Maximum number of entries in the cache. Default: 1000 */
  maxEntries?: number;
  /** Custom fetch function (useful for testing or wrappers). Default: global fetch */
  fetchFn?: typeof fetch;
}

/** A single cached response entry */
export interface CacheEntry<T = unknown> {
  /** The cached response body (parsed) */
  data: T;
  /** The ETag header value from the original response */
  etag: string | null;
  /** The Last-Modified header value from the original response */
  lastModified: string | null;
  /** Timestamp (ms) when this entry was cached */
  cachedAt: number;
  /** The cache key (URL) */
  url: string;
}

/** Result returned by a conditional fetch */
export interface FetchResult<T = unknown> {
  /** The response data */
  data: T;
  /** Whether the data came from the cache (304 Not Modified) */
  fromCache: boolean;
  /** The HTTP status code (200 or 304) */
  status: number;
}

/** Options for an individual fetch call */
export interface FetchOptions extends RequestInit {
  /** Force a fresh request, ignoring cache */
  forceRefresh?: boolean;
}

// ─── Cache Store ──────────────────────────────────────────────────────

/** Internal LRU-style map that evicts the oldest entry when maxEntries is exceeded */
class CacheStore<T = unknown> {
  private readonly map = new Map<string, CacheEntry<T>>();
  private readonly maxEntries: number;

  constructor(maxEntries: number) {
    this.maxEntries = maxEntries;
  }

  get(key: string): CacheEntry<T> | undefined {
    const entry = this.map.get(key);
    if (entry) {
      // Move to end (most-recently-used)
      this.map.delete(key);
      this.map.set(key, entry);
    }
    return entry;
  }

  set(key: string, entry: CacheEntry<T>): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxEntries) {
      // Evict oldest (first) entry
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) {
        this.map.delete(firstKey);
      }
    }
    this.map.set(key, entry);
  }

  delete(key: string): boolean {
    return this.map.delete(key);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  entries(): IterableIterator<[string, CacheEntry<T>]> {
    return this.map.entries();
  }
}

// ─── Main Class ───────────────────────────────────────────────────────

/**
 * ETagCache — HTTP ETag-based conditional request cache.
 *
 * Automatically handles `If-None-Match` and `If-Modified-Since` headers,
 * returning cached data when the server responds with `304 Not Modified`.
 *
 * @example
 * ```ts
 * const cache = new ETagCache({ ttlMs: 60000 });
 *
 * // First request — fetches from server, caches response
 * const result1 = await cache.fetch('https://api.example.com/data');
 * // result1.fromCache === false, result1.status === 200
 *
 * // Second request — sends If-None-Match, returns cached data on 304
 * const result2 = await cache.fetch('https://api.example.com/data');
 * // result2.fromCache === true (if server returned 304)
 * ```
 */
export class ETagCache {
  private readonly store: CacheStore;
  private readonly ttlMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: ETagCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 3600_000;
    this.store = new CacheStore(options.maxEntries ?? 1000);
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  /**
   * Fetch a URL with ETag-based conditional caching.
   *
   * On the first request, the response is cached along with its ETag
   * and Last-Modified headers. On subsequent requests, conditional
   * headers are sent automatically. If the server returns 304, the
   * cached data is returned without parsing the body again.
   */
  async fetch<T = unknown>(url: string, options: FetchOptions = {}): Promise<FetchResult<T>> {
    const { forceRefresh, ...init } = options;
    const cached = this.store.get(url);

    // If force refresh, remove from cache and fetch fresh
    if (forceRefresh && cached) {
      this.store.delete(url);
    }

    const entry = forceRefresh ? undefined : cached;

    // Check TTL expiry
    if (entry && Date.now() - entry.cachedAt >= this.ttlMs) {
      this.store.delete(url);
      return this.fetch<T>(url, { ...options, forceRefresh: false });
    }

    // Build conditional request headers
    const headers = new Headers(init.headers);
    if (entry?.etag) {
      headers.set('If-None-Match', entry.etag);
    }
    if (entry?.lastModified) {
      headers.set('If-Modified-Since', entry.lastModified);
    }

    const response = await this.fetchFn(url, {
      ...init,
      headers,
      method: init.method ?? 'GET',
    });

    // 304 Not Modified — return cached data
    if (response.status === 304 && entry) {
      return {
        data: entry.data as T,
        fromCache: true,
        status: 304,
      };
    }

    // Non-OK response — don't cache, just return
    if (!response.ok) {
      return {
        data: undefined as unknown as T,
        fromCache: false,
        status: response.status,
      };
    }

    // Parse response body
    const contentType = response.headers.get('content-type') ?? '';
    let data: unknown;
    if (contentType.includes('application/json')) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    // Cache the new response
    const newEntry: CacheEntry<T> = {
      data: data as T,
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
      cachedAt: Date.now(),
      url,
    };
    this.store.set(url, newEntry);

    return {
      data: data as T,
      fromCache: false,
      status: response.status,
    };
  }

  /** Get a cached entry without making a network request. Returns undefined if not cached or expired. */
  get<T = unknown>(url: string): CacheEntry<T> | undefined {
    const entry = this.store.get(url) as CacheEntry<T> | undefined;
    if (!entry) return undefined;
    if (Date.now() - entry.cachedAt >= this.ttlMs) {
      this.store.delete(url);
      return undefined;
    }
    return entry;
  }

  /** Invalidate a specific cache entry */
  invalidate(url: string): boolean {
    return this.store.delete(url);
  }

  /** Clear all cache entries */
  clear(): void {
    this.store.clear();
  }

  /** Current number of entries in the cache */
  get size(): number {
    return this.store.size;
  }

  /** Get all cache entries (for inspection/debugging) */
  entries(): Array<CacheEntry> {
    return Array.from(this.store.entries()).map(([, entry]) => entry);
  }
}

// ─── Convenience Function ─────────────────────────────────────────────

/** Default shared instance */
let defaultCache: ETagCache | null = null;

/**
 * Get or create the default shared ETagCache instance.
 *
 * @example
 * ```ts
 * import { getCached } from 'ts-etag-cache';
 * const result = await getCached('https://api.example.com/data');
 * ```
 */
export function getCached<T = unknown>(url: string, options?: FetchOptions): Promise<FetchResult<T>> {
  if (!defaultCache) {
    defaultCache = new ETagCache();
  }
  return defaultCache.fetch<T>(url, options);
}

/** Reset the default shared instance (useful for tests) */
export function resetDefaultCache(): void {
  defaultCache = null;
}
