import path from "node:path";
import { PassThrough } from "node:stream";
import { resolveRemote } from "./safe.ts";
import type { ByteRange, Entry, Source, TestResult } from "./types.ts";

export interface SmbOptions {
  host: string;
  port?: number;
  share: string;
  /** Folder inside the share ("" = share root). */
  path: string;
  domain: string;
  username: string;
  password: string;
}

export interface SmbDirEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

/** Thin seam over the SMB library so the source can be unit-tested without a server. */
export interface SmbBackend {
  list(p: string): Promise<SmbDirEntry[]>;
  readChunk(p: string, offset: number, end: number): AsyncIterable<Buffer>;
  close(): Promise<void>;
}

export type SmbConnect = (opts: SmbOptions) => Promise<SmbBackend>;

const NT = {
  LOGON_FAILURE: 0xc000006d,
  ACCOUNT_DISABLED: 0xc0000072,
  ACCESS_DENIED: 0xc0000022,
  BAD_NETWORK_NAME: 0xc00000cc,
  NOT_FOUND: 0xc0000034,
  PATH_NOT_FOUND: 0xc000003a,
  NOT_SUPPORTED: 0xc00000bb,
} as const;

/** Map library/socket errors to something a human can act on. */
export function describeSmbError(err: unknown): string {
  const e = err as { code?: string; message?: string; header?: { status?: number } };
  const status = e.header?.status;
  if (status === NT.LOGON_FAILURE || status === NT.ACCOUNT_DISABLED) return "Authentication failed: wrong username, password or domain";
  if (status === NT.BAD_NETWORK_NAME) return "Share not found on that host (check the share name)";
  if (status === NT.NOT_FOUND || status === NT.PATH_NOT_FOUND) return "Folder not found inside the share";
  if (status === NT.ACCESS_DENIED) return "Access denied: this user may not read that share or folder";
  if (status === NT.NOT_SUPPORTED) return "The server rejected the request (it may require SMB signing/encryption, which this client does not support: use a UNC path or mount the share instead)";
  if (e.code === "ENOTFOUND" || e.code === "EAI_AGAIN") return "Host not found: check the address";
  if (e.code === "ECONNREFUSED") return "Connection refused: is file sharing (SMB, port 445) enabled on that host?";
  if (e.code === "ETIMEDOUT" || e.code === "EHOSTUNREACH" || e.code === "ENETUNREACH" || e.message === "connect_timeout") return "Host unreachable (timed out)";
  if (e.code === "ECONNRESET" || e.message === "not_connected") {
    return "The server closed the connection. It may only support SMB1, or require SMB3 signing/encryption; this client speaks SMB 2.0.2/2.1 only. Use a UNC path (Windows) or mount the share (Linux) instead.";
  }
  if (typeof e.message === "string" && e.message.startsWith("request_timeout")) return "The server did not answer in time (it may require SMB3 or signing; try a UNC path / mount)";
  return `SMB error: ${e.message ?? (status !== undefined ? `status 0x${status.toString(16)}` : String(err))}`;
}

function notFound(): Error {
  return Object.assign(new Error("not found"), { code: "ENOENT" });
}

function isStatus(err: unknown, ...codes: number[]): boolean {
  const s = (err as { header?: { status?: number } }).header?.status;
  return s !== undefined && codes.includes(s);
}

function isConnectionError(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e.code === "ECONNRESET" || e.code === "EPIPE" || e.message === "not_connected" || (e.message ?? "").startsWith("request_timeout");
}

const READ_CHUNK = 0x10000; // the library's per-request read size

/** Real backend on @awo00/smb2 (SMB 2.0.2 / 2.1, NTLM). Loaded lazily because it is an optional dependency. */
export const connectSmb2: SmbConnect = async (o) => {
  let mod: Record<string, unknown>;
  let fileMod: Record<string, unknown>;
  try {
    mod = (await import("@awo00/smb2")) as Record<string, unknown>;
    fileMod = (await import("@awo00/smb2/dist/client/File.js")) as Record<string, unknown>;
  } catch {
    throw new Error("The optional package @awo00/smb2 is not installed (run: npm install @awo00/smb2), or mount the share and add it as a local folder");
  }
  // The package is CommonJS: depending on the loader the exports sit on `default` or one level deeper.
  /* eslint-disable @typescript-eslint/no-explicit-any -- untyped CJS interop and library-private readChunk (offset reads) */
  const unwrap = (m: any, key: string): any => m[key] ?? m.default?.[key] ?? m.default?.default?.[key];
  const ClientCtor = unwrap(mod, "Client");
  const FileCtor = (fileMod as any).default?.default ?? (fileMod as any).default;
  const client = new ClientCtor(o.host, { ...(o.port ? { port: o.port } : {}), connectTimeout: 10_000, requestTimeout: 30_000 });
  try {
    await client.connect();
    const session = await client.authenticate({ domain: o.domain, username: o.username, password: o.password });
    const tree = await session.connectTree(o.share);
    return {
      async list(p: string): Promise<SmbDirEntry[]> {
        const entries: any[] = await tree.readDirectory(p || "/");
        return entries
          .filter((e) => e.filename !== "." && e.filename !== "..")
          .map((e) => ({ name: e.filename, isDir: e.type === "Directory", size: Number(e.fileSize), mtime: e.lastWriteTime instanceof Date ? e.lastWriteTime.getTime() : 0 }));
      },
      async *readChunk(p: string, offset: number, end: number): AsyncIterable<Buffer> {
        const file = new FileCtor(tree);
        await file.open(p);
        try {
          const size = Number(file.fileSize);
          let off = offset;
          const last = Math.min(end, size - 1);
          while (off <= last) {
            // readChunk(index, offset) reads up to the end of 64 KiB block `index`, so any offset works
            const buf: Buffer = await file.readChunk(Math.floor(off / READ_CHUNK), off);
            if (buf.length === 0) break;
            const take = Math.min(buf.length, last - off + 1);
            yield take === buf.length ? buf : buf.subarray(0, take);
            off += take;
          }
        } finally {
          await file.close().catch(() => {});
        }
      },
      async close(): Promise<void> {
        await client.close().catch(() => {});
      },
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }
};

export class SmbSource implements Source {
  readonly kind = "smb" as const;
  private backend: Promise<SmbBackend> | undefined;

  constructor(private opts: SmbOptions, private connect: SmbConnect = connectSmb2) {}

  private conn(): Promise<SmbBackend> {
    if (!this.backend) {
      this.backend = this.connect(this.opts);
      this.backend.catch(() => { this.backend = undefined; });
    }
    return this.backend;
  }

  private async reset(): Promise<void> {
    const b = this.backend;
    this.backend = undefined;
    if (b) await (await b.catch(() => undefined))?.close();
  }

  private async withBackend<T>(fn: (b: SmbBackend) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn(await this.conn());
      } catch (err) {
        if (attempt === 0 && isConnectionError(err)) {
          await this.reset();
          continue;
        }
        if (isStatus(err, NT.NOT_FOUND, NT.PATH_NOT_FOUND)) throw notFound();
        throw err;
      }
    }
  }

  private full(rel: string): string {
    return resolveRemote(this.opts.path, rel);
  }

  async list(rel: string): Promise<Entry[]> {
    const base = rel.split(/[\\/]/).filter((s) => s && s !== ".").join("/");
    const items = await this.withBackend((b) => b.list(this.full(rel)));
    return items
      .map((i): Entry => {
        const p = base ? `${base}/${i.name}` : i.name;
        return i.isDir
          ? { name: i.name, path: p, type: "dir", ...(i.mtime ? { mtime: i.mtime } : {}) }
          : { name: i.name, path: p, type: "file", size: i.size, ...(i.mtime ? { mtime: i.mtime } : {}) };
      })
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === "dir" ? -1 : 1));
  }

  async stat(rel: string): Promise<{ size: number; mtime: number; isFile: boolean }> {
    const full = this.full(rel);
    if (full === this.full("")) return { size: 0, mtime: 0, isFile: false };
    const parent = path.posix.dirname(full);
    const name = path.posix.basename(full).toLowerCase();
    const items = await this.withBackend((b) => b.list(parent));
    const hit = items.find((i) => i.name.toLowerCase() === name);
    if (!hit) throw notFound();
    return { size: hit.isDir ? 0 : hit.size, mtime: hit.mtime, isFile: !hit.isDir };
  }

  async read(rel: string, range?: ByteRange): Promise<NodeJS.ReadableStream> {
    const full = this.full(rel);
    const start = range?.start ?? 0;
    const end = range?.end ?? Number.MAX_SAFE_INTEGER;
    const out = new PassThrough();
    void (async () => {
      for (let attempt = 0; ; attempt++) {
        let delivered = 0;
        try {
          const backend = await this.conn();
          for await (const buf of backend.readChunk(full, start, end)) {
            if (out.destroyed) return;
            delivered += buf.length;
            if (!out.write(buf)) await new Promise<void>((r) => out.once("drain", r).once("close", r));
          }
          out.end();
          return;
        } catch (err) {
          if (attempt === 0 && delivered === 0 && isConnectionError(err)) {
            await this.reset();
            continue;
          }
          out.destroy(err instanceof Error ? err : new Error(String(err)));
          return;
        }
      }
    })();
    return out;
  }

  async test(): Promise<TestResult> {
    try {
      await this.withBackend((b) => b.list(this.full("")));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: describeSmbError(err) };
    }
  }

  async close(): Promise<void> {
    await this.reset();
  }
}
