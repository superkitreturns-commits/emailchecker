/**
 * Tiny in-memory TTL cache.
 * Swap for Redis when you outgrow a single process.
 */
export class TTLCache {
  constructor({ ttl = 60 * 60 * 1000, max = 5000 } = {}) {
    this.ttl = ttl;
    this.max = max;
    this.store = new Map();
  }

  get(key) {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expires) {
      this.store.delete(key);
      return undefined;
    }
    // refresh recency
    this.store.delete(key);
    this.store.set(key, hit);
    return hit.value;
  }

  set(key, value) {
    if (this.store.size >= this.max) {
      // drop oldest
      const oldest = this.store.keys().next().value;
      this.store.delete(oldest);
    }
    this.store.set(key, { value, expires: Date.now() + this.ttl });
    return value;
  }

  get size() {
    return this.store.size;
  }
}
