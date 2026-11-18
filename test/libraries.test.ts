import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultConfig, loadConfig } from "../src/config.ts";
import { addLocalFolders, libraryLocation, normalizeInputPath, pathKey, removeLibraries } from "../src/libraries.ts";

const fakeCheck = (existing: string[]) => async (abs: string) => (existing.includes(abs) ? null : "does not exist");

test("normalizeInputPath repairs shell-escaped UNC paths and strips quotes", () => {
  assert.equal(normalizeInputPath('"D:/Movies"', "win32"), "D:/Movies");
  assert.equal(normalizeInputPath("\\\\\\\\NAS\\\\Media", "win32"), "\\\\NAS\\Media"); // as typed in cmd: \\\\NAS\\Media
  assert.equal(normalizeInputPath("\\\\NAS\\Media", "win32"), "\\\\NAS\\Media");
  assert.equal(normalizeInputPath("//NAS/Media", "win32"), "\\\\NAS/Media");
  assert.equal(normalizeInputPath("  /mnt/hdd/Movies  ", "linux"), "/mnt/hdd/Movies");
});

test("pathKey ignores trailing separators (and case on Windows)", () => {
  if (process.platform === "win32") {
    assert.equal(pathKey("D:\\Movies\\"), pathKey("d:/movies"));
    assert.equal(pathKey("D:\\"), "d:\\");
  } else {
    assert.equal(pathKey("/mnt/a/"), pathKey("/mnt/a"));
  }
});

test("add: several folders at once; skips duplicates, missing and relative paths but keeps going", async () => {
  const a = path.resolve(os.tmpdir(), "sn-a");
  const b = path.resolve(os.tmpdir(), "sn-b");
  const config = defaultConfig();
  const r = await addLocalFolders(config, [a, b, a, path.resolve(os.tmpdir(), "sn-missing"), "relative/path"], undefined, fakeCheck([a, b]));
  assert.deepEqual(r.added.map((l) => l.name), ["sn-a", "sn-b"]);
  assert.deepEqual(r.skipped.map((s) => s.reason), ["already added", "does not exist", "not an absolute path"]);
  assert.equal(config.libraries.length, 2);
  assert.equal(new Set(config.libraries.map((l) => l.id)).size, 2);
  const again = await addLocalFolders(config, [a + path.sep], undefined, fakeCheck([a]));
  assert.equal(again.added.length, 0); // trailing separator is still a duplicate
});

test("add: custom name for a single path", async () => {
  const a = path.resolve(os.tmpdir(), "sn-named");
  const config = defaultConfig();
  const r = await addLocalFolders(config, [a], "My Music", fakeCheck([a]));
  assert.equal(r.added[0]?.name, "My Music");
});

test("remove by id, name and path; reports unknown and ambiguous", async () => {
  const [a, b, c, d] = ["a", "b", "c", "d"].map((n) => path.resolve(os.tmpdir(), "sn-rm-" + n));
  const config = defaultConfig();
  await addLocalFolders(config, [a!], "Same", fakeCheck([a!]));
  await addLocalFolders(config, [b!], "Same", fakeCheck([b!]));
  await addLocalFolders(config, [c!], "Cee", fakeCheck([c!]));
  await addLocalFolders(config, [d!], "Dee", fakeCheck([d!]));
  const dId = config.libraries[3]!.id;
  const r = removeLibraries(config, ["Same", "cee", dId, "nothing", a!]);
  assert.deepEqual(r.ambiguous, ["Same"] satisfies string[]);
  assert.deepEqual(r.removed.map((l) => l.name).sort(), ["Cee", "Dee", "Same"]); // "Same" removed once via its path
  assert.deepEqual(r.notFound, ["nothing"]);
  assert.equal(config.libraries.length, 1);
  assert.equal(config.libraries[0] && libraryLocation(config.libraries[0]), b);
});

test("CLI: one command adds 3 folders, skips a missing one, list and remove work", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sn-cli-"));
  const dirs = ["Movies", "Music", "Shows"].map((n) => {
    const p = path.join(tmp, n);
    fs.mkdirSync(p);
    return p;
  });
  const env = { ...process.env, STREAMNEST_CONFIG: path.join(tmp, "config.json"), STREAMNEST_DATA: path.join(tmp, "data") };
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { env, encoding: "utf8", cwd: path.resolve(import.meta.dirname, "..") });

  const add = run("add", ...dirs, path.join(tmp, "Missing"));
  assert.equal(add.status, 0, add.stderr);
  assert.match(add.stdout, /skipped .*Missing: does not exist/);
  const cfg = loadConfig(env.STREAMNEST_CONFIG);
  assert.deepEqual(cfg.libraries.map((l) => l.name), ["Movies", "Music", "Shows"]);

  assert.equal(run("add", dirs[0]!).status, 1); // nothing new -> exit 1
  assert.equal(run("add", dirs[0]!, dirs[1]!, "--name", "x").status, 1); // --name needs a single path
  assert.match(run("list").stdout, /Movies/);

  const rm = run("remove", "Music", dirs[2]!);
  assert.equal(rm.status, 0, rm.stderr);
  assert.deepEqual(loadConfig(env.STREAMNEST_CONFIG).libraries.map((l) => l.name), ["Movies"]);
  fs.rmSync(tmp, { recursive: true, force: true });
});
