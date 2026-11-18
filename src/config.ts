import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ROOT_DIR = path.resolve(import.meta.dirname, "..");

export interface LocalLibrary {
  id: string;
  name: string;
  kind: "local";
  path: string;
}

export interface SmbLibrary {
  id: string;
  name: string;
  kind: "smb";
  host: string;
  port?: number;
  share: string;
  /** Folder inside the share ("" = share root). */
  path: string;
  domain: string;
  username: string;
  /** AES-256-GCM blob (see crypto.ts). Never returned by the API. */
  passwordEnc: string;
}

export interface FtpLibrary {
  id: string;
  name: string;
  kind: "ftp";
  host: string;
  port: number;
  secure: "none" | "explicit" | "implicit";
  username: string;
  passwordEnc: string;
  basePath: string;
  maxConnections: number;
  /** Accept self-signed TLS certificates (common on home NAS boxes). Off by default. */
  allowSelfSigned?: boolean;
}

export type Library = LocalLibrary | SmbLibrary | FtpLibrary;

export interface FtpServerSettings {
  enabled: boolean;
  port: number;
  passivePorts: [number, number];
  username: string;
  /** scrypt hash; the FTP password is separate from the admin password. */
  passwordHash?: string;
}

export interface Config {
  port: number;
  admin?: { passwordHash: string };
  libraries: Library[];
  ftpServer: FtpServerSettings;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(`config.json: ${message}`);
    this.name = "ConfigError";
  }
}

export function configPath(): string {
  return process.env.STREAMNEST_CONFIG ?? path.join(ROOT_DIR, "config.json");
}

export function newId(): string {
  return crypto.randomBytes(4).toString("hex");
}

export function defaultFtpServer(): FtpServerSettings {
  return { enabled: false, port: 2121, passivePorts: [40000, 40100], username: "streamnest" };
}

export function defaultConfig(): Config {
  return { port: 8080, libraries: [], ftpServer: defaultFtpServer() };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Hand-written validation; unknown fields are dropped. */
export function validateConfig(raw: unknown): Config {
  if (!isRecord(raw)) throw new ConfigError("must be a JSON object");
  const port = raw.port === undefined ? 8080 : raw.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError("port must be an integer between 1 and 65535");
  }
  const rawLibs = raw.libraries === undefined ? [] : raw.libraries;
  if (!Array.isArray(rawLibs)) throw new ConfigError("libraries must be an array");
  const seen = new Set<string>();
  const libraries: Library[] = rawLibs.map((l: unknown, i): Library => {
    const where = `libraries[${i}]`;
    if (!isRecord(l)) throw new ConfigError(`${where} must be an object`);
    const str = (key: string, opts: { optional?: boolean } = {}): string => {
      const v = l[key];
      if (v === undefined && opts.optional) return "";
      if (typeof v !== "string" || (v === "" && !opts.optional)) throw new ConfigError(`${where}.${key} must be ${opts.optional ? "a string" : "a non-empty string"}`);
      return v;
    };
    const num = (key: string, def: number, min: number, max: number): number => {
      const v = l[key] === undefined ? def : l[key];
      if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new ConfigError(`${where}.${key} must be an integer between ${min} and ${max}`);
      return v;
    };
    const id = str("id");
    if (seen.has(id)) throw new ConfigError(`duplicate library id "${id}"`);
    seen.add(id);
    const name = str("name");
    switch (l.kind) {
      case "local":
        return { id, name, kind: "local", path: str("path") };
      case "smb": {
        const lib: SmbLibrary = {
          id, name, kind: "smb", host: str("host"), share: str("share"), path: str("path", { optional: true }),
          domain: str("domain", { optional: true }), username: str("username", { optional: true }), passwordEnc: str("passwordEnc", { optional: true }),
        };
        if (l.port !== undefined) lib.port = num("port", 445, 1, 65535);
        return lib;
      }
      case "ftp": {
        const secure = l.secure === undefined ? "none" : l.secure;
        if (secure !== "none" && secure !== "explicit" && secure !== "implicit") throw new ConfigError(`${where}.secure must be none, explicit or implicit`);
        return {
          id, name, kind: "ftp", host: str("host"), port: num("port", secure === "implicit" ? 990 : 21, 1, 65535), secure,
          username: str("username", { optional: true }) || "anonymous", passwordEnc: str("passwordEnc", { optional: true }),
          basePath: str("basePath", { optional: true }) || "/", maxConnections: num("maxConnections", 2, 1, 10),
          ...(l.allowSelfSigned === true ? { allowSelfSigned: true } : {}),
        };
      }
      default:
        throw new ConfigError(`${where}.kind "${String(l.kind)}" is not supported`);
    }
  });
  const result: Config = { port, libraries, ftpServer: defaultFtpServer() };
  if (raw.ftpServer !== undefined) {
    const f = raw.ftpServer;
    if (!isRecord(f)) throw new ConfigError("ftpServer must be an object");
    const d = defaultFtpServer();
    const pp = f.passivePorts;
    const okPort = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 65535;
    if (f.port !== undefined && !okPort(f.port)) throw new ConfigError("ftpServer.port must be a valid port");
    if (pp !== undefined && !(Array.isArray(pp) && pp.length === 2 && okPort(pp[0]) && okPort(pp[1]) && pp[0] <= pp[1])) {
      throw new ConfigError("ftpServer.passivePorts must be [from, to]");
    }
    if (f.username !== undefined && (typeof f.username !== "string" || f.username === "")) throw new ConfigError("ftpServer.username must be a non-empty string");
    result.ftpServer = {
      enabled: f.enabled === true,
      port: (f.port as number | undefined) ?? d.port,
      passivePorts: (pp as [number, number] | undefined) ?? d.passivePorts,
      username: (f.username as string | undefined) ?? d.username,
      ...(typeof f.passwordHash === "string" && f.passwordHash ? { passwordHash: f.passwordHash } : {}),
    };
  }
  if (raw.admin !== undefined) {
    if (!isRecord(raw.admin) || typeof raw.admin.passwordHash !== "string" || raw.admin.passwordHash === "") {
      throw new ConfigError("admin.passwordHash must be a non-empty string");
    }
    result.admin = { passwordHash: raw.admin.passwordHash };
  }
  return result;
}

export function loadConfig(file = configPath()): Config {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig();
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConfigError("is not valid JSON");
  }
  return validateConfig(parsed);
}

/** Atomic write: temp file in the same folder, then rename. */
export function saveConfig(config: Config, file = configPath()): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
