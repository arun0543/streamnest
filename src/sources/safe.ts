import path from "node:path";

/** The single path-escape guard used by every source (local, SMB, FTP) and the static file server. */
export class SafePathError extends Error {
  constructor(message = "invalid path") {
    super(message);
    this.name = "SafePathError";
  }
}

type PlatformPath = typeof path.posix;

/**
 * Split a library-relative path into clean segments.
 * Rejects NUL bytes and any ".." segment outright (stricter than normalizing).
 * Leading separators are ignored so "/a/b" means "a/b" inside the library.
 * On win32 flavor, "\" is a separator and drive letters / alternate data streams (":") are rejected.
 */
export function cleanSegments(rel: string, pf: PlatformPath = path): string[] {
  if (rel.includes("\0")) throw new SafePathError();
  const isWin = pf === path.win32;
  const normalized = isWin ? rel.replace(/\\/g, "/") : rel;
  if (isWin && normalized.includes(":")) throw new SafePathError();
  const segments: string[] = [];
  for (const seg of normalized.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") throw new SafePathError();
    segments.push(seg);
  }
  return segments;
}

/** Library-relative POSIX-style path ("a/b/c", "" for the root). */
export function cleanRel(rel: string, pf: PlatformPath = path): string {
  return cleanSegments(rel, pf).join("/");
}

/** Throws unless `target` is `root` itself or lies inside it. */
export function assertInside(root: string, target: string, pf: PlatformPath = path): void {
  const relative = pf.relative(root, target);
  if (relative === "") return;
  if (relative === ".." || relative.startsWith(".." + pf.sep) || pf.isAbsolute(relative)) {
    throw new SafePathError();
  }
}

/** Resolve a library-relative path against a local root, guaranteeing it stays inside the root. */
export function resolveLocal(root: string, rel: string, pf: PlatformPath = path): string {
  const abs = pf.join(root, ...cleanSegments(rel, pf));
  assertInside(root, abs, pf);
  return abs;
}

/** Normalize a path for remote (FTP/SMB) sources: absolute POSIX path under `base`. */
export function resolveRemote(base: string, rel: string): string {
  const baseSegs = cleanSegments(base, path.posix);
  const segs = cleanSegments(rel, path.posix);
  const full = path.posix.join("/", ...baseSegs, ...segs);
  assertInside(path.posix.join("/", ...baseSegs), full, path.posix);
  return full;
}
