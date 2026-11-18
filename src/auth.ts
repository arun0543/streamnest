import crypto from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { deriveKey, verifyPassword } from "./crypto.ts";

type Clock = () => number;

/** Sliding-window limiter: at most `max` attempts per `windowMs` per key. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max = 5, private windowMs = 60_000, private now: Clock = Date.now) {}

  /** Records an attempt. Returns 0 if allowed, otherwise seconds until the next attempt is allowed. */
  hit(key: string): number {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return Math.ceil((recent[0]! + this.windowMs - t) / 1000);
    }
    recent.push(t);
    this.hits.set(key, recent);
    return 0;
  }
}

export type ShareMode = "stream" | "download";
export type ShareKind = "file" | "folder";

export interface SharePayload {
  v: 1;
  jti: string;
  lib: string;
  path: string;
  kind: ShareKind;
  mode: ShareMode;
  iat: number;
  /** Expiry in epoch ms; 0 = never. */
  exp: number;
}

export interface ShareRecord extends SharePayload {
  revoked: boolean;
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/**
 * Signed share links. Token = base64url(payload JSON) "." base64url(HMAC-SHA256).
 * A link is valid only if the signature matches, it has not expired, and its record
 * in data/shares.json exists and is not revoked (revoking one or all works instantly).
 */
export class ShareStore {
  private records = new Map<string, ShareRecord>();

  constructor(private file: string, private key: Buffer, private now: Clock = Date.now) {
    for (const r of readJson<ShareRecord[]>(file, [])) this.records.set(r.jti, r);
  }

  private sign(body: string): string {
    return crypto.createHmac("sha256", this.key).update(body).digest("base64url");
  }

  private persist(): void {
    const t = this.now();
    for (const [id, r] of this.records) if (r.exp !== 0 && r.exp < t - 86_400_000) this.records.delete(id); // prune long-expired
    writeJson(this.file, [...this.records.values()]);
  }

  create(input: { lib: string; path: string; kind: ShareKind; mode: ShareMode; ttlMs: number }): { token: string; record: ShareRecord } {
    const iat = this.now();
    const payload: SharePayload = {
      v: 1, jti: crypto.randomBytes(9).toString("base64url"), lib: input.lib, path: input.path,
      kind: input.kind, mode: input.mode, iat, exp: input.ttlMs === 0 ? 0 : iat + input.ttlMs,
    };
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    this.records.set(payload.jti, { ...payload, revoked: false });
    this.persist();
    return { token: `${body}.${this.sign(body)}`, record: { ...payload, revoked: false } };
  }

  /** Returns the payload for a valid token, otherwise null (tampered, expired, revoked or unknown). */
  verify(token: string): SharePayload | null {
    const [body, sig, extra] = token.split(".");
    if (!body || !sig || extra !== undefined) return null;
    const expected = Buffer.from(this.sign(body));
    const actual = Buffer.from(sig);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
    let p: SharePayload;
    try {
      p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SharePayload;
    } catch {
      return null;
    }
    if (p.v !== 1 || typeof p.jti !== "string" || typeof p.lib !== "string" || typeof p.path !== "string") return null;
    if (p.exp !== 0 && this.now() >= p.exp) return null;
    const rec = this.records.get(p.jti);
    if (!rec || rec.revoked) return null;
    return p;
  }

  list(): ShareRecord[] {
    return [...this.records.values()].sort((a, b) => b.iat - a.iat);
  }

  revoke(jti: string): boolean {
    const r = this.records.get(jti);
    if (!r) return false;
    r.revoked = true;
    this.persist();
    return true;
  }

  revokeAll(): number {
    let n = 0;
    for (const r of this.records.values()) if (!r.revoked) { r.revoked = true; n++; }
    this.persist();
    return n;
  }
}

const SESSION_TTL_MS = 7 * 86_400_000;
export const SESSION_COOKIE = "sn_session";

export interface AuthOptions {
  dataDir: string;
  secret: Buffer;
  passwordHash?: string | undefined;
  now?: Clock;
}

export class Auth {
  readonly shares: ShareStore;
  readonly limiter: RateLimiter;
  private sessions: Map<string, number>; // sha256(token) -> expiry
  private sessionFile: string;
  private now: Clock;

  constructor(private opts: AuthOptions) {
    this.now = opts.now ?? Date.now;
    this.shares = new ShareStore(path.join(opts.dataDir, "shares.json"), deriveKey(opts.secret, "share-hmac"), this.now);
    this.limiter = new RateLimiter(5, 60_000, this.now);
    this.sessionFile = path.join(opts.dataDir, "sessions.json");
    this.sessions = new Map(Object.entries(readJson<Record<string, number>>(this.sessionFile, {})));
  }

  /** Called on config hot-reload so `set-password` applies without a restart. */
  setPasswordHash(hash: string | undefined): void {
    this.opts.passwordHash = hash;
  }

  hasPassword(): boolean {
    return !!this.opts.passwordHash;
  }

  checkPassword(password: string): boolean {
    return !!this.opts.passwordHash && verifyPassword(password, this.opts.passwordHash);
  }

  private hash(token: string): string {
    return crypto.createHash("sha256").update(token).digest("base64url");
  }

  createSession(): string {
    const token = crypto.randomBytes(32).toString("base64url");
    const t = this.now();
    for (const [h, exp] of this.sessions) if (exp <= t) this.sessions.delete(h);
    this.sessions.set(this.hash(token), t + SESSION_TTL_MS);
    writeJson(this.sessionFile, Object.fromEntries(this.sessions));
    return token;
  }

  validSession(token: string | undefined): boolean {
    if (!token) return false;
    const exp = this.sessions.get(this.hash(token));
    return exp !== undefined && exp > this.now();
  }

  destroySession(token: string | undefined): void {
    if (token && this.sessions.delete(this.hash(token))) writeJson(this.sessionFile, Object.fromEntries(this.sessions));
  }

  sessionCookie(token: string, secure: boolean): string {
    return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure ? "; Secure" : ""}`;
  }

  clearCookie(): string {
    return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-host", "forwarded", "cf-connecting-ip", "cf-ray"];

/** True only for a direct connection from this machine (not a tunnel / reverse proxy on localhost). */
export function isLocalRequest(req: IncomingMessage): boolean {
  const ip = req.socket.remoteAddress ?? "";
  const loopback = ip === "127.0.0.1" || ip === "::1" || ip.startsWith("::ffff:127.");
  if (!loopback || PROXY_HEADERS.some((h) => req.headers[h] !== undefined)) return false;
  // DNS rebinding: a web page can point evil.example at 127.0.0.1 and talk to us from the victim's browser.
  // Such requests carry the attacker's host name, so only accept loopback host names.
  const host = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

/** Client key for rate limiting; trusts the first X-Forwarded-For hop only when the peer is loopback (tunnel). */
export function clientKey(req: IncomingMessage): string {
  const ip = req.socket.remoteAddress ?? "unknown";
  const loopback = ip === "127.0.0.1" || ip === "::1" || ip.startsWith("::ffff:127.");
  const fwd = req.headers["cf-connecting-ip"] ?? req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return loopback && first ? first : ip;
}
