interface CacheEntry<T> {
  data: T;
  timestamp: number;
  promise?: Promise<T>;
}

const DEFAULT_TTL_MS = 300_000; // 5 minutes
const MAX_ENTRIES = 100;

class ApiCache {
  private store = new Map<string, CacheEntry<unknown>>();

  private evictIfNeeded(): void {
    if (this.store.size <= MAX_ENTRIES) return;
    // Evict oldest entries (by insertion order — Map preserves order)
    const toDelete = this.store.size - MAX_ENTRIES;
    let deleted = 0;
    for (const [key, entry] of this.store) {
      // Don't evict in-flight requests
      if (entry.promise) continue;
      this.store.delete(key);
      deleted++;
      if (deleted >= toDelete) break;
    }
  }

  async get<T>(
    key: string,
    fetcher: () => Promise<T>,
    ttlMs: number = DEFAULT_TTL_MS,
  ): Promise<T> {
    const existing = this.store.get(key) as CacheEntry<T> | undefined;

    // 1. If cached and not expired, return cached data
    if (existing && Date.now() - existing.timestamp < ttlMs) {
      // If there's an in-flight promise, wait for it
      if (existing.promise) {
        return existing.promise;
      }
      return existing.data;
    }

    // 2. If there's an in-flight request for this key, return the same promise (dedup)
    if (existing?.promise) {
      return existing.promise;
    }

    // 3. Otherwise, call fetcher, store result, return it
    const promise = fetcher().then(
      (data) => {
        this.store.set(key, { data, timestamp: Date.now() });
        this.evictIfNeeded();
        return data;
      },
      (err: unknown) => {
        // On failure, remove the in-flight entry so next call retries
        const current = this.store.get(key);
        if (current?.promise === promise) {
          this.store.delete(key);
        }
        throw err;
      },
    );

    this.store.set(key, {
      data: undefined as T,
      timestamp: Date.now(),
      promise,
    });

    return promise;
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

export const apiCache = new ApiCache();
