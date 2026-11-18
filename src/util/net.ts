import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withTimeout } from "./async.ts";

/** Non-internal IPv4 addresses of this machine. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) out.push(a.address);
    }
  }
  return out;
}

function ipv4ToInt(ip: string): number | null {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0]! << 24) | (p[1]! << 16) | (p[2]! << 8) | p[3]!) >>> 0;
}

/**
 * This machine's IPv4 address on the same subnet as `remote` (so a client on router B is never
 * told to connect to our address on router A). Falls back to the first LAN address.
 */
export function lanAddressFor(remote: string): string | undefined {
  const r = ipv4ToInt(remote.replace(/^::ffff:/, ""));
  if (r !== null) {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family !== "IPv4" || a.internal) continue;
        const ip = ipv4ToInt(a.address);
        const mask = ipv4ToInt(a.netmask);
        if (ip !== null && mask !== null && ((ip & mask) >>> 0) === ((r & mask) >>> 0)) return a.address;
      }
    }
  }
  return lanAddresses()[0];
}

/** Windows drive roots that exist right now ("C:\\", "D:\\"...). Disconnected network drives time out quickly. */
export async function listDrives(): Promise<string[]> {
  const letters = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
  const found = await Promise.all(
    letters.map(async (l) => {
      const root = `${l}:\\`;
      const ok = await withTimeout(fsp.access(root).then(() => true, () => false), 1500, false);
      return ok ? root : null;
    }),
  );
  return found.filter((r): r is string => r !== null);
}

export interface FsRoot {
  name: string;
  path: string;
}

/** Starting points for the folder picker: drives on Windows; "/" plus common mounts, all system users' home dirs, and /media on Linux/macOS. */
export async function browseRoots(): Promise<FsRoot[]> {
  if (process.platform === "win32") {
    return (await listDrives()).map((d) => ({ name: d.slice(0, 2), path: d }));
  }

  const out: FsRoot[] = [];
  const seen = new Set<string>();
  const tryAdd = async (name: string, p: string): Promise<void> => {
    if (seen.has(p)) return;
    seen.add(p);
    const ok = await fsp.stat(p).then((s) => s.isDirectory(), () => false);
    if (ok) out.push({ name, path: p });
  };

  // ── All system users' home directories ──────────────────────────────
  // Parse /etc/passwd to find every user with UID ≥ 1000 (real accounts).
  try {
    const passwd = await fsp.readFile("/etc/passwd", "utf8");
    const users: { name: string; home: string }[] = [];
    for (const line of passwd.split("\n")) {
      const parts = line.split(":");
      if (parts.length < 7) continue;
      const uid = Number(parts[2]);
      const home = parts[5] ?? "";
      const name = parts[0] ?? "";
      if (uid >= 1000 && home.startsWith("/") && name) {
        users.push({ name, home });
      }
    }
    // Sort alphabetically
    users.sort((a, b) => a.name.localeCompare(b.name));
    for (const u of users) {
      await tryAdd(`👤 ${u.name}  (${u.home})`, u.home);
    }
  } catch { /* /etc/passwd unreadable – skip */ }

  // ── Common mount points ──────────────────────────────────────────────
  for (const [name, p] of [
    ["📁 /media", "/media"],
    ["📁 /mnt", "/mnt"],
    ["📁 /", "/"],
  ] as const) {
    await tryAdd(name, p);
  }

  return out;
}

export interface FsListing {
  path: string;
  /** null at a filesystem root: go back to the roots list. */
  parent: string | null;
  dirs: FsRoot[];
}

/** Sub-folders of an absolute server-side path, for the admin folder picker. */
export async function listSubdirs(abs: string): Promise<FsListing> {
  if (abs.includes("\0") || !path.isAbsolute(abs)) throw Object.assign(new Error("path must be absolute"), { code: "EINVAL" });
  const resolved = path.resolve(abs);
  const dirents = await fsp.readdir(resolved, { withFileTypes: true });
  const dirs = await Promise.all(
    dirents.map(async (d): Promise<FsRoot | null> => {
      if (process.platform !== "win32" && d.name.startsWith(".")) return null;
      const full = path.join(resolved, d.name);
      try {
        return (await fsp.stat(full)).isDirectory() ? { name: d.name, path: full } : null;
      } catch {
        return null;
      }
    }),
  );
  const parent = path.dirname(resolved);
  return {
    path: resolved,
    parent: parent === resolved ? null : parent,
    dirs: dirs.filter((d): d is FsRoot => d !== null).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
  };
}
