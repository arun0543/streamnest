import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { FtpSource } from "../src/sources/ftp.ts";
import { SafePathError } from "../src/sources/safe.ts";
import { collect, freePort, startPlainFtpServer, tmpDir } from "./helpers.ts";

let root = "";
let port = 0;
let srv: Awaited<ReturnType<typeof startPlainFtpServer>>;
let src: FtpSource;
const data = crypto.randomBytes(300_000);

const opts = (over: Partial<ConstructorParameters<typeof FtpSource>[0]> = {}) => ({
  host: "127.0.0.1", port, secure: "none" as const, username: "u", password: "p", basePath: "/", maxConnections: 2, timeoutMs: 5000, ...over,
});

before(async () => {
  root = tmpDir("sn-ftp-");
  fs.mkdirSync(path.join(root, "Movies", "Action"), { recursive: true });
  fs.writeFileSync(path.join(root, "Movies", "film.mkv"), data);
  fs.writeFileSync(path.join(root, "Movies", "Action", "a.mp4"), "hello");
  fs.writeFileSync(path.join(root, "top.mp3"), "abc");
  port = await freePort();
  srv = await startPlainFtpServer(root, port);
  src = new FtpSource(opts());
});
after(async () => {
  await src.close();
  await srv.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("list: folders first, POSIX entry paths", async () => {
  assert.deepEqual((await src.list("")).map((e) => `${e.type}:${e.name}`), ["dir:Movies", "file:top.mp3"]);
  const sub = await src.list("Movies");
  assert.deepEqual(sub.map((e) => [e.type, e.path, e.size]), [["dir", "Movies/Action", undefined], ["file", "Movies/film.mkv", data.length]]);
});

test("stat: file, directory and missing", async () => {
  const f = await src.stat("Movies/film.mkv");
  assert.deepEqual([f.isFile, f.size], [true, data.length]);
  assert.equal((await src.stat("Movies")).isFile, false);
  await assert.rejects(src.stat("Movies/nope.mkv"), { code: "ENOENT" });
  await assert.rejects(src.list("nope"), { code: "ENOENT" });
});

test("ranged read: bytes from the middle are exact (REST seek), then another range reuses the pool", async () => {
  const a = await collect(await src.read("Movies/film.mkv", { start: 100_000, end: 100_999 }));
  assert.equal(a.length, 1000);
  assert.ok(a.equals(data.subarray(100_000, 101_000)));
  const b = await collect(await src.read("Movies/film.mkv", { start: 250_000, end: 250_099 }));
  assert.ok(b.equals(data.subarray(250_000, 250_100)));
  const c = await collect(await src.read("Movies/film.mkv", { start: 0, end: 9 }));
  assert.ok(c.equals(data.subarray(0, 10)));
});

test("read to the end of file and full read", async () => {
  const tail = await collect(await src.read("Movies/film.mkv", { start: 299_000, end: data.length - 1 }));
  assert.ok(tail.equals(data.subarray(299_000)));
  const full = await collect(await src.read("Movies/film.mkv"));
  assert.ok(full.equals(data));
});

test("two simultaneous reads (pool of 2) and a third queued", async () => {
  const reads = [0, 50_000, 120_000].map((s) => src.read("Movies/film.mkv", { start: s, end: s + 4999 }).then(collect));
  const out = await Promise.all(reads);
  out.forEach((buf, i) => assert.ok(buf.equals(data.subarray([0, 50_000, 120_000][i]!, [0, 50_000, 120_000][i]! + 5000))));
});

test("a client that disconnects mid-stream does not break later reads", async () => {
  const s = (await src.read("Movies/film.mkv")) as NodeJS.ReadableStream & { destroy(): void };
  await new Promise<void>((r) => s.once("data", () => r()));
  s.destroy();
  const again = await collect(await src.read("Movies/film.mkv", { start: 10, end: 19 }));
  assert.ok(again.equals(data.subarray(10, 20)));
});

test("base path scopes the source and '..' cannot escape it", async () => {
  const scoped = new FtpSource(opts({ basePath: "/Movies" }));
  assert.deepEqual((await scoped.list("")).map((e) => e.name), ["Action", "film.mkv"]);
  await assert.rejects(scoped.list("../"), SafePathError);
  await assert.rejects(scoped.read("../top.mp3"), SafePathError);
  await scoped.close();
});

test("recovers after the server restarts (dead pooled connection is retried)", async () => {
  const s = new FtpSource(opts());
  assert.equal((await s.list("")).length, 2);
  await srv.close();
  srv = await startPlainFtpServer(root, port);
  assert.equal((await s.list("")).length, 2);
  await s.close();
});

test("test(): ok, wrong password, refused connection, base path missing", async () => {
  assert.deepEqual(await src.test(), { ok: true });
  const bad = await new FtpSource(opts({ password: "wrong" })).test();
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? "" : bad.error, /wrong username or password/i);
  const refused = await new FtpSource(opts({ port: await freePort() })).test();
  assert.match(refused.ok ? "" : refused.error, /refused/i);
  const noPath = await new FtpSource(opts({ basePath: "/does-not-exist" })).test();
  assert.equal(noPath.ok, false);
});
