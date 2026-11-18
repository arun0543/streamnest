import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import { defaultConfig } from "../src/config.ts";
import { createApp, type App } from "../src/server.ts";
import { parseRange } from "../src/stream.ts";

test("parseRange: explicit, open-ended and suffix ranges", () => {
  assert.deepEqual(parseRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=500-", 1000), { start: 500, end: 999 });
  assert.deepEqual(parseRange("bytes=-100", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange("bytes=900-5000", 1000), { start: 900, end: 999 }); // end clamped
  assert.deepEqual(parseRange("bytes=-5000", 1000), { start: 0, end: 999 });
});

test("parseRange: unsatisfiable", () => {
  assert.equal(parseRange("bytes=1000-", 1000), "unsatisfiable");
  assert.equal(parseRange("bytes=-0", 1000), "unsatisfiable");
  assert.equal(parseRange("bytes=0-1", 0), "unsatisfiable");
});

test("parseRange: ignored headers serve the whole file", () => {
  assert.equal(parseRange(undefined, 10), null);
  assert.equal(parseRange("items=0-1", 10), null);
  assert.equal(parseRange("bytes=0-1,5-6", 10), null);
  assert.equal(parseRange("bytes=5-2", 10), null);
  assert.equal(parseRange("bytes=-", 10), null);
});

let dir = "";
let app: App;
let base = "";
let libId = "";
const data = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "streamnest-"));
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "sub", "clip.mp4"), data);
  fs.writeFileSync(path.join(dir, "empty.mp3"), "");
  app = await createApp(defaultConfig(), [{ id: "t1", name: "Test", kind: "local", path: dir }], {
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "streamnest-data-")),
  });
  libId = "t1";
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

after(async () => {
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const url = (p: string) => `${base}/api/stream?lib=${libId}&path=${encodeURIComponent(p)}`;

test("http: full file returns 200 with Accept-Ranges", async () => {
  const r = await fetch(url("sub/clip.mp4"));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("accept-ranges"), "bytes");
  assert.equal(r.headers.get("content-type"), "video/mp4");
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), data);
});

test("http: Range bytes=100-199 returns 206 with exact bytes", async () => {
  const r = await fetch(url("sub/clip.mp4"), { headers: { Range: "bytes=100-199" } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("content-range"), "bytes 100-199/1000");
  assert.equal(r.headers.get("content-length"), "100");
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), data.subarray(100, 200));
});

test("http: out-of-range returns 416", async () => {
  const r = await fetch(url("sub/clip.mp4"), { headers: { Range: "bytes=5000-" } });
  assert.equal(r.status, 416);
  assert.equal(r.headers.get("content-range"), "bytes */1000");
  await r.arrayBuffer();
});

test("http: HEAD has headers and no body; empty file works", async () => {
  const h = await fetch(url("sub/clip.mp4"), { method: "HEAD" });
  assert.equal(h.status, 200);
  assert.equal(h.headers.get("content-length"), "1000");
  const e = await fetch(url("empty.mp3"));
  assert.equal(e.status, 200);
  assert.equal((await e.arrayBuffer()).byteLength, 0);
});

test("http: traversal is rejected and browse lists entries", async () => {
  const bad = await fetch(url("../secret.txt"));
  assert.equal(bad.status, 400);
  const staticBad = await fetch(`${base}/..%2Fpackage.json`);
  assert.notEqual(staticBad.status, 200);
  const r = await fetch(`${base}/api/browse?lib=${libId}&path=`);
  const body = (await r.json()) as { entries: { name: string; type: string }[] };
  assert.deepEqual(body.entries.map((e) => [e.name, e.type]), [["sub", "dir"], ["empty.mp3", "file"]]);
  const missing = await fetch(url("nope.mp4"));
  assert.equal(missing.status, 404);
});

test("http: web files inside a library are never served as runnable pages", async () => {
  fs.writeFileSync(path.join(dir, "evil.html"), "<script>alert(1)</script>");
  fs.writeFileSync(path.join(dir, "evil.svg"), "<svg onload=alert(1)/>");
  for (const f of ["evil.html", "evil.svg"]) {
    const r = await fetch(url(f));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "application/octet-stream");
    assert.match(r.headers.get("content-disposition") ?? "", /^attachment/);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    await r.arrayBuffer();
  }
  const media = await fetch(url("sub/clip.mp4"));
  assert.equal(media.headers.get("content-type"), "video/mp4");
  assert.equal(media.headers.get("content-disposition"), null);
  await media.arrayBuffer();
  // the app's own pages are still HTML
  assert.match((await fetch(`${base}/`)).headers.get("content-type") ?? "", /text\/html/);
});

test("http: POST is rejected and the UI is served", async () => {
  assert.equal((await fetch(`${base}/api/libraries`, { method: "POST" })).status, 405);
  const ui = await fetch(`${base}/`);
  assert.equal(ui.status, 200);
  assert.match(await ui.text(), /StreamNest/);
});
