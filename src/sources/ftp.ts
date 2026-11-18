import { Client, FileType } from "basic-ftp";
import { PassThrough, Writable } from "node:stream";
import path from "node:path";
import { resolveRemote } from "./safe.ts";
import type { ByteRange, Entry, Source, TestResult } from "./types.ts";

export interface FtpOptions {
  host: string;
  port: number;
  secure: "none" | "explicit" | "implicit";
  username: string;
  password: string;
  basePath: string;
  maxConnections: number;
  allowSelfSigned?: boolean;
  /** Close idle pooled connections after this long. */
  idleMs?: number;
  timeoutMs?: number;
}

type Waiter = { resolve: (c: Client) => void; reject: (e: unknown) => void };

/** FTP allows one transfer per connection, so keep a small pool with an idle timeout. */
class Pool {
  private idle: { client: Client; timer: NodeJS.Timeout }[] = [];
  private total = 0;
  private waiters: Waiter[] = [];
  private closed = false;

  constructor(private connect: () => Promise<Client>, private max: number, private idleMs: number) {}

  async acquire(): Promise<Client> {
    if (this.closed) throw new Error("source closed");
    for (let it = this.idle.pop(); it; it = this.idle.pop()) {
      clearTimeout(it.timer);
      if (!it.client.closed) return it.client;
      this.total--;
    }
    if (this.total < this.max) return this.create();
    return new Promise<Client>((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private async create(): Promise<Client> {
    this.total++;
    try {
      return await this.connect();
    } catch (err) {
      this.total--;
      this.wakeOne();
      throw err;
    }
  }

  private wakeOne(): void {
    const w = this.waiters.shift();
    if (w) this.create().then(w.resolve, w.reject);
  }

  release(client: Client, reuse: boolean): void {
    if (!reuse || client.closed || this.closed) {
      client.close();
      this.total--;
      this.wakeOne();
      return;
    }
    const w = this.waiters.shift();
    if (w) return w.resolve(client);
    const entry = { client, timer: setTimeout(() => {
      this.idle = this.idle.filter((e) => e !== entry);
      client.close();
      this.total--;
    }, this.idleMs) };
    entry.timer.unref();
    this.idle.push(entry);
  }

  close(): void {
    this.closed = true;
    for (const e of this.idle) { clearTimeout(e.timer); e.client.close(); }
    this.idle = [];
    for (const w of this.waiters) w.reject(new Error("source closed"));
    this.waiters = [];
  }
}

/** Translate low-level FTP/socket errors into messages a human can act on. */
export function describeFtpError(err: unknown): string {
  const e = err as { code?: string | number; message?: string };
  const msg = e.message ?? String(err);
  if (e.code === 530 || /^530/.test(msg)) return "Login failed: wrong username or password";
  if (e.code === "ENOTFOUND" || e.code === "EAI_AGAIN") return "Host not found: check the address";
  if (e.code === "ECONNREFUSED") return "Connection refused: is an FTP server running on that host and port?";
  if (e.code === "ETIMEDOUT" || e.code === "EHOSTUNREACH" || e.code === "ENETUNREACH" || /timeout|timed out/i.test(msg)) return "Host unreachable (timed out)";
  if (e.code === 550 || /^550/.test(msg)) return "Folder not found on the server";
  if (/certificate|self.signed|SSL|TLS|wrong version/i.test(msg)) return `TLS problem: ${msg} (for a self-signed certificate enable "allow self-signed")`;
  if (e.code === 534 || e.code === 504 || /^53[45]|^50[40]/.test(msg)) return "The server refused to switch to secure mode (try plain FTP)";
  return `FTP error: ${msg}`;
}

function notFound(): Error {
  return Object.assign(new Error("not found"), { code: "ENOENT" });
}

/** 550 is the standard "no such file"; some servers (ftp-srv) answer 451 with an ENOENT message. */
function isNoSuchFile(err: unknown): boolean {
  const e = err as { code?: number; message?: string };
  return e.code === 550 || /ENOENT|no such file|not found/i.test(e.message ?? "");
}

function isConnectionError(err: unknown): boolean {
  const e = err as { code?: string | number; message?: string };
  return typeof e.code === "string" && /^(ECONNRESET|EPIPE|ETIMEDOUT|ECONNABORTED)$/.test(e.code) || /closed|timeout|421|socket/i.test(e.message ?? "");
}

export class FtpSource implements Source {
  readonly kind = "ftp" as const;
  private pool: Pool;

  constructor(private opts: FtpOptions) {
    this.pool = new Pool(() => this.connect(), opts.maxConnections, opts.idleMs ?? 30_000);
  }

  private async connect(): Promise<Client> {
    const client = new Client(this.opts.timeoutMs ?? 15_000);
    try {
      await client.access({
        host: this.opts.host,
        port: this.opts.port,
        user: this.opts.username,
        password: this.opts.password,
        secure: this.opts.secure === "implicit" ? "implicit" : this.opts.secure === "explicit",
        ...(this.opts.secure !== "none" ? { secureOptions: { rejectUnauthorized: !this.opts.allowSelfSigned, servername: this.opts.host } } : {}),
      });
    } catch (err) {
      client.close();
      throw err;
    }
    return client;
  }

  /** Run `fn` on a pooled connection; on a dropped connection retry once on a fresh one. */
  private async withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const client = await this.pool.acquire();
      try {
        const result = await fn(client);
        this.pool.release(client, true);
        return result;
      } catch (err) {
        const retry = attempt === 0 && isConnectionError(err);
        this.pool.release(client, false);
        if (!retry) throw err;
      }
    }
  }

  async list(rel: string): Promise<Entry[]> {
    const full = resolveRemote(this.opts.basePath, rel);
    const base = rel.split(/[\\/]/).filter((s) => s && s !== ".").join("/");
    let infos;
    try {
      infos = await this.withClient((c) => c.list(full));
    } catch (err) {
      if (isNoSuchFile(err)) throw notFound();
      throw err;
    }
    return infos
      .filter((i) => i.name !== "." && i.name !== "..")
      .map((i): Entry => {
        const isDir = i.type === FileType.Directory || (i.type === FileType.SymbolicLink && !path.posix.extname(i.name));
        const p = base ? `${base}/${i.name}` : i.name;
        const mtime = i.modifiedAt?.getTime();
        return isDir
          ? { name: i.name, path: p, type: "dir", ...(mtime ? { mtime } : {}) }
          : { name: i.name, path: p, type: "file", size: i.size, ...(mtime ? { mtime } : {}) };
      })
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === "dir" ? -1 : 1));
  }

  async stat(rel: string): Promise<{ size: number; mtime: number; isFile: boolean }> {
    const full = resolveRemote(this.opts.basePath, rel);
    if (full === resolveRemote(this.opts.basePath, "")) return { size: 0, mtime: 0, isFile: false };
    // SIZE on a directory is answered inconsistently across servers, so look the entry up in its parent listing.
    const parent = path.posix.dirname(full);
    const name = path.posix.basename(full);
    const infos = await this.withClient((c) => c.list(parent)).catch((err: unknown) => {
      throw isNoSuchFile(err) ? notFound() : err;
    });
    const hit = infos.find((i) => i.name === name);
    if (!hit) throw notFound();
    const isDir = hit.type === FileType.Directory || (hit.type === FileType.SymbolicLink && !path.posix.extname(hit.name));
    return { size: isDir ? 0 : hit.size, mtime: hit.modifiedAt?.getTime() ?? 0, isFile: !isDir };
  }

  async read(rel: string, range?: ByteRange): Promise<NodeJS.ReadableStream> {
    const full = resolveRemote(this.opts.basePath, rel);
    const out = new PassThrough();
    void this.pump(full, range, out);
    return out;
  }

  /**
   * Streams one file (or byte range) into `out`. Uses REST (startAt) to seek and drops the connection once the
   * range is satisfied, because an FTP data transfer cannot be stopped any other way. Dropped connections are
   * retried once if no bytes were delivered yet.
   */
  private async pump(full: string, range: ByteRange | undefined, out: PassThrough): Promise<void> {
    const limit = range ? range.end - range.start + 1 : Infinity;
    for (let attempt = 0; ; attempt++) {
      let client: Client | undefined;
      let delivered = 0;
      let reachedLimit = false;
      let aborted = false;
      try {
        client = await this.pool.acquire();
        const c = client;
        const onClose = (): void => { if (!out.writableEnded) { aborted = true; c.close(); } };
        out.once("close", onClose);
        const sink = new Writable({
          write(chunk: Buffer, _enc, cb) {
            if (aborted || out.destroyed) return cb(new Error("aborted"));
            const remaining = limit - delivered;
            const buf = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
            delivered += buf.length;
            const finish = (): void => {
              if (delivered >= limit) { reachedLimit = true; c.close(); }
              cb();
            };
            if (out.write(buf)) finish(); else out.once("drain", finish);
          },
        });
        await c.downloadTo(sink, full, range?.start ?? 0);
        out.off("close", onClose);
        this.pool.release(c, true);
        out.end();
        return;
      } catch (err) {
        if (client) this.pool.release(client, false);
        if (reachedLimit) { out.end(); return; }
        if (aborted || out.destroyed) return;
        if (delivered === 0 && attempt === 0 && (isConnectionError(err) || client === undefined)) continue;
        out.destroy(err instanceof Error ? err : new Error(String(err)));
        return;
      }
    }
  }

  async test(): Promise<TestResult> {
    try {
      await this.withClient(async (c) => {
        await c.list(resolveRemote(this.opts.basePath, ""));
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: describeFtpError(err) };
    }
  }

  async close(): Promise<void> {
    this.pool.close();
  }
}
