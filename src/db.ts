/**
 * db.ts — optional persistence layer.
 *
 * StreamNest normally stores everything in flat JSON files.  When a database
 * URL is configured it switches to SQLite or PostgreSQL instead.
 *
 * Config:
 *   STREAMNEST_DB=sqlite          → data/streamnest.db  (default path)
 *   STREAMNEST_DB=sqlite:./my.db  → custom path
 *   STREAMNEST_DB=postgres://…    → PostgreSQL connection string
 *
 * The database holds three tables: config, sessions, shares.
 * The JSON-file backend is kept as a fallback when no DB URL is set.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type DbBackend = "sqlite" | "postgres" | "file";

export interface DbRow { key: string; value: string; }

export interface Db {
  backend: DbBackend;
  /** Read a JSON value. Returns null if the key does not exist. */
  get(table: string, key: string): unknown;
  /** Upsert a JSON-serialisable value. */
  set(table: string, key: string, value: unknown): void;
  /** Delete a key. */
  del(table: string, key: string): void;
  /** All entries in a table. */
  all(table: string): DbRow[];
  close(): void;
}

/* ─── SQLite backend ─────────────────────────────────────────────────── */
function openSqlite(file: string): Db {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require("better-sqlite3") as any;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  for (const t of ["config", "sessions", "shares"]) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${t} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  }
  const get = db.prepare("SELECT value FROM :t WHERE key = ?");
  const set = db.prepare("INSERT OR REPLACE INTO :t (key, value) VALUES (?, ?)");
  const del = db.prepare("DELETE FROM :t WHERE key = ?");
  const all = db.prepare("SELECT key, value FROM :t");

  function tbl(t: string): string {
    if (!/^\w+$/.test(t)) throw new Error(`invalid table name: ${t}`);
    return t;
  }
  return {
    backend: "sqlite",
    get(table, key) {
      const row = db.prepare(`SELECT value FROM ${tbl(table)} WHERE key = ?`).get(key);
      return row ? JSON.parse(row.value) : null;
    },
    set(table, key, value) {
      db.prepare(`INSERT OR REPLACE INTO ${tbl(table)} (key, value) VALUES (?, ?)`).run(key, JSON.stringify(value));
    },
    del(table, key) {
      db.prepare(`DELETE FROM ${tbl(table)} WHERE key = ?`).run(key);
    },
    all(table) {
      const rows = db.prepare(`SELECT key, value FROM ${tbl(table)}`).all();
      return rows.map((r: any) => ({ key: r.key, value: r.value }));
    },
    close() { db.close(); },
  };
}

/* ─── PostgreSQL backend ──────────────────────────────────────────────── */
function openPostgres(url: string): Db {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Client } = require("pg") as any;
  const client = new Client({ connectionString: url });
  // We run everything synchronously via a local in-memory cache + async flush.
  // For a home media server this is perfectly fine.
  const cache = new Map<string, Map<string, string>>();
  let ready = false;
  let readyError: Error | undefined;

  const readyP = (async () => {
    await client.connect();
    for (const t of ["config", "sessions", "shares"]) {
      await client.query(
        `CREATE TABLE IF NOT EXISTS sn_${t} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
      );
      const { rows } = await client.query(`SELECT key, value FROM sn_${t}`);
      const m = new Map<string, string>();
      for (const r of rows) m.set(r.key, r.value);
      cache.set(t, m);
    }
    ready = true;
  })().catch((e: Error) => { readyError = e; console.error("StreamNest PostgreSQL error:", e.message); });

  function tbl(t: string): string {
    if (!/^\w+$/.test(t)) throw new Error(`invalid table name: ${t}`);
    return `sn_${t}`;
  }
  function mapOf(table: string): Map<string, string> {
    if (readyError) throw readyError;
    if (!ready) throw new Error("PostgreSQL not ready yet");
    return cache.get(table) ?? (() => { const m = new Map<string, string>(); cache.set(table, m); return m; })();
  }

  return {
    backend: "postgres",
    get(table, key) {
      const v = mapOf(table).get(key);
      return v !== undefined ? JSON.parse(v) : null;
    },
    set(table, key, value) {
      const json = JSON.stringify(value);
      mapOf(table).set(key, json);
      void client.query(`INSERT INTO ${tbl(table)} (key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2`, [key, json]);
    },
    del(table, key) {
      mapOf(table).delete(key);
      void client.query(`DELETE FROM ${tbl(table)} WHERE key=$1`, [key]);
    },
    all(table) {
      return [...mapOf(table).entries()].map(([key, value]) => ({ key, value }));
    },
    close() { void client.end(); },
  };
}

/* ─── File backend (original behaviour) ─────────────────────────────── */
function openFile(dataDir: string): Db {
  function filePath(table: string): string { return path.join(dataDir, `${table}.json`); }
  function read(table: string): Record<string, string> {
    try { return JSON.parse(fs.readFileSync(filePath(table), "utf8")) as Record<string, string>; } catch { return {}; }
  }
  function write(table: string, data: Record<string, string>): void {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${filePath(table)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filePath(table));
  }
  return {
    backend: "file",
    get(table, key) { const r = read(table); return key in r ? JSON.parse(r[key]!) : null; },
    set(table, key, value) { const r = read(table); r[key] = JSON.stringify(value); write(table, r); },
    del(table, key) { const r = read(table); delete r[key]; write(table, r); },
    all(table) { return Object.entries(read(table)).map(([key, value]) => ({ key, value })); },
    close() {},
  };
}

/* ─── Factory ────────────────────────────────────────────────────────── */
export function openDb(dataDir: string): Db {
  const url = process.env.STREAMNEST_DB ?? "";
  if (!url || url === "file") return openFile(dataDir);
  if (url === "sqlite" || url.startsWith("sqlite:")) {
    const file = url === "sqlite" ? path.join(dataDir, "streamnest.db") : url.slice(7);
    console.log(`StreamNest: using SQLite at ${file}`);
    return openSqlite(path.resolve(file));
  }
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    console.log(`StreamNest: using PostgreSQL at ${url.replace(/:\/\/[^@]+@/, "://<credentials>@")}`);
    return openPostgres(url);
  }
  throw new Error(`STREAMNEST_DB: unknown backend "${url}". Use "sqlite", "sqlite:./path.db", "postgres://…", or leave unset for file storage.`);
}

export { crypto };
