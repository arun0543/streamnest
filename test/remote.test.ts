import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { Client as FtpClient } from "basic-ftp";
import { after, before, mock, test } from "node:test";
import { defaultConfig, loadConfig, saveConfig, validateConfig } from "../src/config.ts";
import { createApp, type App } from "../src/server.ts";
import { freePort, freePortRange, startPlainFtpServer, tmpDir } from "./helpers.ts";
import { Writable } from "node:stream";

const FTP_PASS = "ftp-secret-pw";
let work = "";
let configFile = "";
let ftpRoot = "";
let remote: Awaited<ReturnType<typeof startPlainFtpServer>>;
let ftpPort = 0;
let localDir = "";
let app: App;
let base = "";
const bigFile = crypto.randomBytes(120_000);
const logs: string[] = [];

const post = (p: string, body: unknown) =>
  fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const get = <T,>(p: string): Promise<T> => fetch(base + p).then((r) => r.json() as Promise<T>);

before(async () => {
  mock.method(console, "log", (...a: unknown[]) => void logs.push(a.join(" ")));
  work = tmpDir("sn-remote-");
  ftpRoot = path.join(work, "ftproot");
  fs.mkdirSync(path.join(ftpRoot, "Shows"), { recursive: true });
  fs.writeFileSync(path.join(ftpRoot, "Shows", "ep1.mp4"), bigFile);
  localDir = path.join(work, "local");
  fs.mkdirSync(path.join(localDir, "Sub"), { recursive: true });
  fs.writeFileSync(path.join(localDir, "Sub", "tune.mp3"), bigFile);
  ftpPort = await freePort();
  remote = await startPlainFtpServer(ftpRoot, ftpPort, "ftpuser", FTP_PASS);
  configFile = path.join(work, "config.json");
  saveConfig(defaultConfig(), configFile);
  app = await createApp(loadConfig(configFile), [], { dataDir: path.join(work, "data"), configFile, watchIntervalMs: 100 });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
after(async () => {
  mock.restoreAll();
  await app.close();
  await remote.close();
  fs.rmSync(work, { recursive: true, force: true });
});

const ftpForm = (over: Record<string, unknown> = {}) => ({ kind: "ftp", name: "Seedbox", host: "127.0.0.1", port: ftpPort, username: "ftpuser", password: FTP_PASS, basePath: "/", ...over });

test("config validation accepts smb/ftp libraries and rejects bad ones", () => {
  const ok = validateConfig({ libraries: [
    { id: "a", name: "A", kind: "ftp", host: "h", username: "u", passwordEnc: "v1:x:y:z" },
    { id: "b", name: "B", kind: "smb", host: "h", share: "s", username: "u", passwordEnc: "" },
  ] });
  assert.deepEqual(ok.libraries.map((l) => l.kind), ["ftp", "smb"]);
  assert.equal(ok.libraries[0]?.kind === "ftp" && ok.libraries[0].port, 21);
  assert.equal(ok.ftpServer.enabled, false);
  assert.throws(() => validateConfig({ libraries: [{ id: "a", name: "A", kind: "ftp", host: "h", secure: "weird" }] }), /secure/);
  assert.throws(() => validateConfig({ libraries: [{ id: "a", name: "A", kind: "smb", host: "h" }] }), /share/);
  assert.throws(() => validateConfig({ ftpServer: { passivePorts: [9, 1] } }), /passivePorts/);
});

test("test-remote: wrong password and unreachable host give clear errors, nothing is saved", async () => {
  const bad = (await (await post("/api/admin/libraries/test-remote", ftpForm({ password: "nope" }))).json()) as { ok: boolean; error: string };
  assert.equal(bad.ok, false);
  assert.match(bad.error, /wrong username or password/i);
  const refused = (await (await post("/api/admin/libraries/test-remote", ftpForm({ port: await freePort() }))).json()) as { error: string };
  assert.match(refused.error, /refused/i);
  const good = (await (await post("/api/admin/libraries/test-remote", ftpForm())).json()) as { ok: boolean };
  assert.equal(good.ok, true);
  assert.equal((await get<unknown[]>("/api/libraries")).length, 0);
  assert.equal((await post("/api/admin/libraries/test-remote", { kind: "ftp", host: "bad host/x" })).status, 400);
});

test("add an FTP library: password is encrypted at rest and never returned; list + ranged stream work over HTTP", async () => {
  const bad = await post("/api/admin/libraries/add-remote", ftpForm({ password: "wrong" }));
  assert.equal(bad.status, 400);
  const r = await post("/api/admin/libraries/add-remote", ftpForm());
  assert.equal(r.status, 200);
  const body = await r.text();
  assert.ok(!body.includes(FTP_PASS));

  const saved = fs.readFileSync(configFile, "utf8");
  assert.ok(!saved.includes(FTP_PASS), "password must not be stored in clear text");
  assert.match(saved, /"passwordEnc": "v1:/);

  const libs = await get<{ id: string; name: string; kind: string; status: string }[]>("/api/libraries");
  assert.deepEqual(libs.map((l) => [l.name, l.kind, l.status]), [["Seedbox", "ftp", "online"]]);
  const admin = JSON.stringify(await get("/api/admin/libraries"));
  assert.ok(!admin.includes(FTP_PASS) && !admin.includes("passwordEnc") && !admin.includes("ftpuser"));
  assert.match(admin, /ftp:\/\/127\.0\.0\.1:/);

  const id = libs[0]!.id;
  const listing = await get<{ entries: { name: string }[] }>(`/api/browse?lib=${id}&path=Shows`);
  assert.deepEqual(listing.entries.map((e) => e.name), ["ep1.mp4"]);
  const ranged = await fetch(`${base}/api/stream?lib=${id}&path=Shows/ep1.mp4`, { headers: { Range: "bytes=50000-50999" } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get("content-range"), `bytes 50000-50999/${bigFile.length}`);
  assert.ok(Buffer.from(await ranged.arrayBuffer()).equals(bigFile.subarray(50_000, 51_000)));
});

test("remote libraries appear in All-libraries search after indexing", async () => {
  const deadline = Date.now() + 8000;
  let hits = 0;
  while (Date.now() < deadline && hits === 0) {
    hits = (await get<{ results: unknown[] }>("/api/search?lib=all&q=ep1")).results.length;
    if (!hits) await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(hits, 1);
});

test("built-in FTP server: disabled by default; enabling needs a password; serves libraries read-only", async () => {
  const info = await get<{ enabled: boolean; running: boolean; hasPassword: boolean }>("/api/admin/ftp-server");
  assert.deepEqual([info.enabled, info.running, info.hasPassword], [false, false, false]);
  assert.equal((await post("/api/admin/ftp-server", { password: "short" })).status, 400);

  // enabling without a password is refused (server stays off, error reported)
  const noPw = (await (await post("/api/admin/ftp-server", { enabled: true, port: await freePort() })).json()) as { running: boolean; error: string };
  assert.equal(noPw.running, false);
  assert.match(noPw.error, /password/i);

  await post("/api/admin/libraries", { paths: [localDir], name: "Local Music" });
  const port = await freePort();
  const pasv = await freePortRange(41);
  const on = (await (await post("/api/admin/ftp-server", { enabled: true, port, passivePorts: [pasv, pasv + 40], username: "viewer", password: "viewer-password" })).json()) as { running: boolean; hasPassword: boolean };
  assert.deepEqual([on.running, on.hasPassword], [true, true]);
  assert.ok(!JSON.stringify(on).includes("viewer-password"));
  assert.ok(!fs.readFileSync(configFile, "utf8").includes("viewer-password"));

  const wrong = new FtpClient(5000);
  await assert.rejects(wrong.access({ host: "127.0.0.1", port, user: "viewer", password: "bad-password" }), /530|Invalid/);
  wrong.close();

  const c = new FtpClient(5000);
  try {
    await c.access({ host: "127.0.0.1", port, user: "viewer", password: "viewer-password" });
    const roots = (await c.list("/")).map((f) => f.name).sort();
    assert.deepEqual(roots, ["Local Music", "Seedbox"]);
    assert.deepEqual((await c.list("/Local Music/Sub")).map((f) => f.name), ["tune.mp3"]);

    const sink = (chunks: Buffer[]) => new Writable({ write(ch, _e, cb) { chunks.push(ch as Buffer); cb(); } });
    const whole: Buffer[] = [];
    await c.downloadTo(sink(whole), "/Local Music/Sub/tune.mp3");
    assert.ok(Buffer.concat(whole).equals(bigFile));
    const tail: Buffer[] = [];
    await c.downloadTo(sink(tail), "/Seedbox/Shows/ep1.mp4", 100_000); // REST seek through the FTP server
    assert.ok(Buffer.concat(tail).equals(bigFile.subarray(100_000)));

    // every write is rejected and nothing changes on disk
    const { Readable } = await import("node:stream");
    await assert.rejects(c.uploadFrom(Readable.from([Buffer.from("x")]), "/Local Music/new.txt"));
    await assert.rejects(c.remove("/Local Music/Sub/tune.mp3"));
    await assert.rejects(c.ensureDir("/Local Music/newdir"));
    await assert.rejects(c.rename("/Local Music/Sub/tune.mp3", "/Local Music/Sub/other.mp3"));
    await assert.rejects(c.removeDir("/Local Music/Sub"));
  } finally {
    c.close();
  }
  assert.deepEqual(fs.readdirSync(localDir), ["Sub"]);
  assert.deepEqual(fs.readdirSync(path.join(localDir, "Sub")), ["tune.mp3"]);

  const off = (await (await post("/api/admin/ftp-server", { enabled: false })).json()) as { running: boolean };
  assert.equal(off.running, false);
  const gone = new FtpClient(2000);
  await assert.rejects(gone.access({ host: "127.0.0.1", port, user: "viewer", password: "viewer-password" }));
  gone.close();
});

test("no stored or typed password appears in any log line", () => {
  const all = logs.join("\n");
  assert.ok(!all.includes(FTP_PASS) && !all.includes("viewer-password"));
});


