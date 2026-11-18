export interface Entry {
  name: string;
  /** Library-relative POSIX-style path without leading slash, e.g. "Season 1/ep1.mkv". */
  path: string;
  type: "dir" | "file";
  size?: number;
  mtime?: number;
}

export interface ByteRange {
  start: number;
  /** Inclusive end offset. */
  end: number;
}

export type TestResult = { ok: true } | { ok: false; error: string };

export interface Source {
  readonly kind: "local" | "smb" | "ftp";
  list(rel: string): Promise<Entry[]>;
  stat(rel: string): Promise<{ size: number; mtime: number; isFile: boolean }>;
  read(rel: string, range?: ByteRange): Promise<NodeJS.ReadableStream>;
  test(): Promise<TestResult>;
  close(): Promise<void>;
}
