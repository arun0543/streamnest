import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import type { Config } from "./config.ts";

export interface Tunnel {
  url: string;
  stop(): void;
}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/** Pulls the public URL out of a line of cloudflared output (it logs to stderr). */
export function parseTunnelUrl(text: string): string | null {
  return URL_RE.exec(text)?.[0] ?? null;
}

/** Online mode exposes your server to the internet, so it must never run without a login. */
export function assertOnlineAllowed(config: Config): void {
  if (!config.admin?.passwordHash) {
    throw new Error("Online mode needs an admin password. Run: npm run set-password   (then start again with: online)");
  }
}

export const INSTALL_HINT =
  "cloudflared was not found. Install it: Windows: winget install Cloudflare.cloudflared | Debian/Ubuntu/Raspberry Pi: https://pkg.cloudflare.com | Fedora: sudo dnf install cloudflared (or download the binary from https://github.com/cloudflare/cloudflared/releases). You can also set CLOUDFLARED=/path/to/cloudflared.";

export interface TunnelOptions {
  port: number;
  bin?: string;
  timeoutMs?: number;
  spawn?: typeof nodeSpawn;
}

/** Starts a Cloudflare quick tunnel to the local server and resolves once its public URL is known. */
export function startTunnel(opts: TunnelOptions): Promise<Tunnel> {
  const spawn = opts.spawn ?? nodeSpawn;
  const bin = opts.bin ?? process.env.CLOUDFLARED ?? "cloudflared";
  return new Promise<Tunnel>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${opts.port}`], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      return reject(err);
    }
    let settled = false;
    const finish = (fn: () => void): void => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    const timer = setTimeout(() => finish(() => { child.kill(); reject(new Error("cloudflared started but did not report a public URL within the time limit")); }), opts.timeoutMs ?? 30_000);
    const onData = (buf: Buffer): void => {
      const url = parseTunnelUrl(buf.toString());
      if (url) finish(() => resolve({ url, stop: () => { child.kill(); } }));
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", (err: NodeJS.ErrnoException) => finish(() => reject(err.code === "ENOENT" ? new Error(INSTALL_HINT) : err)));
    child.once("exit", (code) => finish(() => reject(new Error(`cloudflared exited early (code ${code})`))));
  });
}
