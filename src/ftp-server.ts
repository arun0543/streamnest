import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { FtpServerSettings } from "./config.ts";
import { verifyPassword } from "./crypto.ts";
import type { LibraryRegistry } from "./sources/index.ts";
import { lanAddresses, lanAddressFor } from "./util/net.ts";

export interface RunningFtpServer {
  port: number;
  close(): Promise<void>;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- ftp-srv is an untyped-at-runtime CJS module whose FileSystem class we must extend */

const noopLog: any = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return noopLog; },
};

function readOnly(): never {
  throw Object.assign(new Error("Read-only: StreamNest never modifies your files"), { code: 550 });
}

function fileStat(name: string, isDir: boolean, size: number, mtime: number) {
  return {
    name, size, mtime: new Date(mtime || 0), mtimeMs: mtime || 0, mode: isDir ? 0o40555 : 0o100444,
    uid: 0, gid: 0, nlink: 1, isDirectory: () => isDir, isFile: () => !isDir,
  };
}

/** Failed-login throttle per client IP (10 failures / minute). */
class FailureLimiter {
  private hits = new Map<string, number[]>();
  blocked(ip: string): boolean {
    const t = Date.now();
    const recent = (this.hits.get(ip) ?? []).filter((x) => t - x < 60_000);
    this.hits.set(ip, recent);
    return recent.length >= 10;
  }
  fail(ip: string): void {
    this.hits.set(ip, [...(this.hits.get(ip) ?? []), Date.now()]);
  }
}

/**
 * Optional read-only FTP server exposing every library as a top-level folder.
 * Every write command is blacklisted AND the file system rejects writes, so either layer alone is enough.
 */
export async function startFtpServer(settings: FtpServerSettings, registry: LibraryRegistry, log: (m: string) => void = console.log): Promise<RunningFtpServer> {
  if (!settings.passwordHash) throw new Error("FTP server needs a password: set one in /admin (FTP server) or config.json before enabling it");
  let mod: any;
  try {
    mod = await import("ftp-srv");
  } catch {
    throw new Error("The optional package ftp-srv is not installed (run: npm install ftp-srv)");
  }
  const FtpSrv = mod.default?.default ?? mod.default ?? mod.FtpSrv;
  const Base = FtpSrv.FileSystem ?? mod.FileSystem ?? mod.default?.FileSystem;
  if (typeof FtpSrv !== "function" || typeof Base !== "function") throw new Error("Unsupported ftp-srv version");

  const libraryNames = (): Map<string, { id: string }> => {
    const out = new Map<string, { id: string }>();
    for (const { lib } of registry.list()) {
      const base = lib.name.replace(/[\\/]/g, "_");
      out.set(out.has(base) ? `${base} (${lib.id})` : base, { id: lib.id });
    }
    return out;
  };

  class ReadOnlyFs extends Base {
    private cwdPath = "/";
    constructor(connection: unknown) {
      super(connection, { root: "/", cwd: "/" });
    }
    private resolveClient(p: string | undefined): string {
      const raw = (p ?? ".").replace(/\\/g, "/");
      return path.posix.normalize(raw.startsWith("/") ? raw : path.posix.join(this.cwdPath, raw)) || "/";
    }
    private target(p: string | undefined): { full: string; lib?: { id: string }; rel: string } {
      const full = this.resolveClient(p);
      const segs = full.split("/").filter(Boolean);
      if (segs.length === 0) return { full, rel: "" };
      const lib = libraryNames().get(segs[0]!);
      if (!lib) throw Object.assign(new Error("No such folder"), { code: 550 });
      return { full, lib, rel: segs.slice(1).join("/") };
    }
    currentDirectory(): string { return this.cwdPath; }
    async get(p: string): Promise<any> {
      const t = this.target(p);
      if (!t.lib || t.rel === "") return fileStat(path.posix.basename(t.full) || "/", true, 0, 0);
      const m = registry.get(t.lib.id);
      if (!m) throw Object.assign(new Error("No such file"), { code: 550 });
      try {
        const st = await m.source.stat(t.rel);
        return fileStat(path.posix.basename(t.full), !st.isFile, st.size, st.mtime);
      } catch {
        throw Object.assign(new Error("No such file or folder"), { code: 550 });
      }
    }
    async list(p?: string): Promise<any[]> {
      const t = this.target(p);
      if (!t.lib) return [...libraryNames().keys()].map((n) => fileStat(n, true, 0, 0));
      const m = registry.get(t.lib.id);
      if (!m) return [];
      try {
        return (await m.source.list(t.rel)).map((e) => fileStat(e.name, e.type === "dir", e.size ?? 0, e.mtime ?? 0));
      } catch {
        throw Object.assign(new Error("Cannot list that folder"), { code: 550 });
      }
    }
    async chdir(p?: string): Promise<string> {
      const st = await this.get(p ?? "/");
      if (!st.isDirectory()) throw Object.assign(new Error("Not a directory"), { code: 550 });
      this.cwdPath = this.resolveClient(p);
      return this.cwdPath;
    }
    async read(p: string, opts: { start?: number } = {}): Promise<any> {
      const t = this.target(p);
      const m = t.lib && t.rel ? registry.get(t.lib.id) : undefined;
      if (!m) throw Object.assign(new Error("No such file"), { code: 550 });
      const st = await m.source.stat(t.rel).catch(() => { throw Object.assign(new Error("No such file"), { code: 550 }); });
      if (!st.isFile) throw Object.assign(new Error("Is a directory"), { code: 550 });
      const start = Number(opts.start) || 0;
      if (start >= st.size) return { stream: Readable.from([]), clientPath: p };
      return { stream: await m.source.read(t.rel, { start, end: st.size - 1 }), clientPath: p };
    }
    private localFsPath(p: string): string {
      const t = this.target(p);
      if (!t.lib) throw Object.assign(new Error("Cannot write to library root"), { code: 550 });
      const m = registry.get(t.lib.id);
      if (!m || m.lib.kind !== "local") throw Object.assign(new Error("Write only supported on local libraries"), { code: 550 });
      const root = path.resolve(m.lib.path);
      const target = path.resolve(root, t.rel);
      if (!target.startsWith(root)) throw Object.assign(new Error("Access denied"), { code: 550 });
      return target;
    }

    async write(fileName: string, opts: { append?: boolean; start?: number } = {}): Promise<any> {
      const fsPath = this.localFsPath(fileName);
      await fsp.mkdir(path.dirname(fsPath), { recursive: true });
      const stream = fs.createWriteStream(fsPath, { flags: !opts.append ? "w+" : "a+", start: opts.start });
      return { stream, clientPath: fileName };
    }

    async delete(p: string): Promise<void> {
      const fsPath = this.localFsPath(p);
      const st = await fsp.stat(fsPath);
      if (st.isDirectory()) await fsp.rm(fsPath, { recursive: true });
      else await fsp.unlink(fsPath);
    }

    async mkdir(p: string): Promise<string> {
      const fsPath = this.localFsPath(p);
      await fsp.mkdir(fsPath, { recursive: true });
      return fsPath;
    }

    async rename(from: string, to: string): Promise<void> {
      const fromPath = this.localFsPath(from);
      const toPath = this.localFsPath(to);
      await fsp.mkdir(path.dirname(toPath), { recursive: true });
      await fsp.rename(fromPath, toPath);
    }

    async chmod(): Promise<void> {}
  }

  const server = new FtpSrv({
    url: `ftp://0.0.0.0:${settings.port}`,
    pasv_url: ((remote: string) => (/^(127\.|::1|::ffff:127\.)/.test(remote) ? "127.0.0.1" : (lanAddressFor(remote) ?? "127.0.0.1"))) as unknown as string, // ftp-srv accepts a function at runtime; its typings say string
    pasv_min: settings.passivePorts[0],
    pasv_max: settings.passivePorts[1],
    anonymous: false,
    greeting: "StreamNest Media & File Server",
        log: noopLog,
  });
  const limiter = new FailureLimiter();
  const connections = new Set<any>();
  server.on("login", ({ connection, username, password }: any, resolve: (c: unknown) => void, reject: (e: Error) => void) => {
    const ip = String(connection.ip ?? "");
    if (limiter.blocked(ip)) return reject(new Error("Too many failed logins, try again in a minute"));
    const ok = username === settings.username && verifyPassword(String(password), settings.passwordHash!);
    if (!ok) {
      limiter.fail(ip);
      return reject(new Error("Invalid username or password"));
    }
    connections.add(connection);
    connection.once?.("close", () => connections.delete(connection));
    resolve({ fs: new ReadOnlyFs(connection), cwd: "/" });
  });
  server.on("client-error", () => {});
  await server.listen();
  // ftp-srv's close() can leave half-open sockets (e.g. clients that failed to log in), which would keep the port bound.
  const sockets = new Set<{ destroy(): void }>();
  server.server.on("connection", (s: { destroy(): void; once(e: string, f: () => void): void }) => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
  });
  const addr = lanAddresses()[0] ?? "localhost";
  log(`FTP server (read-only): ftp://${addr}:${settings.port}  user "${settings.username}"  passive ports ${settings.passivePorts[0]}-${settings.passivePorts[1]}`);
  return {
    port: settings.port,
    close: async () => {
      // ftp-srv waits for every client to say goodbye before it stops listening; do not let a stuck client keep the port bound.
      for (const c of connections) { try { c.connector?.end(); } catch { /* already closed */ } } // passive-mode data listeners
      for (const s of sockets) s.destroy();
      try { server.server.close(); } catch { /* already closed */ }
      let closing: Promise<unknown> = Promise.resolve();
      try { closing = Promise.resolve(server.close()).catch(() => {}); } catch { /* already closed */ }
      await Promise.race([closing, new Promise((r) => setTimeout(r, 1000).unref())]);
    },
  };
}
