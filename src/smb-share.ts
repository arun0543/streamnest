import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type LocalLibrary } from "./config.ts";

/** SMB share names: letters, digits, space-less, max 80 chars, unique (case-insensitive). */
export function shareNames(libs: LocalLibrary[]): Map<string, string> {
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const l of libs) {
    const base = l.name.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 70) || "media";
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base}_${i}`;
    used.add(name.toLowerCase());
    out.set(l.id, name);
  }
  return out;
}

const psq = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** Windows: one read-only New-SmbShare per library (run in an elevated PowerShell). */
export function windowsCommands(libs: LocalLibrary[], readAccess: string): string[] {
  const names = shareNames(libs);
  return libs.map((l) => `New-SmbShare -Name ${psq(names.get(l.id)!)} -Path ${psq(path.win32.normalize(l.path))} -ReadAccess ${psq(readAccess)}`);
}

/** Linux: a read-only Samba block per library for /etc/samba/smb.conf (or an included file). */
export function sambaConf(libs: LocalLibrary[], user: string): string {
  // A newline in a path or user name would inject extra smb.conf lines.
  if (/[\r\n]/.test(user) || libs.some((l) => /[\r\n]/.test(l.path))) throw new Error("Refusing to write smb.conf: a path or user name contains a line break");
  const names = shareNames(libs);
  return libs
    .map((l) => [
      `[${names.get(l.id)}]`,
      `   comment = StreamNest: ${l.name.replace(/[\r\n]/g, " ")}`,
      `   path = ${l.path}`,
      "   read only = no",
      "   writable = yes",
      "   browseable = yes",
      "   guest ok = no",
      `   valid users = ${user}`,
      "   create mask = 0664",
      "   directory mask = 0775",
      "",
    ].join("\n"))
    .join("\n");
}

export function describePlan(platform: NodeJS.Platform, libs: LocalLibrary[], opts: { user: string; readAccess: string }): string {
  if (libs.length === 0) return "No local libraries to share. Add some first: npm run add -- \"D:/Movies\"";
  if (platform === "win32") {
    return [
      "# Run these in an ADMINISTRATOR PowerShell (or run: npm run smb:share -- --apply from an admin terminal):",
      ...windowsCommands(libs, opts.readAccess),
      "",
      "# Then browse to \\\\<this-pc-name>\\<ShareName> from other devices.",
      "# Remove a share later with: Remove-SmbShare -Name <ShareName>",
    ].join("\n");
  }
  return [
    "# 1. Install Samba if needed:  sudo apt install samba   |   sudo dnf install samba",
    `# 2. Create an SMB password for "${opts.user}":  sudo smbpasswd -a ${opts.user}`,
    "# 3. Append this to /etc/samba/smb.conf:",
    sambaConf(libs, opts.user),
    "# 4. Check and restart:",
    "testparm -s",
    "sudo systemctl restart smbd   # Fedora: sudo systemctl restart smb",
    "# Make sure the folders are readable by that user, and open the firewall (Samba profile) if one is active.",
  ].join("\n");
}

function parseOpts(args: string[]): { apply: boolean; user: string; readAccess: string } {
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const user = get("--user") ?? os.userInfo().username;
  return { apply: args.includes("--apply"), user, readAccess: get("--read-access") ?? get("--user") ?? "Everyone" };
}

function applyWindows(cmds: string[]): number {
  for (const c of cmds) {
    console.log(`> ${c}`);
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", c], { stdio: "inherit" });
    if (r.status !== 0) {
      console.error("Failed. New-SmbShare needs an elevated (Administrator) PowerShell.");
      return 1;
    }
  }
  return 0;
}

function applyLinux(libs: LocalLibrary[], user: string): number {
  const conf = "/etc/samba/smb.conf";
  const include = "/etc/samba/streamnest.conf";
  if (!fs.existsSync(conf)) {
    console.error("Samba is not installed (/etc/samba/smb.conf missing). Install it first (sudo apt install samba | sudo dnf install samba).");
    return 1;
  }
  const sudo = process.getuid?.() === 0 ? [] : ["sudo"];
  const run = (cmd: string, args: string[], input?: string): boolean => {
    const r = spawnSync(sudo[0] ?? cmd, sudo[0] ? [cmd, ...args] : args, { stdio: input ? ["pipe", "inherit", "inherit"] : "inherit", ...(input ? { input } : {}) });
    return r.status === 0;
  };
  if (!run("tee", [include], sambaConf(libs, user))) return 1;
  const current = fs.readFileSync(conf, "utf8");
  if (!current.includes(`include = ${include}`)) {
    if (!run("cp", [conf, `${conf}.streamnest.bak`])) return 1;
    if (!run("tee", ["-a", conf], `\n# Added by StreamNest\ninclude = ${include}\n`)) return 1;
  }
  if (!run("testparm", ["-s"])) return 1;
  const unit = spawnSync("systemctl", ["list-unit-files", "smbd.service"], { encoding: "utf8" }).stdout.includes("smbd") ? "smbd" : "smb";
  if (!run("systemctl", ["restart", unit])) return 1;
  console.log(`Samba restarted. Set the SMB password if you have not yet:  sudo smbpasswd -a ${user}`);
  return 0;
}

function main(): number {
  const opts = parseOpts(process.argv.slice(2));
  const all = loadConfig().libraries;
  const libs = all.filter((l): l is LocalLibrary => l.kind === "local");
  if (all.length > libs.length) console.log(`(${all.length - libs.length} remote SMB/FTP libraries are skipped: only local folders can be shared)\n`);
  console.log(describePlan(process.platform, libs, opts));
  if (!opts.apply || libs.length === 0) {
    if (!opts.apply && libs.length) console.log("\nNothing was changed. Add --apply to run this for you.");
    return 0;
  }
  console.log("");
  return process.platform === "win32" ? applyWindows(windowsCommands(libs, opts.readAccess)) : applyLinux(libs, opts.user);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) process.exitCode = main();
