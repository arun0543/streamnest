import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { Auth, SESSION_COOKIE, clientKey, isLocalRequest, parseCookies, type ShareKind, type ShareMode } from "./auth.ts";
import { ROOT_DIR, configPath, loadConfig, newId, saveConfig, type Config, type Library } from "./config.ts";
import { dataDir as defaultDataDir, deriveKey, encrypt, loadSecret } from "./crypto.ts";
import { createSource } from "./sources/index.ts";
import { startFtpServer, type RunningFtpServer } from "./ftp-server.ts";
import { assertOnlineAllowed, startTunnel } from "./tunnel.ts";
import { hashPassword } from "./crypto.ts";
import { LibraryIndex } from "./indexer.ts";
import { addLocalFolders, removeLibraries } from "./libraries.ts";
import { LibraryRegistry } from "./sources/index.ts";
import { LocalSource } from "./sources/local.ts";
import { SafePathError, cleanRel } from "./sources/safe.ts";
import { serveFile } from "./stream.ts";
import { withTimeout } from "./util/async.ts";
import { browseRoots, lanAddresses, listSubdirs } from "./util/net.ts";

const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const DOCS_DIR = path.join(ROOT_DIR, "docs");

export interface App {
  server: http.Server;
  registry: LibraryRegistry;
  auth: Auth;
  /** Set when the cloudflared tunnel is up so share links can include an online URL. */
  setTunnelUrl(url: string | undefined): void;
  close(): Promise<void>;
}

export interface AppOptions {
  dataDir?: string;
  secret?: Buffer;
  now?: () => number;
  /** If set, library changes are saved here and external edits (CLI) are hot-reloaded. */
  configFile?: string;
  watchIntervalMs?: number;
  /** Skip the background scan that builds the search index (tests). */
  noAutoScan?: boolean;
  /** Never start the built-in FTP server, even if enabled in config. */
  noFtpServer?: boolean;
}

const EXPIRY_MS: Record<string, number> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000, never: 0 };

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: http.OutgoingHttpHeaders = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text), ...headers }).end(text);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function sendHtml(res: http.ServerResponse, status: number, title: string, body: string): void {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title>
<style>:root{color-scheme:dark light}body{font:16px system-ui,sans-serif;max-width:860px;margin:0 auto;padding:16px}video,audio{width:100%;max-height:70vh}a{color:#4f9cff}li{padding:6px 0}</style></head><body>${body}</body></html>`;
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html), "Referrer-Policy": "no-referrer" }).end(html);
}

function sendError(res: http.ServerResponse, err: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (err instanceof SafePathError) return sendJson(res, 400, { error: "invalid path" });
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") return sendJson(res, 404, { error: "not found" });
  console.error("request failed:", code ?? (err as Error).message);
  sendJson(res, 500, { error: "internal error" });
}

async function readJson(req: http.IncomingMessage, limit = 8192): Promise<Record<string, unknown> | null> {
  if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) return null;
    chunks.push(c as Buffer);
  }
  try {
    const v: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const VIDEO = /\.(mp4|m4v|webm|mkv|mov|avi)$/i;
const AUDIO = /\.(mp3|m4a|aac|flac|wav|ogg|opus|oga)$/i;

export async function createApp(config: Config, extraLibraries: Library[] = [], opts: AppOptions = {}): Promise<App> {
  const dir = opts.dataDir ?? defaultDataDir();
  const secret = opts.secret ?? loadSecret(dir);
  const credKey = deriveKey(secret, "credentials");
  const registry = new LibraryRegistry({ credKey });
  const index = new LibraryIndex();
  let current = config;
  let lastSig = JSON.stringify(config);
  const scanSoon = (id: string): void => {
    const m = registry.get(id);
    if (!m || opts.noAutoScan || index.isScanning(id)) return;
    void index.scan(id, m.source).catch(() => {}); // background; failures leave the library unindexed
  };
  /** Swap in a new config without restarting: remount sources, drop stale index entries, scan new libraries. */
  async function applyConfig(next: Config, save: boolean): Promise<void> {
    current = next;
    lastSig = JSON.stringify(next);
    if (save && opts.configFile) saveConfig(next, opts.configFile);
    await registry.reload([...next.libraries, ...extraLibraries]);
    auth.setPasswordHash(next.admin?.passwordHash);
    const ids = new Set(registry.list().map((m) => m.lib.id));
    for (const m of registry.list()) if (!index.info(m.lib.id)) scanSoon(m.lib.id);
    index.dropMissing(ids);
    await syncFtpServer(next.ftpServer);
  }

  // Optional built-in FTP server: started/stopped whenever its settings change (admin page or config.json edit).
  let ftp: { sig: string; running?: RunningFtpServer } | undefined;
  let ftpError: string | undefined;
  let ftpChain: Promise<unknown> = Promise.resolve();
  /** Serialized: the config watcher and an admin request can both apply settings at the same moment. */
  function syncFtpServer(s: Config["ftpServer"]): Promise<void> {
    const run = ftpChain.then(() => doSyncFtpServer(s));
    ftpChain = run.catch(() => {});
    return run;
  }
  async function doSyncFtpServer(s: Config["ftpServer"]): Promise<void> {
    const sig = JSON.stringify(s);
    if (ftp?.sig === sig) return;
    await ftp?.running?.close().catch(() => {});
    ftp = { sig };
    ftpError = undefined;
    if (!s.enabled || opts.noFtpServer) return;
    try {
      ftp.running = await startFtpServer(s, registry);
    } catch (err) {
      ftpError = (err as Error).message;
      console.warn(`FTP server not started: ${ftpError}`);
    }
  }
  let tunnelUrl: string | undefined;
  const auth = new Auth({
    dataDir: dir,
    secret,
    passwordHash: config.admin?.passwordHash,
    ...(opts.now ? { now: opts.now } : {}),
  });
  const publicSource = new LocalSource(PUBLIC_DIR);
  const docsSource = new LocalSource(DOCS_DIR);
  await applyConfig(config, false);

  // Hot reload: the CLI (or a hand edit) changes config.json while the server runs.
  const configFile = opts.configFile;
  if (configFile) {
    fs.watchFile(configFile, { interval: opts.watchIntervalMs ?? 1500, persistent: false }, () => {
      try {
        const next = loadConfig(configFile);
        if (JSON.stringify(next) !== lastSig) {
          void applyConfig(next, false).then(() => console.log(`config reloaded: ${next.libraries.length} libraries`));
        }
      } catch (err) {
        console.warn(`config reload skipped: ${(err as Error).message}`);
      }
    });
  }

  const withStatus = async (m: { lib: Library; source: import("./sources/types.ts").Source }) =>
    (await withTimeout(m.source.test(), 5000, { ok: false as const, error: "timed out" })).ok ? "online" : "unreachable";

  const isHttps = (req: http.IncomingMessage) => req.headers["x-forwarded-proto"] === "https";
  const sessionToken = (req: http.IncomingMessage) => parseCookies(req.headers.cookie)[SESSION_COOKIE];
  /** Logged in, or no password configured and the request comes straight from this machine. */
  const isAuthed = (req: http.IncomingMessage) =>
    auth.validSession(sessionToken(req)) || (!auth.hasPassword() && isLocalRequest(req));

  function origins(token: string): { lan: string[]; path: string; online: string | null } {
    const port = (server.address() as AddressInfo | null)?.port ?? 0;
    return {
      path: `/s/${token}`,
      lan: lanAddresses().map((ip) => `http://${ip}:${port}/s/${token}`),
      online: tunnelUrl ? `${tunnelUrl}/s/${token}` : null,
    };
  }

  async function handleShare(req: http.IncomingMessage, res: http.ServerResponse, url: URL, pathname: string): Promise<void> {
    const m = /^\/s\/([^/]+)(\/raw)?$/.exec(pathname);
    const payload = m ? auth.shares.verify(m[1]!) : null;
    if (!m || !payload) return sendHtml(res, 403, "Link unavailable", "<h1>Link unavailable</h1><p>This link is invalid, expired or has been revoked.</p>");
    const mounted = registry.get(payload.lib);
    if (!mounted) return sendHtml(res, 404, "Not found", "<h1>Not found</h1>");
    const token = m[1]!;
    const sub = payload.kind === "folder" ? (url.searchParams.get("p") ?? "") : "";
    const rel = payload.kind === "folder" ? cleanRel(`${payload.path}/${sub}`) : payload.path;

    if (m[2]) return serveFile(req, res, mounted.source, rel, { download: payload.mode === "download" });

    const st = await mounted.source.stat(rel);
    const name = path.posix.basename(rel) || mounted.lib.name;
    const rawHref = `/s/${token}/raw${payload.kind === "folder" ? `?p=${encodeURIComponent(sub)}` : ""}`;
    if (st.isFile) {
      let player: string;
      if (payload.mode === "download") player = `<p><a href="${esc(rawHref)}" download>Download ${esc(name)}</a></p>`;
      else if (VIDEO.test(name)) player = `<video controls autoplay playsinline src="${esc(rawHref)}"></video>`;
      else if (AUDIO.test(name)) player = `<audio controls autoplay src="${esc(rawHref)}"></audio>`;
      else player = `<p><a href="${esc(rawHref)}">Open ${esc(name)}</a></p>`;
      return sendHtml(res, 200, name, `<h1>${esc(name)}</h1>${player}`);
    }
    const entries = await mounted.source.list(rel);
    const base = cleanRel(payload.path);
    const items = entries.map((e) => {
      const p = base && e.path.startsWith(base + "/") ? e.path.slice(base.length + 1) : e.path;
      const href = e.type === "dir" ? `/s/${token}?p=${encodeURIComponent(p)}` : `/s/${token}/raw?p=${encodeURIComponent(p)}`;
      return `<li>${e.type === "dir" ? "📁" : "▶"} <a href="${esc(href)}">${esc(e.name)}</a></li>`;
    });
    const up = sub ? `<p><a href="/s/${esc(token)}?p=${encodeURIComponent(sub.split("/").slice(0, -1).join("/"))}">⬆ Up</a></p>` : "";
    return sendHtml(res, 200, name, `<h1>${esc(name)}</h1>${up}<ul style="list-style:none;padding:0">${items.join("")}</ul>`);
  }

  let queue: Promise<unknown> = Promise.resolve();
  /** Serialize config changes so two admin requests cannot overwrite each other. */
  const exclusive = <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  /** Validate a remote-library form. The password is encrypted immediately and is never echoed back. */
  function buildRemote(b: Record<string, unknown>): { lib: Library } | { error: string } {
    const s = (k: string): string => (typeof b[k] === "string" ? (b[k] as string).trim() : "");
    const host = s("host");
    if (!host || /[\s/\\]/.test(host)) return { error: "Enter a host name or IP address (no slashes)" };
    const name = s("name") || host;
    const pw = typeof b.password === "string" ? b.password : "";
    const passwordEnc = pw ? encrypt(pw, credKey) : "";
    const port = typeof b.port === "number" && Number.isInteger(b.port) && b.port > 0 && b.port < 65536 ? b.port : undefined;
    if (b.kind === "smb") {
      const share = s("share").replace(/^[\\/]+|[\\/]+$/g, "");
      if (!share || /[\\/]/.test(share)) return { error: "Enter the share name (e.g. Media), without slashes" };
      return { lib: { id: newId(), name, kind: "smb", host, share, path: s("path"), domain: s("domain"), username: s("username"), passwordEnc, ...(port ? { port } : {}) } };
    }
    if (b.kind === "ftp") {
      const secure = b.secure === "explicit" || b.secure === "implicit" ? b.secure : "none";
      return {
        lib: {
          id: newId(), name, kind: "ftp", host, port: port ?? (secure === "implicit" ? 990 : 21), secure,
          username: s("username") || "anonymous", passwordEnc, basePath: s("basePath") || "/", maxConnections: 2,
          ...(b.allowSelfSigned === true ? { allowSelfSigned: true } : {}),
        },
      };
    }
    return { error: "kind must be smb or ftp" };
  }

  async function handleLibraryAdmin(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
    const body = await readJson(req, 65_536);
    if (!body) return sendJson(res, 400, { error: "expected a JSON body" });
    const dto = (l: Library) => ({ id: l.id, name: l.name, kind: l.kind });
    const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

    if (pathname === "/api/admin/libraries") {
      const paths = strings(body.paths);
      const name = typeof body.name === "string" && body.name.trim() ? body.name : undefined;
      if (paths.length === 0 || paths.length > 200) return sendJson(res, 400, { error: "provide 1-200 paths" });
      if (name && paths.length !== 1) return sendJson(res, 400, { error: "a name can only be given for a single path" });
      return exclusive(async () => {
        const next = structuredClone(current);
        const result = await addLocalFolders(next, paths, name);
        if (result.added.length > 0) await applyConfig(next, true);
        sendJson(res, 200, { added: result.added.map(dto), skipped: result.skipped });
      });
    }
    if (pathname === "/api/admin/libraries/rename") {
      const id = typeof body.id === "string" ? body.id : "";
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name || name.length > 120) return sendJson(res, 400, { error: "invalid name" });
      return exclusive(async () => {
        const next = structuredClone(current);
        const lib = next.libraries.find((l) => l.id === id);
        if (!lib) return sendJson(res, 404, { error: "unknown library" });
        lib.name = name;
        await applyConfig(next, true);
        sendJson(res, 200, { ok: true });
      });
    }
    if (pathname === "/api/admin/libraries/remove") {
      const ids = strings(body.ids);
      return exclusive(async () => {
        const next = structuredClone(current);
        const r = removeLibraries(next, ids.filter((i) => next.libraries.some((l) => l.id === i)));
        if (r.removed.length > 0) await applyConfig(next, true);
        sendJson(res, 200, { removed: r.removed.map(dto) });
      });
    }
    if (pathname === "/api/admin/libraries/test-remote" || pathname === "/api/admin/libraries/add-remote") {
      const built = buildRemote(body);
      if ("error" in built) return sendJson(res, 400, { error: built.error });
      const probe = createSource(built.lib, { credKey });
      const result = await withTimeout(probe.test(), 20_000, { ok: false as const, error: "timed out" }).finally(() => void probe.close());
      if (pathname === "/api/admin/libraries/test-remote") return sendJson(res, 200, result);
      if (!result.ok && body.skipTest !== true) return sendJson(res, 400, { error: `Connection test failed: ${result.error}` });
      return exclusive(async () => {
        const next = structuredClone(current);
        next.libraries.push(built.lib);
        await applyConfig(next, true);
        sendJson(res, 200, { added: dto(built.lib) });
      });
    }
    const m = typeof body.id === "string" ? registry.get(body.id) : undefined;
    if (!m) return sendJson(res, 404, { error: "unknown library" });
    if (pathname === "/api/admin/libraries/test") return sendJson(res, 200, await withTimeout(m.source.test(), 10_000, { ok: false as const, error: "timed out" }));
    if (pathname === "/api/admin/libraries/rescan") {
      if (index.isScanning(m.lib.id)) return sendJson(res, 409, { error: "already scanning" });
      const info = await index.scan(m.lib.id, m.source);
      return sendJson(res, 200, { fileCount: info.count, truncated: info.truncated });
    }
    return sendJson(res, 404, { error: "not found" });
  }

  async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL, pathname: string): Promise<void> {
    if (pathname === "/api/session" && req.method === "GET") {
      return sendJson(res, 200, { authenticated: isAuthed(req), setupRequired: !auth.hasPassword(), online: tunnelUrl ?? null });
    }

    if (pathname === "/api/login" && req.method === "POST") {
      const wait = auth.limiter.hit(clientKey(req));
      if (wait > 0) return sendJson(res, 429, { error: "too many attempts, try again later" }, { "Retry-After": wait });
      const body = await readJson(req);
      const password = body?.password;
      if (typeof password !== "string" || !auth.checkPassword(password)) return sendJson(res, 401, { error: "wrong password" });
      return sendJson(res, 200, { ok: true }, { "Set-Cookie": auth.sessionCookie(auth.createSession(), isHttps(req)) });
    }
    if (pathname === "/api/logout" && req.method === "POST") {
      auth.destroySession(sessionToken(req));
      return sendJson(res, 200, { ok: true }, { "Set-Cookie": auth.clearCookie() });
    }

    if (!isAuthed(req)) return sendJson(res, 401, { error: "login required", setupRequired: !auth.hasPassword() });

    if (pathname === "/api/share" && req.method === "POST") {
      const body = await readJson(req);
      const lib = typeof body?.lib === "string" ? registry.get(body.lib) : undefined;
      const mode = body?.mode ?? "stream";
      const expiry = typeof body?.expiry === "string" ? body.expiry : "24h";
      if (!body || !lib || typeof body.path !== "string" || (mode !== "stream" && mode !== "download") || !(expiry in EXPIRY_MS)) {
        return sendJson(res, 400, { error: "invalid share request" });
      }
      const rel = cleanRel(body.path);
      const st = await lib.source.stat(rel); // throws ENOENT -> 404
      const kind: ShareKind = st.isFile ? "file" : "folder";
      const { token, record } = auth.shares.create({ lib: lib.lib.id, path: rel, kind, mode: mode as ShareMode, ttlMs: EXPIRY_MS[expiry]! });
      return sendJson(res, 200, { jti: record.jti, kind, expiresAt: record.exp, ...origins(token), raw: `/s/${token}/raw` });
    }

    if (pathname === "/api/admin/shares" && req.method === "GET") {
      return sendJson(res, 200, auth.shares.list().map((r) => ({
        jti: r.jti, lib: r.lib, path: r.path, kind: r.kind, mode: r.mode, iat: r.iat, exp: r.exp, revoked: r.revoked,
      })));
    }
    if (pathname === "/api/admin/shares/revoke" && req.method === "POST") {
      const body = await readJson(req);
      if (body?.all === true) return sendJson(res, 200, { revoked: auth.shares.revokeAll() });
      if (typeof body?.jti === "string" && auth.shares.revoke(body.jti)) return sendJson(res, 200, { revoked: 1 });
      return sendJson(res, 404, { error: "unknown link" });
    }

    if (req.method === "POST" && pathname.startsWith("/api/admin/libraries")) return handleLibraryAdmin(req, res, pathname);

    const ftpInfo = () => ({
      enabled: current.ftpServer.enabled, port: current.ftpServer.port, passivePorts: current.ftpServer.passivePorts,
      username: current.ftpServer.username, hasPassword: !!current.ftpServer.passwordHash, // the hash itself is never returned
      running: !!ftp?.running, error: ftpError ?? null, addresses: lanAddresses().map((ip) => `ftp://${ip}:${current.ftpServer.port}`),
    });
    if (pathname === "/api/admin/ftp-server" && req.method === "GET") return sendJson(res, 200, ftpInfo());
    if (pathname === "/api/admin/ftp-server" && req.method === "POST") {
      const b = await readJson(req);
      if (!b) return sendJson(res, 400, { error: "expected a JSON body" });
      const okPort = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 65535;
      const pp = b.passivePorts;
      if ((b.port !== undefined && !okPort(b.port)) || (pp !== undefined && !(Array.isArray(pp) && okPort(pp[0]) && okPort(pp[1]) && pp[0] <= pp[1]))) {
        return sendJson(res, 400, { error: "invalid port settings" });
      }
      if (b.username !== undefined && (typeof b.username !== "string" || !/^[\w.@-]{1,64}$/.test(b.username))) return sendJson(res, 400, { error: "invalid username" });
      if (b.password !== undefined && (typeof b.password !== "string" || b.password.length < 8)) return sendJson(res, 400, { error: "FTP password must be at least 8 characters" });
      return exclusive(async () => {
        const next = structuredClone(current);
        const f = next.ftpServer;
        if (typeof b.enabled === "boolean") f.enabled = b.enabled;
        if (okPort(b.port)) f.port = b.port;
        if (Array.isArray(pp)) f.passivePorts = [pp[0] as number, pp[1] as number];
        if (typeof b.username === "string") f.username = b.username;
        if (typeof b.password === "string") f.passwordHash = hashPassword(b.password);
        await applyConfig(next, true);
        sendJson(res, 200, ftpInfo());
      });
    }

    if (pathname === "/api/upload" && req.method === "POST") {
      const libId = url.searchParams.get("lib") ?? "";
      const destDir = url.searchParams.get("path") ?? "";
      const filename = url.searchParams.get("name") ?? "";

      const m = registry.get(libId);
      if (!m) return sendJson(res, 404, { error: "Unknown library" });
      if (m.lib.kind !== "local") return sendJson(res, 400, { error: "Upload only supported on local libraries" });
      if (!filename || /[\\/\0]/.test(filename)) return sendJson(res, 400, { error: "Invalid filename" });

      const root = path.resolve(m.lib.path);
      const targetDir = path.resolve(root, cleanRel(destDir));
      if (!targetDir.startsWith(root)) return sendJson(res, 403, { error: "Access denied" });

      const targetPath = path.join(targetDir, filename);

      try {
        await fs.promises.mkdir(targetDir, { recursive: true });
        const ws = fs.createWriteStream(targetPath);
        await new Promise<void>((resolve, reject) => {
          req.pipe(ws);
          ws.on("finish", resolve);
          ws.on("error", reject);
          req.on("error", reject);
        });

        scanSoon(m.lib.id);
        return sendJson(res, 200, { ok: true, name: filename });
      } catch (err: any) {
        return sendJson(res, 500, { error: err.message || "Failed to write file" });
      }
    }

    if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405, { Allow: "GET, HEAD" }).end();

    if (pathname === "/api/libraries") {
      const libs = await Promise.all(
        registry.list().map(async (m) => ({ id: m.lib.id, name: m.lib.name, kind: m.lib.kind, status: await withStatus(m) })),
      );
      return sendJson(res, 200, libs);
    }
    if (pathname === "/api/search") {
      const q = url.searchParams.get("q") ?? "";
      const which = url.searchParams.get("lib") ?? "all";
      const ids = which === "all" ? registry.list().map((m) => m.lib.id) : registry.get(which) ? [which] : [];
      const hits = index.search(q, ids).map((h) => ({ ...h, libName: registry.get(h.lib)?.lib.name ?? "", kind: registry.get(h.lib)?.lib.kind }));
      return sendJson(res, 200, { results: hits, indexing: ids.some((id) => index.isScanning(id)) });
    }
    if (pathname === "/api/admin/libraries" && req.method === "GET") {
      const rows = await Promise.all(
        registry.list().map(async (m) => {
          const info = index.info(m.lib.id);
          return {
            id: m.lib.id, name: m.lib.name, kind: m.lib.kind,
            // Remote libraries show host/share only: usernames and passwords never leave the server.
            path: m.lib.kind === "local" ? m.lib.path
              : m.lib.kind === "smb" ? `smb://${m.lib.host}/${m.lib.share}${m.lib.path ? "/" + m.lib.path.replace(/^[\\/]+/, "") : ""}`
              : `ftp://${m.lib.host}:${m.lib.port}${m.lib.basePath}`,
            status: await withStatus(m),
            fileCount: info?.count ?? null, truncated: info?.truncated ?? false, scanning: index.isScanning(m.lib.id),
          };
        }),
      );
      return sendJson(res, 200, rows);
    }
    if (pathname === "/api/admin/fs" && req.method === "GET") {
      const p = url.searchParams.get("path") ?? "";
      if (p === "") return sendJson(res, 200, { path: "", parent: null, dirs: await browseRoots() });
      try {
        return sendJson(res, 200, await listSubdirs(p));
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        return sendJson(res, code === "EINVAL" ? 400 : code === "ENOENT" ? 404 : 403, { error: code === "EINVAL" ? "path must be absolute" : "cannot open folder" });
      }
    }
    if (pathname === "/api/browse" || pathname === "/api/stream") {
      const m = registry.get(url.searchParams.get("lib") ?? "");
      if (!m) return sendJson(res, 404, { error: "unknown library" });
      const rel = url.searchParams.get("path") ?? "";
      if (pathname === "/api/browse") return sendJson(res, 200, { lib: m.lib.id, path: cleanRel(rel), entries: await m.source.list(rel) });
      return serveFile(req, res, m.source, rel);
    }

    // ── Server info (IPs, hostname, port, DB backend) ──────────────────
    if (pathname === "/api/server-info") {
      const p = (server.address() as AddressInfo | null)?.port ?? current.port;
      const ifaces = lanAddresses();
      return sendJson(res, 200, {
        hostname: (await import("node:os")).hostname(),
        port: p,
        lanAddresses: ifaces.map((ip) => ({ ip, url: `http://${ip}:${p}` })),
        onlineUrl: tunnelUrl ?? null,
        platform: process.platform,
        nodeVersion: process.version,
        db: (process.env.STREAMNEST_DB || "file"),
      });
    }

    return sendJson(res, 404, { error: "not found" });
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return void res.writeHead(400).end();
    }
    // Never log query strings or share tokens.
    console.log(`${req.method} ${pathname.startsWith("/s/") ? "/s/[token]" + (pathname.endsWith("/raw") ? "/raw" : "") : pathname}`);

    if (pathname.startsWith("/s/")) {
      if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405, { Allow: "GET, HEAD" }).end();
      return handleShare(req, res, url, pathname);
    }
    if (pathname.startsWith("/api/")) return handleApi(req, res, url, pathname);

    if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405, { Allow: "GET, HEAD" }).end();
    if (pathname === "/guide") return serveFile(req, res, docsSource, "GUIDE.html", { trusted: true });
    if (pathname === "/admin") return serveFile(req, res, publicSource, "admin.html", { trusted: true }); // page itself is public; its API calls need login
    return serveFile(req, res, publicSource, pathname === "/" ? "index.html" : pathname, { trusted: true });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => sendError(res, err));
  });
  return {
    server, registry, auth,
    setTunnelUrl: (url) => { tunnelUrl = url; },
    close: async () => {
      if (configFile) fs.unwatchFile(configFile);
      await ftpChain;
      await ftp?.running?.close().catch(() => {});
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await registry.close();
    },
  };
}

function isMain(): boolean {
  return !!process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename;
}

if (isMain()) {
  const config = loadConfig();
  const args = process.argv.slice(2);
  const online = args.includes("online") || args.includes("--online") || process.env.STREAMNEST_ONLINE === "1";
  if (online) {
    try {
      assertOnlineAllowed(config);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  }
  // Folders passed on the command line (npm start -- D:/Movies) are served for this run only.
  const extra: Library[] = [];
  for (const arg of args) {
    if (arg.startsWith("-") || arg === "online") continue;
    const abs = path.resolve(arg);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      extra.push({ id: newId(), name: path.basename(abs) || abs, kind: "local", path: abs });
    } else {
      console.warn(`Skipping "${arg}": folder not found`);
    }
  }
  const app = await createApp(config, extra, { configFile: configPath() });
  const port = Number(process.env.PORT) || config.port;
  const host = process.env.STREAMNEST_HOST ?? "0.0.0.0";
  app.server.listen(port, host, () => {
    const p = (app.server.address() as AddressInfo).port;
    console.log(`StreamNest running: http://localhost:${p}  (libraries: ${app.registry.list().length})`);
    if (host === "0.0.0.0") for (const ip of lanAddresses()) console.log(`  LAN: http://${ip}:${p}`);
    if (!app.auth.hasPassword()) {
      console.log("No admin password set: only this computer can use StreamNest. Run: npm run set-password");
    }
    if (app.registry.list().length === 0) {
      console.log('No libraries yet. Run: npm start -- "D:/Movies"  (or add them to config.json)');
    }
    if (online) {
      startTunnel({ port: p }).then(
        (t) => {
          app.setTunnelUrl(t.url);
          console.log(`ONLINE: ${t.url}  (anyone with a share link, or the admin password, can reach this server)`);
          const stop = (): void => { t.stop(); process.exit(0); };
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
          process.once("exit", () => t.stop());
        },
        (err: Error) => {
          console.error(`Online mode failed: ${err.message}`);
          process.exit(1);
        },
      );
    }
  });
}
