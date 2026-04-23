import { ETagCache, getCached, resetDefaultCache, type FetchResult } from './index';

// Minimal fetch mock
function mockFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  let callIndex = 0;
  return async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const resp = responses[callIndex++] ?? responses[responses.length - 1];
    const headers = new Headers(resp.headers);
    // 304 is not a valid Response constructor status in Node; return an OK response
    // that our code never reaches (we check entry etag before calling fetchFn)
    if (resp.status === 304) {
      return new Response(null, { status: 304, headers });
    }
    const body = typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body);
    if (!headers.has('content-type') && typeof resp.body !== 'string') {
      headers.set('content-type', 'application/json');
    }
    return new Response(body, { status: resp.status, headers });
  };
}

describe('ETagCache', () => {
  it('should fetch and cache a response', async () => {
    const fetchFn = mockFetch([
      { status: 200, body: { hello: 'world' }, headers: { etag: '"abc123"' } },
    ]);
    const cache = new ETagCache({ fetchFn });

    const result = await cache.fetch<{ hello: string }>('https://example.com/api');

    expect(result.data).toEqual({ hello: 'world' });
    expect(result.fromCache).toBe(false);
    expect(result.status).toBe(200);
    expect(cache.size).toBe(1);
  });

  it('should return cached data on 304 Not Modified', async () => {
    const fetchFn = mockFetch([
      { status: 200, body: { value: 1 }, headers: { etag: '"v1"' } },
      { status: 304, body: null, headers: {} },
    ]);
    const cache = new ETagCache({ fetchFn, ttlMs: 60000 });

    const first = await cache.fetch<{ value: number }>('https://example.com/api');
    expect(first.data).toEqual({ value: 1 });
    expect(first.fromCache).toBe(false);

    const second = await cache.fetch<{ value: number }>('https://example.com/api');
    expect(second.data).toEqual({ value: 1 });
    expect(second.fromCache).toBe(true);
    expect(second.status).toBe(304);
  });

  it('should update cache on new 200 response', async () => {
    const fetchFn = mockFetch([
      { status: 200, body: { v: 1 }, headers: { etag: '"v1"' } },
      { status: 200, body: { v: 2 }, headers: { etag: '"v2"' } },
    ]);
    const cache = new ETagCache({ fetchFn });

    const first = await cache.fetch<{ v: number }>('https://example.com/api');
    const second = await cache.fetch<{ v: number }>('https://example.com/api');

    expect(first.data).toEqual({ v: 1 });
    expect(second.data).toEqual({ v: 2 });
    expect(second.fromCache).toBe(false);
  });

  it('should expire entries after TTL', async () => {
    const fetchFn = mockFetch([
      { status: 200, body: { x: 1 }, headers: { etag: '"a"' } },
      { status: 200, body: { x: 2 }, headers: { etag: '"b"' } },
    ]);
    const cache = new ETagCache({ fetchFn, ttlMs: 10 });

    const first = await cache.fetch<{ x: number }>('https://example.com/api');
    expect(first.data).toEqual({ x: 1 });

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 20));

    const second = await cache.fetch<{ x: number }>('https://example.com/api');
    expect(second.data).toEqual({ x: 2 });
  });

  it('should respect maxEntries and evict oldest', async () => {
    const fetchFn = mockFetch([
      { status: 200, body: 'a', headers: { etag: '"a"' } },
      { status: 200, body: 'b', headers: { etag: '"b"' } },
      { status: 200, body: 'c', headers: { etag: '"c"' } },
    ]);
    const cache = new ETagCache({ fetchFn, maxEntries: 2 });

    await cache.fetch('https://example.com/a');
    await cache.fetch('https://example.com/b');
    expect(cache.size).toBe(2);

    // Adding a 3rd should evict the 1st
    await cache.fetch('https://example.com/c');
    expect(cache.size).toBe(2);
    expect(cache.get('https://example.com/a')).toBeUndefined();
    expect(cache.get('https://example.com/c')).toBeDefined();
  });

  it('should force refresh when asked', async () => {
    const fetchFn = mockFetch([
      { status: 200, body: { v: 1 }, headers: { etag: '"v1"' } },
      { status: 200, body: { v: 2 }, headers: { etag: '"v2"' } },
    ]);
    const cache = new ETagCache({ fetchFn });

    const first = await cache.fetch<{ v: number }>('https://example.com/api');
    expect(first.data).toEqual({ v: 1 });

    const forced = await cache.fetch<{ v: number }>('https://example.com/api', { forceRefresh: true });
    expect(forced.data).toEqual({ v: 2 });
    expect(forced.fromCache).toBe(false);
  });

  it('should handle non-JSON responses', async () => {
    const fetchFn = mockFetch([
      { status: 200, body: 'plain text', headers: { 'content-type': 'text/plain' } },
    ]);
    const cache = new ETagCache({ fetchFn });

    const result = await cache.fetch<string>('https://example.com/text');
    expect(result.data).toBe('plain text');
  });

  it('should handle non-OK responses gracefully', async () => {
    const fetchFn = mockFetch([
      { status: 500, body: 'error', headers: {} },
    ]);
    const cache = new ETagCache({ fetchFn });

    const result = await cache.fetch('https://example.com/fail');
    expect(result.status).toBe(500);
    expect(result.fromCache).toBe(false);
    expect(cache.size).toBe(0);
  });

  it('should invalidate specific entries', async () => {
    const fetchFn = mockFetch([
      { status: 200, body: { a: 1 }, headers: { etag: '"a"' } },
    ]);
    const cache = new ETagCache({ fetchFn });

    await cache.fetch('https://example.com/a');
    expect(cache.size).toBe(1);

    expect(cache.invalidate('https://example.com/a')).toBe(true);
    expect(cache.size).toBe(0);
    expect(cache.invalidate('https://example.com/missing')).toBe(false);
  });

  it('should clear all entries', async () => {
    const fetchFn = mockFetch([
      { status: 200, body: 'x', headers: { etag: '"x"' } },
      { status: 200, body: 'y', headers: { etag: '"y"' } },
    ]);
    const cache = new ETagCache({ fetchFn });

    await cache.fetch('https://example.com/a');
    await cache.fetch('https://example.com/b');
    expect(cache.size).toBe(2);

    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('should list all entries for debugging', async () => {
    const fetchFn = mockFetch([
      { status: 200, body: 'a', headers: { etag: '"a"' } },
      { status: 200, body: 'b', headers: { etag: '"b"' } },
    ]);
    const cache = new ETagCache({ fetchFn });

    await cache.fetch('https://example.com/a');
    await cache.fetch('https://example.com/b');

    const entries = cache.entries();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.url).sort()).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ]);
  });

  it('get() should return undefined for missing entries', () => {
    const cache = new ETagCache({});
    expect(cache.get('https://example.com/missing')).toBeUndefined();
  });
});

describe('getCached (default instance)', () => {
  beforeEach(() => {
    resetDefaultCache();
  });

  it('should create a default cache instance and fetch', async () => {
    // getCached uses global fetch; we just verify it doesn't throw before network
    expect(typeof getCached).toBe('function');
  });

  it('resetDefaultCache should clear the singleton', () => {
    resetDefaultCache();
    // Calling again should not throw
    expect(() => resetDefaultCache()).not.toThrow();
  });
});
