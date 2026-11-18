import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { LocalSource } from "../src/sources/local.ts";
import { SafePathError } from "../src/sources/safe.ts";

let root = "";
let outside = "";
let src: LocalSource;

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sn-local-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "sn-outside-"));
  fs.mkdirSync(path.join(root, "B Folder"));
  fs.mkdirSync(path.join(root, "a folder"));
  fs.writeFileSync(path.join(root, "10.mp3"), "0123456789");
  fs.writeFileSync(path.join(root, "9.mp3"), "abc");
  fs.writeFileSync(path.join(root, "a folder", "x.mkv"), "hello world");
  fs.writeFileSync(path.join(outside, "secret.txt"), "top secret");
  src = new LocalSource(root);
});
after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test("list: folders first, natural sort, POSIX-style entry paths", async () => {
  const e = await src.list("");
  assert.deepEqual(e.map((x) => `${x.type}:${x.name}`), ["dir:a folder", "dir:B Folder", "file:9.mp3", "file:10.mp3"]);
  const sub = await src.list("a folder");
  assert.deepEqual(sub.map((x) => [x.path, x.size]), [["a folder/x.mkv", 11]]);
});

test("stat and ranged read", async () => {
  const st = await src.stat("10.mp3");
  assert.equal(st.size, 10);
  assert.equal(st.isFile, true);
  assert.equal((await src.stat("a folder")).isFile, false);
  assert.equal((await collect(await src.read("10.mp3", { start: 2, end: 5 }))).toString(), "2345");
  assert.equal((await collect(await src.read("10.mp3"))).toString(), "0123456789");
});

test("traversal is rejected; missing files give ENOENT", async () => {
  await assert.rejects(src.list(".."), SafePathError);
  await assert.rejects(src.read("../" + path.basename(outside) + "/secret.txt"), SafePathError);
  await assert.rejects(src.stat("nope.mp3"), { code: "ENOENT" });
});

test("a symlink that points outside the library cannot be followed", async (t) => {
  const link = path.join(root, "escape");
  try {
    fs.symlinkSync(outside, link, "junction"); // junctions need no admin rights on Windows
  } catch {
    t.skip("cannot create symlinks here");
    return;
  }
  await assert.rejects(src.list("escape"), SafePathError);
  await assert.rejects(src.read("escape/secret.txt"), SafePathError);
});

test("test(): ok for a folder, error for missing or non-folder paths", async () => {
  assert.deepEqual(await src.test(), { ok: true });
  const missing = await new LocalSource(path.join(root, "missing")).test();
  assert.equal(missing.ok, false);
  const file = await new LocalSource(path.join(root, "9.mp3")).test();
  assert.equal(file.ok, false);
});

test("Windows UNC path library lists and streams with seeking (uses the machine's own admin share)", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows only");
  const drive = path.parse(root).root.slice(0, 1); // e.g. "C" for the temp folder
  const unc = path.win32.join("\\\\localhost", `${drive}$`, path.relative(path.parse(root).root, root));
  if (!fs.existsSync(unc)) return t.skip("admin share not reachable here");
  const s = new LocalSource(unc);
  assert.deepEqual(await s.test(), { ok: true });
  assert.ok((await s.list("")).some((e) => e.name === "10.mp3"));
  assert.equal((await collect(await s.read("10.mp3", { start: 3, end: 6 }))).toString(), "3456");
  await assert.rejects(s.list(".."), SafePathError);
});
