import fsp from "node:fs/promises";
import path from "node:path";
import { newId, type Config, type Library } from "./config.ts";
import { withTimeout } from "./util/async.ts";

export interface AddResult {
  added: Library[];
  skipped: { input: string; reason: string }[];
}

/**
 * Clean up a user-typed path: trim, strip wrapping quotes, and (on Windows) repair UNC paths whose
 * backslashes were doubled by shell escaping ("\\\\NAS\\Media" -> "\\NAS\Media").
 */
export function normalizeInputPath(input: string, platform: NodeJS.Platform = process.platform): string {
  let p = input.trim();
  if (p.length >= 2 && ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'")))) p = p.slice(1, -1).trim();
  if (platform === "win32") {
    const unc = /^[\\/]{2,}/.test(p);
    p = p.replace(/\\{2,}/g, "\\").replace(/\/{2,}/g, "/");
    if (unc) p = "\\\\" + p.replace(/^[\\/]+/, "");
  }
  return p;
}

/** Comparison key: resolved, no trailing separator, case-insensitive on Windows. */
export function pathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  const pf = platform === "win32" ? path.win32 : path.posix;
  let r = pf.resolve(p);
  const root = pf.parse(r).root;
  while (r.length > root.length && (r.endsWith("\\") || r.endsWith("/"))) r = r.slice(0, -1);
  return platform === "win32" ? r.toLowerCase() : r;
}

/** Human-readable location without credentials: a folder path, smb://host/share/... or ftp://host:port/... */
export function libraryLocation(l: Library): string {
  if (l.kind === "local") return l.path;
  if (l.kind === "smb") return `smb://${l.host}/${l.share}${l.path ? "/" + l.path.replace(/^[\\/]+/, "") : ""}`;
  return `ftp://${l.host}:${l.port}${l.basePath}`;
}

function defaultName(abs: string): string {
  const base = path.basename(abs);
  if (base) return base;
  return abs.replace(/[\\/]+$/, "") || abs; // drive or filesystem root
}

export type DirCheck = (abs: string) => Promise<string | null>;

/** Returns null if `abs` is a reachable folder, otherwise the reason. */
export const checkFolder: DirCheck = async (abs) => {
  try {
    const st = await withTimeout(fsp.stat(abs), 8000, null);
    if (st === null) return "unreachable (timed out)";
    return st.isDirectory() ? null : "not a folder";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "does not exist";
    if (code === "EACCES" || code === "EPERM") return "permission denied";
    return `cannot be reached (${code ?? "error"})`;
  }
};

/** Adds local folders to `config` (mutating it); skips duplicates and bad paths but keeps going. */
export async function addLocalFolders(config: Config, inputs: string[], name?: string, check: DirCheck = checkFolder): Promise<AddResult> {
  const result: AddResult = { added: [], skipped: [] };
  const seen = new Set(config.libraries.filter((l) => l.kind === "local").map((l) => pathKey(l.path)));
  for (const raw of inputs) {
    const cleaned = normalizeInputPath(raw);
    if (!cleaned) continue;
    if (!path.isAbsolute(cleaned)) {
      result.skipped.push({ input: raw, reason: "not an absolute path" });
      continue;
    }
    const abs = path.resolve(cleaned);
    const key = pathKey(abs);
    if (seen.has(key)) {
      result.skipped.push({ input: raw, reason: "already added" });
      continue;
    }
    const problem = await check(abs);
    if (problem) {
      result.skipped.push({ input: raw, reason: problem });
      continue;
    }
    seen.add(key);
    const lib: Library = { id: newId(), name: (name?.trim() || defaultName(abs)), kind: "local", path: abs };
    config.libraries.push(lib);
    result.added.push(lib);
  }
  return result;
}

export interface RemoveResult {
  removed: Library[];
  notFound: string[];
  ambiguous: string[];
}

/** Remove by id, exact name (case-insensitive) or path. Ambiguous names are skipped and reported. */
export function removeLibraries(config: Config, selectors: string[]): RemoveResult {
  const result: RemoveResult = { removed: [], notFound: [], ambiguous: [] };
  for (const sel of selectors) {
    const s = sel.trim();
    const byId = config.libraries.filter((l) => l.id === s);
    let matches = byId;
    if (matches.length === 0) matches = config.libraries.filter((l) => l.name.toLowerCase() === s.toLowerCase());
    if (matches.length === 0) {
      const key = pathKey(normalizeInputPath(s));
      matches = config.libraries.filter((l) => l.kind === "local" && pathKey(l.path) === key);
    }
    if (matches.length === 0) result.notFound.push(sel);
    else if (matches.length > 1) result.ambiguous.push(sel);
    else {
      const m = matches[0]!;
      config.libraries = config.libraries.filter((l) => l.id !== m.id);
      result.removed.push(m);
    }
  }
  return result;
}
