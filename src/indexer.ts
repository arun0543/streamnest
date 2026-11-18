import type { Source } from "./sources/types.ts";

export interface IndexInfo {
  /** Number of files found. */
  count: number;
  truncated: boolean;
  scannedAt: number;
}

interface Item {
  name: string;
  path: string;
  lpath: string;
  type: "dir" | "file";
}

export interface SearchHit {
  lib: string;
  name: string;
  path: string;
  type: "dir" | "file";
}

/** In-memory name index per library: powers "All libraries" search and the file counts in /admin. */
export class LibraryIndex {
  private items = new Map<string, Item[]>();
  private infos = new Map<string, IndexInfo>();
  private scanning = new Set<string>();

  isScanning(id: string): boolean {
    return this.scanning.has(id);
  }

  info(id: string): IndexInfo | undefined {
    return this.infos.get(id);
  }

  drop(id: string): void {
    this.items.delete(id);
    this.infos.delete(id);
  }

  /** Forget libraries that are no longer configured. */
  dropMissing(keep: Set<string>): void {
    for (const id of [...this.items.keys()]) if (!keep.has(id)) this.drop(id);
  }

  /** Breadth-first walk; unreadable folders are skipped. Bounded by entry count and time. */
  async scan(id: string, source: Source, opts: { maxEntries?: number; maxMs?: number } = {}): Promise<IndexInfo> {
    const maxEntries = opts.maxEntries ?? 250_000;
    const deadline = Date.now() + (opts.maxMs ?? 120_000);
    this.scanning.add(id);
    try {
      const items: Item[] = [];
      let files = 0;
      let truncated = false;
      const queue: string[] = [""];
      while (queue.length > 0) {
        if (items.length >= maxEntries || Date.now() > deadline) {
          truncated = true;
          break;
        }
        const dir = queue.shift()!;
        let entries;
        try {
          entries = await source.list(dir);
        } catch {
          continue;
        }
        for (const e of entries) {
          items.push({ name: e.name, path: e.path, lpath: e.path.toLowerCase(), type: e.type });
          if (e.type === "dir") queue.push(e.path);
          else files++;
        }
      }
      this.items.set(id, items);
      const info: IndexInfo = { count: files, truncated, scannedAt: Date.now() };
      this.infos.set(id, info);
      return info;
    } finally {
      this.scanning.delete(id);
    }
  }

  /** Every whitespace-separated term must appear in the item's path (case-insensitive). Name matches rank first. */
  search(query: string, libIds: string[], limit = 200): SearchHit[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const nameHits: SearchHit[] = [];
    const pathHits: SearchHit[] = [];
    for (const lib of libIds) {
      for (const it of this.items.get(lib) ?? []) {
        if (!terms.every((t) => it.lpath.includes(t))) continue;
        const hit: SearchHit = { lib, name: it.name, path: it.path, type: it.type };
        (terms.every((t) => it.name.toLowerCase().includes(t)) ? nameHits : pathHits).push(hit);
      }
      if (nameHits.length >= limit) break;
    }
    return [...nameHits, ...pathHits].slice(0, limit);
  }
}
