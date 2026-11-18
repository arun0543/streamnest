import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR } from "./config.ts";

export function dataDir(): string {
  return process.env.STREAMNEST_DATA ?? path.join(ROOT_DIR, "data");
}

/** Load (or create on first run) the 32-byte master secret in <data>/secret.key. */
export function loadSecret(dir = dataDir()): Buffer {
  const file = path.join(dir, "secret.key");
  try {
    const existing = fs.readFileSync(file);
    if (existing.length === 32) return existing;
    throw new Error(`${file} is corrupt (expected 32 bytes). Delete it to generate a new one (stored passwords will need re-entering).`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  fs.mkdirSync(dir, { recursive: true });
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key, { mode: 0o600, flag: "wx" });
  return key;
}

/** Independent keys for independent purposes (HMAC for links, AES for stored credentials). */
export function deriveKey(secret: Buffer, label: string): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", secret, Buffer.alloc(0), `streamnest:${label}`, 32));
}

/** AES-256-GCM. Output: "v1:<iv>:<tag>:<ciphertext>" (base64url). */
export function encrypt(plain: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(":");
}

export function decrypt(blob: string, key: Buffer): string {
  const [v, iv, tag, ct] = blob.split(":");
  if (v !== "v1" || !iv || !tag || ct === undefined) throw new Error("unsupported ciphertext");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}

const SCRYPT = { N: 16384, r: 8, p: 1 };

/** Format: "scrypt$N$r$p$<salt>$<hash>" */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = crypto.scryptSync(password, Buffer.from(salt, "base64url"), expected.length, {
    N: Number(n), r: Number(r), p: Number(p),
  });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
