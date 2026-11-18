import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { assertInside, cleanRel, resolveLocal } from "./safe.ts";
import type { ByteRange, Entry, Source, TestResult } from "./types.ts";

/** Local disk, UNC shares (\\server\share) and mounted folders. */
export class LocalSource implements Source {
  readonly kind = "local" as const;

  constructor(private readonly root: string) {}

  /** Resolve, then re-check after following symlinks so links cannot escape the library. */
  private async resolve(rel: string): Promise<string> {
    const abs = resolveLocal(this.root, rel);
    const [realRoot, real] = await Promise.all([fsp.realpath(this.root), fsp.realpath(abs)]);
    assertInside(realRoot, real);
    return real;
  }

  async list(rel: string): Promise<Entry[]> {
    const dir = await this.resolve(rel);
    const base = cleanRel(rel);
    const dirents = await fsp.readdir(dir, { withFileTypes: true });
    const entries = await Promise.all(
      dirents.map(async (d): Promise<Entry | null> => {
        try {
          const st = await fsp.stat(path.join(dir, d.name));
          const entryPath = base ? `${base}/${d.name}` : d.name;
          if (st.isDirectory()) return { name: d.name, path: entryPath, type: "dir", mtime: st.mtimeMs };
          if (st.isFile()) return { name: d.name, path: entryPath, type: "file", size: st.size, mtime: st.mtimeMs };
          return null;
        } catch {
          return null; // broken link or permission problem: skip
        }
      }),
    );
    return entries
      .filter((e): e is Entry => e !== null)
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === "dir" ? -1 : 1));
  }

  async stat(rel: string): Promise<{ size: number; mtime: number; isFile: boolean }> {
    const st = await fsp.stat(await this.resolve(rel));
    return { size: st.size, mtime: st.mtimeMs, isFile: st.isFile() };
  }

  async read(rel: string, range?: ByteRange): Promise<NodeJS.ReadableStream> {
    const file = await this.resolve(rel);
    return range ? fs.createReadStream(file, { start: range.start, end: range.end }) : fs.createReadStream(file);
  }

  async test(): Promise<TestResult> {
    try {
      const st = await fsp.stat(this.root);
      if (!st.isDirectory()) return { ok: false, error: "Path is not a folder" };
      await fsp.access(this.root, fs.constants.R_OK);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as NodeJS.ErrnoException).code === "ENOENT" ? "Folder not found or unreachable" : "Folder is not readable" };
    }
  }

  async close(): Promise<void> {}
}
