import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, mock, test } from "node:test";
import { RateLimiter, ShareStore } from "../src/auth.ts";
import { defaultConfig } from "../src/config.ts";
import { decrypt, deriveKey, encrypt, hashPassword, loadSecret, verifyPassword } from "../src/crypto.ts";
import { createApp, type App } from "../src/server.ts";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

describe("crypto", () => {
  test("secret.key is created once (32 bytes) and reused", () => {
    const d = tmp("sn-key-");
    const a = loadSecret(d);
    assert.equal(a.length, 32);
    assert.deepEqual(loadSecret(d), a);
    assert.equal(fs.statSync(path.join(d, "secret.key")).size, 32);
  });

  test("AES-256-GCM round-trips; wrong key and tampering fail", () => {
    const key = deriveKey(Buffer.alloc(32, 1), "creds");
    const blob = encrypt("hunter2-ftp", key);
    assert.ok(!blob.includes("hunter2"));
    assert.equal(decrypt(blob, key), "hunter2-ftp");
    assert.notEqual(encrypt("hunter2-ftp", key), blob); // random IV
    assert.throws(() => decrypt(blob, deriveKey(Buffer.alloc(32, 2), "creds")));
    const parts = blob.split(":");
    parts[3] = Buffer.from("xxxxxxxx").toString("base64url");
    assert.throws(() => decrypt(parts.join(":"), key));
  });

  test("password hashing verifies only the right password", () => {
    const h = hashPassword("correct horse");
    assert.ok(h.startsWith("scrypt$"));
    assert.ok(verifyPassword("correct horse", h));
    assert.ok(!verifyPassword("wrong", h));
    assert.ok(!verifyPassword("x", "garbage"));
  });
});

describe("rate limiter", () => {
  test("allows 5 per minute per key, then blocks until the window passes", () => {
    let t = 1000;
    const rl = new RateLimiter(5, 60_000, () => t);
    for (let i = 0; i < 5; i++) assert.equal(rl.hit("1.1.1.1"), 0);
    assert.ok(rl.hit("1.1.1.1") > 0);
    assert.equal(rl.hit("2.2.2.2"), 0); // other IPs unaffected
    t += 60_001;
    assert.equal(rl.hit("1.1.1.1"), 0);
  });
});

describe("signed share links", () => {
  const key = deriveKey(Buffer.alloc(32, 7), "share-hmac");
  const input = { lib: "l1", path: "a/b.mp4", kind: "file", mode: "stream", ttlMs: 3_600_000 } as const;

  test("valid link verifies and carries its payload", () => {
    const s = new ShareStore(path.join(tmp("sn-sh-"), "s.json"), key);
    const { token } = s.create(input);
    const p = s.verify(token);
    assert.equal(p?.lib, "l1");
    assert.equal(p?.path, "a/b.mp4");
    assert.equal(p?.mode, "stream");
  });

  test("expired links are rejected; never-expiring links are not", () => {
    let t = 1_000_000;
    const s = new ShareStore(path.join(tmp("sn-sh-"), "s.json"), key, () => t);
    const a = s.create(input).token;
    const forever = s.create({ ...input, ttlMs: 0 }).token;
    t += 3_600_001;
    assert.equal(s.verify(a), null);
    assert.ok(s.verify(forever));
  });

  test("tampered payload or signature is rejected", () => {
    const s = new ShareStore(path.join(tmp("sn-sh-"), "s.json"), key);
    const [body, sig] = s.create(input).token.split(".") as [string, string];
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as Record<string, unknown>;
    payload.path = "secret.mp4";
    const forgedBody = Buffer.from(JSON.stringify(payload)).toString("base64url");
    assert.equal(s.verify(`${forgedBody}.${sig}`), null);
    assert.equal(s.verify(`${body}.${sig.slice(0, -2)}AA`), null);
    assert.equal(s.verify(`${body}.`), null);
    assert.equal(s.verify("garbage"), null);
    // signed with a different key
    const other = new ShareStore(path.join(tmp("sn-sh-"), "s.json"), deriveKey(Buffer.alloc(32, 9), "share-hmac"));
    assert.equal(other.verify(s.create(input).token), null);
  });

  test("revoke one and revoke all; revocation survives restart", () => {
    const file = path.join(tmp("sn-sh-"), "s.json");
    const s = new ShareStore(file, key);
    const a = s.create(input);
    const b = s.create(input);
    const c = s.create(input);
    assert.ok(s.revoke(a.record.jti));
    assert.equal(s.verify(a.token), null);
    assert.ok(s.verify(b.token));
    assert.equal(s.revokeAll(), 2);
    assert.equal(s.verify(b.token), null);
    assert.equal(s.verify(c.token), null);
    const reloaded = new ShareStore(file, key);
    assert.equal(reloaded.verify(b.token), null);
  });
});

describe("HTTP auth and share links", () => {
  const PASSWORD = "s3cret-pass-word";
  let app: App;
  let base = "";
  let libDir = "";
  let now = Date.now();
  const logs: string[] = [];
  const data = Buffer.from(Array.from({ length: 500 }, (_, i) => i % 200));

  before(async () => {
    mock.method(console, "log", (...a: unknown[]) => void logs.push(a.join(" ")));
    libDir = tmp("sn-lib-");
    fs.mkdirSync(path.join(libDir, "Show"));
    fs.writeFileSync(path.join(libDir, "Show", "ep1.mp4"), data);
    fs.writeFileSync(path.join(libDir, "Show", "ep2.mp3"), data);
    app = await createApp(
      { ...defaultConfig(), admin: { passwordHash: hashPassword(PASSWORD) } },
      [{ id: "L", name: "Lib", kind: "local", path: libDir }],
      { dataDir: tmp("sn-data-"), now: () => now },
    );
    await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  after(async () => {
    mock.restoreAll();
    await app.close();
  });

  const post = (p: string, body: unknown, cookie?: string) =>
    fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });

  test("API requires login when a password is set (even from localhost)", async () => {
    assert.equal((await fetch(`${base}/api/libraries`)).status, 401);
    assert.equal((await fetch(`${base}/api/stream?lib=L&path=Show/ep1.mp4`)).status, 401);
    const s = (await (await fetch(`${base}/api/session`)).json()) as { authenticated: boolean };
    assert.equal(s.authenticated, false);
  });

  let cookie = "";
  test("wrong password 401; right password sets an httpOnly cookie; no password in the response", async () => {
    assert.equal((await post("/api/login", { password: "nope" })).status, 401);
    const ok = await post("/api/login", { password: PASSWORD });
    assert.equal(ok.status, 200);
    const setCookie = ok.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.ok(!(await ok.text()).includes(PASSWORD));
    cookie = setCookie.split(";")[0]!;
    assert.equal((await fetch(`${base}/api/libraries`, { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await fetch(`${base}/api/libraries?key=${PASSWORD}`)).status, 401); // ?key= is not an auth method
  });

  test("login requires a JSON body", async () => {
    const r = await fetch(base + "/api/login", { method: "POST", headers: { "Content-Type": "text/plain" }, body: PASSWORD });
    assert.equal(r.status, 401);
  });

  let fileLink = "";
  let fileJti = "";
  test("share link plays without login, supports Range, and /s/<token> shows a player", async () => {
    const r = await post("/api/share", { lib: "L", path: "Show/ep1.mp4", expiry: "1h" }, cookie);
    assert.equal(r.status, 200);
    const j = (await r.json()) as { path: string; raw: string; jti: string; kind: string };
    assert.equal(j.kind, "file");
    fileLink = j.path;
    fileJti = j.jti;
    const page = await fetch(base + j.path);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<video/);
    const raw = await fetch(base + j.raw, { headers: { Range: "bytes=10-19" } });
    assert.equal(raw.status, 206);
    assert.deepEqual(Buffer.from(await raw.arrayBuffer()), data.subarray(10, 20));
  });

  test("tampered link returns 403", async () => {
    const bad = fileLink.slice(0, -3) + (fileLink.endsWith("AAA") ? "BBB" : "AAA");
    assert.equal((await fetch(base + bad)).status, 403);
    assert.equal((await fetch(base + bad + "/raw")).status, 403);
    assert.equal((await fetch(`${base}/s/not-a-token`)).status, 403);
  });

  test("download-only link: no player, raw is an attachment", async () => {
    const j = (await (await post("/api/share", { lib: "L", path: "Show/ep1.mp4", mode: "download", expiry: "24h" }, cookie)).json()) as { path: string; raw: string };
    const html = await (await fetch(base + j.path)).text();
    assert.ok(!/<video|<audio/.test(html));
    assert.match(html, /download/i);
    const raw = await fetch(base + j.raw);
    assert.match(raw.headers.get("content-disposition") ?? "", /^attachment/);
    await raw.arrayBuffer();
  });

  test("folder link browses read-only, stays inside the folder", async () => {
    const j = (await (await post("/api/share", { lib: "L", path: "Show", expiry: "1h" }, cookie)).json()) as { path: string; kind: string };
    assert.equal(j.kind, "folder");
    const html = await (await fetch(base + j.path)).text();
    assert.match(html, /ep1\.mp4/);
    assert.match(html, /ep2\.mp3/);
    const esc = await fetch(`${base}${j.path}/raw?p=${encodeURIComponent("../Show/ep1.mp4")}`);
    assert.equal(esc.status, 400); // ".." is rejected by the shared path guard
    await esc.arrayBuffer();
    const ok = await fetch(`${base}${j.path}/raw?p=${encodeURIComponent("ep2.mp3")}`);
    assert.equal(ok.status, 200);
    await ok.arrayBuffer();
  });

  test("expired link returns 403", async () => {
    const j = (await (await post("/api/share", { lib: "L", path: "Show/ep1.mp4", expiry: "1h" }, cookie)).json()) as { path: string };
    assert.equal((await fetch(base + j.path)).status, 200);
    now += 3_600_001;
    assert.equal((await fetch(base + j.path)).status, 403);
  });

  test("revoke one link, then all", async () => {
    // fileLink has expired by now (clock advanced above), so make a fresh one
    const one = (await (await post("/api/share", { lib: "L", path: "Show/ep1.mp4", expiry: "1h" }, cookie)).json()) as { path: string; jti: string };
    assert.equal((await fetch(base + one.path)).status, 200);
    assert.equal((await post("/api/admin/shares/revoke", { jti: one.jti }, cookie)).status, 200);
    assert.equal((await fetch(base + one.path)).status, 403);
    assert.ok(fileJti);

    const j = (await (await post("/api/share", { lib: "L", path: "Show/ep2.mp3", expiry: "never" }, cookie)).json()) as { path: string };
    assert.equal((await fetch(base + j.path)).status, 200);
    assert.equal((await post("/api/admin/shares/revoke", { all: true }, cookie)).status, 200);
    assert.equal((await fetch(base + j.path)).status, 403);
    assert.equal((await post("/api/admin/shares/revoke", { all: true })).status, 401); // needs login
  });

  test("share creation rejects bad input and unknown files", async () => {
    assert.equal((await post("/api/share", { lib: "L", path: "x", expiry: "5y" }, cookie)).status, 400);
    assert.equal((await post("/api/share", { lib: "nope", path: "x" }, cookie)).status, 400);
    assert.equal((await post("/api/share", { lib: "L", path: "missing.mp4" }, cookie)).status, 404);
    assert.equal((await post("/api/share", { lib: "L", path: "../x" }, cookie)).status, 400);
  });

  test("logout invalidates the session", async () => {
    const c = (await post("/api/login", { password: PASSWORD })).headers.get("set-cookie")!.split(";")[0]!;
    assert.equal((await fetch(`${base}/api/libraries`, { headers: { Cookie: c } })).status, 200);
    await post("/api/logout", {}, c);
    assert.equal((await fetch(`${base}/api/libraries`, { headers: { Cookie: c } })).status, 401);
  });

  test("login is rate limited (6th attempt in a minute -> 429)", async () => {
    // earlier tests used some attempts; move the clock so the window is clean
    now += 61_000;
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await post("/api/login", { password: "bad" + i })).status);
    assert.deepEqual(codes, [401, 401, 401, 401, 401, 429]);
    assert.equal((await post("/api/login", { password: PASSWORD })).status, 429); // even the right one is blocked
  });

  test("no password or share token appears in any log line", () => {
    const all = logs.join("\n");
    assert.ok(!all.includes(PASSWORD));
    assert.ok(!all.includes("s3cret"));
    assert.ok(!/\/s\/[A-Za-z0-9_-]{20,}/.test(all));
  });
});

describe("no password configured", () => {
  let app: App;
  let base = "";
  before(async () => {
    app = await createApp(defaultConfig(), [], { dataDir: tmp("sn-data-") });
    await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  after(() => app.close());

  test("DNS rebinding: a request whose Host is not a loopback name is refused", async () => {
    const http = await import("node:http");
    const status = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const u = new URL(base);
        http.get({ host: u.hostname, port: u.port, path: "/api/libraries", headers: { Host: host } }, (r) => { r.resume(); resolve(r.statusCode ?? 0); }).on("error", reject);
      });
    assert.equal(await status(`localhost:${new URL(base).port}`), 200);
    assert.equal(await status(`127.0.0.1:${new URL(base).port}`), 200);
    assert.equal(await status("evil.example.com"), 401);
    assert.equal(await status(`evil.example.com:${new URL(base).port}`), 401);
    assert.equal(await status("127.0.0.1.evil.example.com"), 401);
  });

  test("direct localhost requests work; proxied (tunnel) requests are refused", async () => {
    assert.equal((await fetch(`${base}/api/libraries`)).status, 200);
    const proxied = await fetch(`${base}/api/libraries`, { headers: { "X-Forwarded-For": "8.8.8.8" } });
    assert.equal(proxied.status, 401);
    const j = (await proxied.json()) as { setupRequired: boolean };
    assert.equal(j.setupRequired, true);
    assert.equal((await fetch(`${base}/api/libraries`, { headers: { "CF-Connecting-IP": "8.8.8.8" } })).status, 401);
  });
});
