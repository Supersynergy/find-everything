/** Internal read identity, carried outside JSON response bodies. */
export const preparedFileStamp=Symbol('preparedFileStamp');

/** Byte-bounded LRU for immutable search response bodies. Live health is added later. */
export class SearchCache<T> {
  private entries = new Map<string, { at: number; data: T; bytes: number }>();
  private bytes = 0;
  constructor(private maxBytes = 16 * 1024 * 1024, private maxEntries = 256,
    private maxEntryBytes = 1024 * 1024, private ttl = 300000,
    private now: () => number = Date.now) {}

  get(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (!hit) return;
    this.entries.delete(key);
    if (this.now() - hit.at >= this.ttl) { this.bytes -= hit.bytes; return; }
    this.entries.set(key, hit);
    return hit.data;
  }

  set(key: string, data: T): void {
    const previous = this.entries.get(key);
    if (previous) { this.entries.delete(key); this.bytes -= previous.bytes; }
    const bytes = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(data));
    if (bytes > Math.min(this.maxBytes, this.maxEntryBytes)) return;
    while (this.entries.size && (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes)) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { at: this.now(), data, bytes }); this.bytes += bytes;
  }
}
