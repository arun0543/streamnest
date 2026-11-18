import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream";
import type { ByteRange, Source } from "./sources/types.ts";

/**
 * Parse an HTTP Range header against a known size.
 * - null: no usable range, serve the whole file (absent, malformed or multi-range headers are ignored)
 * - "unsatisfiable": respond 416
 */
export function parseRange(header: string | undefined, size: number): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a = "", b = ""] = m;
  if (a === "" && b === "") return null;
  if (a === "") {
    const n = Number(b);
    if (n === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  const end = b === "" ? size - 1 : Number(b);
  if (b !== "" && end < start) return null;
  if (start >= size) return "unsatisfiable";
  return { start, end: Math.min(end, size - 1) };
}

const MIME: Record<string, string> = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mkv": "video/x-matroska",
  ".mov": "video/quicktime", ".avi": "video/x-msvideo", ".ts": "video/mp2t",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac",
  ".wav": "audio/wav", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".oga": "audio/ogg",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp",
  ".srt": "text/plain; charset=utf-8", ".vtt": "text/vtt; charset=utf-8",
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
};

export function mimeFor(name: string): string {
  return MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

export interface ServeOptions {
  /** Force a download (Content-Disposition: attachment). */
  download?: boolean;
  /** StreamNest's own files (UI, guide): may be served as HTML/JS. Never set for library content. */
  trusted?: boolean;
}

/** Source-agnostic ranged file response (GET and HEAD). */
export async function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  source: Source,
  rel: string,
  opts: ServeOptions = {},
): Promise<void> {
  const st = await source.stat(rel);
  if (!st.isFile) {
    res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "not found" }));
    return;
  }
  const name = path.posix.basename(rel);
  const type = mimeFor(name);
  // Files from a library are user content on our origin: a stray .html/.svg/.js must never run as a page there
  // (share links need no login, so a visitor could otherwise script the admin's session). Only media is shown inline.
  const inlineSafe = opts.trusted || /^(video|audio)\//.test(type) || /^image\/(jpeg|png|gif|webp)$/.test(type) || /^text\/(plain|vtt)/.test(type);
  const headers: Record<string, string | number> = {
    "Content-Type": inlineSafe ? type : "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
    "Last-Modified": new Date(st.mtime).toUTCString(),
    "Cache-Control": "private, no-cache",
  };
  if (opts.download || !inlineSafe) {
    headers["Content-Disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
  }

  const range = parseRange(req.headers.range, st.size);
  if (range === "unsatisfiable") {
    res.writeHead(416, { ...headers, "Content-Range": `bytes */${st.size}` }).end();
    return;
  }

  // TODO(transcode): decide here whether to pipe through a transcoder instead of the raw bytes.
  if (range) {
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${st.size}`;
    headers["Content-Length"] = range.end - range.start + 1;
    res.writeHead(206, headers);
  } else {
    headers["Content-Length"] = st.size;
    res.writeHead(200, headers);
  }

  if (req.method === "HEAD" || st.size === 0) {
    res.end();
    return;
  }
  const body = await source.read(rel, range ?? undefined);
  pipeline(body, res, () => {
    // Client aborts (seeking, closing the tab) surface here as premature-close; nothing to do.
  });
}
