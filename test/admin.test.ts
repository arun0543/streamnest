import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { defaultConfig, loadConfig, saveConfig } from "../src/config.ts";
import { LibraryIndex } from "../src/indexer.ts";
import { LocalSource } from "../src/sources/local.ts";
import { createApp, type App } from "../src/server.ts";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(50);
  }
  throw new Error("timed out waiting for condition");
}

let app: App;
let base = "";
let work = "";
let configFile = "";
let movies = "";
let music = "";

const post = (p: string, body: unknown) =>
  fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const get = async <T,>(p: string): Promise<T> => (await fetch(base + p)).json() as Promise<T>;

before(async () => {
  work = tmp("sn-admin-");
  movies = path.join(work, "Movies");
  music = path.join(work, "Music");
  fs.mkdirSync(path.join(movies, "Action"), { recursive: true });
  fs.mkdirSync(music);
  fs.writeFileSync(path.join(movies, "Action", "Big Explosion.mp4"), "x");
  fs.writeFileSync(path.join(movies, "Quiet.mkv"), "x");
  fs.writeFileSync(path.join(music, "explosion of sound.mp3"), "x");
  fs.writeFileSync(path.join(music, "song.mp3"), "x");
  configFile = path.join(work, "config.json");
  saveConfig(defaultConfig(), configFile);
  app = await createApp(loadConfig(configFile), [], { dataDir: tmp("sn-data-"), configFile, watchIntervalMs: 100 });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
after(async () => {
  await app.close();
  fs.rmSync(work, { recursive: true, force: true });
});

test("folder picker: roots, sub-folders, parent, bad paths", async () => {
  const roots = await get<{ dirs: { name: string; path: string }[] }>("/api/admin/fs");
  assert.ok(roots.dirs.length > 0);
  if (process.platform === "win32") assert.ok(roots.dirs.every((d) => /^[A-Z]:$/.test(d.name)));
  const listing = await get<{ path: string; parent: string | null; dirs: { name: string }[] }>(`/api/admin/fs?path=${encodeURIComponent(work)}`);
  assert.deepEqual(listing.dirs.map((d) => d.name), ["Movies", "Music"]);
  assert.equal(listing.parent, path.dirname(work));
  assert.equal((await fetch(`${base}/api/admin/fs?path=relative`)).status, 400);
  assert.equal((await fetch(`${base}/api/admin/fs?path=${encodeURIComponent(path.join(work, "nope"))}`)).status, 404);
});

test("adding several folders at once applies without a restart", async () => {
  const r = await post("/api/admin/libraries", { paths: [movies, music, path.join(work, "Missing"), movies] });
  const body = (await r.json()) as { added: { name: string }[]; skipped: { reason: string }[] };
  assert.deepEqual(body.added.map((l) => l.name), ["Movies", "Music"]);
  assert.deepEqual(body.skipped.map((s) => s.reason), ["does not exist", "already added"]);
  const libs = await get<{ id: string; name: string }[]>("/api/libraries");
  assert.deepEqual(libs.map((l) => l.name), ["Movies", "Music"]);
  assert.deepEqual(loadConfig(configFile).libraries.map((l) => l.name), ["Movies", "Music"]); // persisted
  const browse = await get<{ entries: { name: string }[] }>(`/api/browse?lib=${libs[0]!.id}&path=`);
  assert.deepEqual(browse.entries.map((e) => e.name), ["Action", "Quiet.mkv"]);
});

test("admin list shows status and file count after the background scan", async () => {
  await until(async () => {
    const rows = await get<{ fileCount: number | null }[]>("/api/admin/libraries");
    return rows.length === 2 && rows.every((r) => r.fileCount !== null);
  });
  const rows = await get<{ name: string; kind: string; status: string; fileCount: number; path: string }[]>("/api/admin/libraries");
  assert.deepEqual(rows.map((r) => [r.name, r.kind, r.status, r.fileCount]), [["Movies", "local", "online", 2], ["Music", "local", "online", 2]]);
});

test("All-libraries search spans sources; name matches rank first", async () => {
  const r = await get<{ results: { name: string; libName: string; type: string }[] }>("/api/search?lib=all&q=explosion");
  assert.deepEqual(r.results.map((h) => [h.libName, h.name]), [["Movies", "Big Explosion.mp4"], ["Music", "explosion of sound.mp3"]]);
  const folder = await get<{ results: { name: string }[] }>("/api/search?lib=all&q=action");
  assert.deepEqual(folder.results.map((h) => h.name), ["Action", "Big Explosion.mp4"]); // path match includes files inside
  assert.deepEqual((await get<{ results: unknown[] }>("/api/search?lib=all&q=")).results, []);
  assert.deepEqual((await get<{ results: unknown[] }>("/api/search?lib=all&q=zzzz")).results, []);
});

test("rename and rescan", async () => {
  const [movie] = await get<{ id: string }[]>("/api/libraries");
  assert.equal((await post("/api/admin/libraries/rename", { id: movie!.id, name: "Films" })).status, 200);
  assert.equal((await get<{ name: string }[]>("/api/libraries"))[0]?.name, "Films");
  fs.writeFileSync(path.join(movies, "New.mp4"), "x");
  const scan = (await (await post("/api/admin/libraries/rescan", { id: movie!.id })).json()) as { fileCount: number };
  assert.equal(scan.fileCount, 3);
  const t = (await (await post("/api/admin/libraries/test", { id: movie!.id })).json()) as { ok: boolean };
  assert.equal(t.ok, true);
});

test("hot reload: the CLI/hand-edit of config.json updates a running server", async () => {
  const cfg = loadConfig(configFile);
  const extra = tmp("sn-extra-");
  fs.writeFileSync(path.join(extra, "z.mp3"), "x");
  cfg.libraries.push({ id: "cli1", name: "FromCli", kind: "local", path: extra });
  saveConfig(cfg, configFile);
  await until(async () => (await get<{ id: string }[]>("/api/libraries")).some((l) => l.id === "cli1"));
  await until(async () => ((await get<{ results: unknown[] }>("/api/search?lib=all&q=z.mp3")).results.length === 1));

  cfg.libraries = cfg.libraries.filter((l) => l.id !== "cli1");
  saveConfig(cfg, configFile);
  await until(async () => !(await get<{ id: string }[]>("/api/libraries")).some((l) => l.id === "cli1"));
  assert.deepEqual((await get<{ results: unknown[] }>("/api/search?lib=all&q=z.mp3")).results, []);
  fs.rmSync(extra, { recursive: true, force: true });
});

test("a broken config.json is ignored and the server keeps its libraries", async () => {
  fs.writeFileSync(configFile, "{ not json");
  await sleep(400);
  assert.equal((await get<unknown[]>("/api/libraries")).length, 2);
  saveConfig(app.registry.list().length ? { ...defaultConfig(), libraries: app.registry.list().map((m) => m.lib) } : defaultConfig(), configFile);
});

test("remove drops the library from the player and the index", async () => {
  const libs = await get<{ id: string; name: string }[]>("/api/libraries");
  const r = (await (await post("/api/admin/libraries/remove", { ids: [libs[1]!.id, "bogus"] })).json()) as { removed: { name: string }[] };
  assert.deepEqual(r.removed.map((x) => x.name), ["Music"]);
  assert.equal((await get<unknown[]>("/api/libraries")).length, 1);
  assert.deepEqual((await get<{ results: unknown[] }>("/api/search?lib=all&q=song")).results, []);
  assert.equal(fs.existsSync(path.join(music, "song.mp3")), true); // files are never touched
});

test("admin endpoints need a JSON body and /admin page is served", async () => {
  const r = await fetch(`${base}/api/admin/libraries`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" });
  assert.equal(r.status, 400);
  const page = await fetch(`${base}/admin`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /StreamNest Admin/);
});

test("LibraryIndex: caps entries and flags truncation", async () => {
  const idx = new LibraryIndex();
  const info = await idx.scan("t", new LocalSource(work), { maxEntries: 2 });
  assert.equal(info.truncated, true);
});
