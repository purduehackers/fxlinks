import type { Post } from "./embed.ts";

const TTL_MS = 300_000;
const MAX_POSTS = 128;
const MAX_BYTES = 2 * 1024 * 1024;
type CachedPost = { post: Post; expiresAt: number };

// Shared by response formats and media selections, scoped to one warm instance.
export function createPostCache(now: () => number = Date.now) {
  const cached = new Map<string, CachedPost & { bytes: number }>();
  const pending = new Map<string, Promise<CachedPost>>();
  let bytes = 0;

  function remove(key: string) {
    const entry = cached.get(key);
    if (entry) bytes -= entry.bytes;
    cached.delete(key);
  }

  return (key: string, load: () => Promise<Post>): Promise<CachedPost> => {
    const hit = cached.get(key);
    if (hit && hit.expiresAt > now()) {
      cached.delete(key);
      cached.set(key, hit);
      return Promise.resolve(hit);
    }
    remove(key);
    const running = pending.get(key);
    if (running) return running;

    const loading = Promise.resolve().then(load).then(post => {
      const entry = { post, expiresAt: now() + TTL_MS, bytes: Buffer.byteLength(JSON.stringify(post)) };
      if (entry.bytes <= MAX_BYTES) {
        // Expire idle entries too, then evict least-recently-used posts to fit.
        for (const [oldKey, old] of cached) if (old.expiresAt <= now()) remove(oldKey);
        remove(key);
        cached.set(key, entry);
        bytes += entry.bytes;
        for (const oldKey of cached.keys()) {
          if (cached.size <= MAX_POSTS && bytes <= MAX_BYTES) break;
          remove(oldKey);
        }
      }
      return entry;
    }).finally(() => { if (pending.get(key) === loading) pending.delete(key); });
    // Bound bookkeeping during bursts; uncached requests still work normally.
    if (pending.size < MAX_POSTS) pending.set(key, loading);
    return loading;
  };
}
