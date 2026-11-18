import assert from "node:assert/strict";
import { test } from "node:test";
import { SafePathError } from "../src/sources/safe.ts";
import { SmbSource, describeSmbError, type SmbBackend, type SmbConnect, type SmbDirEntry } from "../src/sources/smb.ts";
import { collect, freePort } from "./helpers.ts";

const FILE = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
const tree: Record<string, SmbDirEntry[]> = {
  "/media": [
    { name: "Movies", isDir: true, size: 0, mtime: 1 },
    { name: "song.mp3", isDir: false, size: FILE.length, mtime: 5 },
  ],
  "/media/Movies": [{ name: "Film.MKV", isDir: false, size: FILE.length, mtime: 9 }],
};

function fakeBackend(log: { reads: [string, number, number][] }): SmbBackend {
  return {
    async list(p) {
      const hit = tree[p.replace(/\/+$/, "")];
      if (!hit) throw Object.assign(new Error("nf"), { header: { status: 0xc0000034 } });
      return hit;
    },
    async *readChunk(p, offset, end) {
      log.reads.push([p, offset, end]);
      const last = Math.min(end, FILE.length - 1);
      for (let o = offset; o <= last; o += 300) yield FILE.subarray(o, Math.min(o + 300, last + 1));
    },
    async close() {},
  };
}

const opts = { host: "nas", share: "Media", path: "media", domain: "", username: "u", password: "p" };

test("list / stat (case-insensitive lookup in the parent folder) / ranged read pass correct offsets", async () => {
  const log = { reads: [] as [string, number, number][] };
  const s = new SmbSource(opts, async () => fakeBackend(log));
  assert.deepEqual((await s.list("")).map((e) => `${e.type}:${e.path}`), ["dir:Movies", "file:song.mp3"]);
  assert.deepEqual((await s.list("Movies")).map((e) => e.path), ["Movies/Film.MKV"]);
  const st = await s.stat("Movies/film.mkv");
  assert.deepEqual([st.isFile, st.size], [true, 1000]);
  assert.equal((await s.stat("Movies")).isFile, false);
  await assert.rejects(s.stat("Movies/nope"), { code: "ENOENT" });
  await assert.rejects(s.list("Missing"), { code: "ENOENT" });

  const part = await collect(await s.read("Movies/Film.MKV", { start: 250, end: 749 }));
  assert.ok(part.equals(FILE.subarray(250, 750)));
  assert.deepEqual(log.reads.at(-1), ["/media/Movies/Film.MKV", 250, 749]);
  assert.ok((await collect(await s.read("song.mp3"))).equals(FILE));
});

test("'..' cannot leave the shared folder", async () => {
  const s = new SmbSource(opts, async () => fakeBackend({ reads: [] }));
  await assert.rejects(s.list("../x"), SafePathError);
  await assert.rejects(s.read("a/../../b"), SafePathError);
});

test("reconnects once when the connection dropped", async () => {
  let connects = 0;
  const connect: SmbConnect = async () => {
    connects++;
    const b = fakeBackend({ reads: [] });
    if (connects === 1) return { ...b, list: async () => { throw Object.assign(new Error("x"), { code: "ECONNRESET" }); } };
    return b;
  };
  const s = new SmbSource(opts, connect);
  assert.equal((await s.list("")).length, 2);
  assert.equal(connects, 2);
});

test("error messages are specific", () => {
  const nt = (status: number) => ({ header: { status } });
  assert.match(describeSmbError(nt(0xc000006d)), /Authentication failed/);
  assert.match(describeSmbError(nt(0xc00000cc)), /Share not found/);
  assert.match(describeSmbError({ code: "ENOTFOUND" }), /Host not found/);
  assert.match(describeSmbError({ code: "ECONNREFUSED" }), /Connection refused/);
  assert.match(describeSmbError({ message: "connect_timeout" }), /unreachable/);
  assert.match(describeSmbError({ code: "ECONNRESET" }), /SMB1/);
});

test("test() reports failures from the backend; the real client reports a refused port", async () => {
  const failing = new SmbSource(opts, async () => { throw { header: { status: 0xc000006d } }; });
  const r = await failing.test();
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.error, /Authentication failed/);
  // Uses the real @awo00/smb2 client against a closed local port: proves the package loads and errors are mapped.
  const real = await new SmbSource({ ...opts, host: "127.0.0.1", port: await freePort() }).test();
  assert.equal(real.ok, false);
  assert.match(real.ok ? "" : real.error, /Connection refused/);
});
