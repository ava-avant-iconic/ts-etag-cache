# ts-etag-cache

> TypeScript HTTP ETag-based conditional request cache

Automatically handles `If-None-Match` and `If-Modified-Since` headers, caches responses, and returns cached data on `304 Not Modified`.

## Features

- 🏷️ **ETag-aware** — sends `If-None-Match` on subsequent requests
- 🕐 **Last-Modified** — sends `If-Modified-Since` when available
- ⚡ **Zero dependencies** — runs on native `fetch`
- 🗑️ **LRU eviction** — configurable max entries with automatic eviction
- ⏱️ **TTL expiry** — entries auto-expire after configurable duration
- 💪 **TypeScript strict mode** — fully typed with generics
- 🧪 **Well-tested** — 14 tests, 89%+ coverage

## Install

```bash
npm install ts-etag-cache
```

## Usage

```typescript
import { ETagCache } from 'ts-etag-cache';

const cache = new ETagCache({ ttlMs: 60000 });

// First request — fetches from server, caches response
const result1 = await cache.fetch('https://api.example.com/data');
// result1.fromCache === false

// Second request — sends If-None-Match, returns cached data on 304
const result2 = await cache.fetch('https://api.example.com/data');
// result2.fromCache === true (if server returned 304)
```

## API

### `new ETagCache(options?)`

| Option | Type | Default | Description |
|---|---|---|---|
| `ttlMs` | `number` | `3600000` | Cache entry TTL in ms |
| `maxEntries` | `number` | `1000` | Max cached entries (LRU eviction) |
| `fetchFn` | `typeof fetch` | `globalThis.fetch` | Custom fetch function |

### `cache.fetch<T>(url, options?)`

Fetches a URL with conditional caching. Returns `FetchResult<T>` with `data`, `fromCache`, and `status`.

### `cache.get<T>(url)`

Returns cached entry without making a network request.

### `cache.invalidate(url)`

Removes a specific cache entry.

### `cache.clear()`

Clears all entries.

### `cache.size`

Current number of cached entries.

## License

MIT
