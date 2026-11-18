import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { LocalLibrary } from "../src/config.ts";
import { describePlan, sambaConf, shareNames, windowsCommands } from "../src/smb-share.ts";
import { tmpDir } from "./helpers.ts";

const libs: LocalLibrary[] = [
  { id: "1", name: "My Movies", kind: "local", path: "D:/Movies" },
  { id: "2", name: "My Movies", kind: "local", path: "/mnt/hdd/Movies" },
  { id: "3", name: "Mu$ic's", kind: "local", path: "E:\\Music" },
];

test("share names are safe and unique", () => {
  assert.deepEqual([...shareNames(libs).values()], ["My_Movies", "My_Movies_2", "Mu_ic_s"]);
});

test("Windows: read-only New-SmbShare per library with escaped quotes and backslash paths", () => {
  const cmds = windowsCommands(libs, "Everyone");
  assert.equal(cmds[0], "New-SmbShare -Name 'My_Movies' -Path 'D:\\Movies' -ReadAccess 'Everyone'");
  assert.equal(cmds[2], "New-SmbShare -Name 'Mu_ic_s' -Path 'E:\\Music' -ReadAccess 'Everyone'");
  assert.ok(cmds.every((c) => !/-(Full|Change)Access/.test(c)));
});

test("Linux: read-only Samba blocks restricted to one user, no guests", () => {
  const conf = sambaConf(libs, "alice");
  assert.match(conf, /\[My_Movies\]\n.*\n {3}path = D:\/Movies\n {3}read only = yes/);
  assert.equal((conf.match(/read only = yes/g) ?? []).length, 3);
  assert.equal((conf.match(/guest ok = no/g) ?? []).length, 3);
  assert.equal((conf.match(/valid users = alice/g) ?? []).length, 3);
});

test("Linux: a path or user containing a line break is refused (smb.conf injection)", () => {
  const evil: LocalLibrary = { id: "9", name: "x", kind: "local", path: "/mnt/a\n[global]\nsecurity = share" };
  assert.throws(() => sambaConf([evil], "alice"), /line break/);
  assert.throws(() => sambaConf(libs, "alice\nguest ok = yes"), /line break/);
});

test("describePlan prints the commands for the requested OS", () => {
  const win = describePlan("win32", libs, { user: "alice", readAccess: "alice" });
  assert.match(win, /ADMINISTRATOR PowerShell/);
  assert.match(win, /New-SmbShare/);
  const lin = describePlan("linux", libs, { user: "alice", readAccess: "Everyone" });
  assert.match(lin, /smbpasswd -a alice/);
  assert.match(lin, /systemctl restart smbd/);
  assert.match(describePlan("linux", [], { user: "a", readAccess: "a" }), /No local libraries/);
});

test("npm run smb:share prints the right commands for this OS and changes nothing without --apply", () => {
  const dir = tmpDir("sn-smb-");
  const share = path.join(dir, "Films");
  fs.mkdirSync(share);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ libraries: [{ id: "x", name: "Films", kind: "local", path: share }] }));
  const r = spawnSync(process.execPath, ["--import", "tsx", "src/smb-share.ts"], {
    cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", env: { ...process.env, STREAMNEST_CONFIG: path.join(dir, "config.json") },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, process.platform === "win32" ? /New-SmbShare -Name 'Films'/ : /\[Films\]/);
  assert.match(r.stdout, /Nothing was changed/);
  fs.rmSync(dir, { recursive: true, force: true });
});
