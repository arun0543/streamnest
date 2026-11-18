import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { SafePathError, assertInside, cleanRel, resolveLocal, resolveRemote } from "../src/sources/safe.ts";

const win = path.win32;
const posix = path.posix;

test("posix: normal paths resolve inside the root", () => {
  assert.equal(resolveLocal("/mnt/hdd/Movies", "a/b.mkv", posix), "/mnt/hdd/Movies/a/b.mkv");
  assert.equal(resolveLocal("/mnt/hdd/Movies", "", posix), "/mnt/hdd/Movies");
  assert.equal(resolveLocal("/mnt/hdd/Movies", "/etc/passwd", posix), "/mnt/hdd/Movies/etc/passwd"); // leading slash is library-relative
});

test("posix: traversal and NUL are rejected", () => {
  for (const bad of ["../etc/passwd", "a/../../x", "..", "a/..", "a\0b"]) {
    assert.throws(() => resolveLocal("/mnt/hdd/Movies", bad, posix), SafePathError, bad);
  }
});

test("posix: backslash is an ordinary filename character", () => {
  assert.equal(resolveLocal("/m", "a\\b", posix), "/m/a\\b");
});

test("win32: drive paths", () => {
  assert.equal(resolveLocal("D:\\Movies", "Action/film.mkv", win), "D:\\Movies\\Action\\film.mkv");
  assert.equal(resolveLocal("D:/Movies", "Action\\film.mkv", win), "D:\\Movies\\Action\\film.mkv");
  assert.equal(resolveLocal("D:\\", "a", win), "D:\\a");
});

test("win32: traversal, other drives and streams are rejected", () => {
  for (const bad of ["..\\..\\Windows", "../x", "C:\\Windows", "E:/x", "file.txt:stream", "a\\..\\..\\b", "a\0"]) {
    assert.throws(() => resolveLocal("D:\\Movies", bad, win), SafePathError, bad);
  }
});

test("win32: UNC roots", () => {
  const root = "\\\\server\\share\\Movies";
  assert.equal(resolveLocal(root, "sub\\a.mkv", win), "\\\\server\\share\\Movies\\sub\\a.mkv");
  assert.equal(resolveLocal(root, "sub/a.mkv", win), "\\\\server\\share\\Movies\\sub\\a.mkv");
  assert.throws(() => resolveLocal(root, "..\\Other", win), SafePathError);
  assert.throws(() => resolveLocal(root, "\\\\evil\\share\\x:", win), SafePathError);
});

test("assertInside: sibling folder with shared prefix is outside", () => {
  assert.throws(() => assertInside("D:\\Movies", "D:\\Movies2\\x", win), SafePathError);
  assert.throws(() => assertInside("/mnt/Movies", "/mnt/Movies2/x", posix), SafePathError);
  assert.doesNotThrow(() => assertInside("D:\\Movies", "D:\\Movies\\x", win));
  assert.doesNotThrow(() => assertInside("D:\\Movies", "D:\\Movies", win));
});

test("cleanRel normalizes separators and dots", () => {
  assert.equal(cleanRel("/a//b/./c/", posix), "a/b/c");
  assert.equal(cleanRel("a\\b", win), "a/b");
  assert.equal(cleanRel("", posix), "");
});

test("remote (FTP/SMB) paths stay under the base and reject ..", () => {
  assert.equal(resolveRemote("/media", "a/b"), "/media/a/b");
  assert.equal(resolveRemote("/", ""), "/");
  assert.equal(resolveRemote("", "x"), "/x");
  assert.throws(() => resolveRemote("/media", "../etc"), SafePathError);
  assert.throws(() => resolveRemote("/media", "a/../../etc"), SafePathError);
});
