import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const tmpDir = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

/** First port of `count` consecutive free ports (Windows reserves some ephemeral ranges, so a random port is not enough). */
export async function freePortRange(count: number): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const start = 20000 + Math.floor(Math.random() * 20000); // below the OS ephemeral range so client sockets do not collide with passive ports
    const servers: net.Server[] = [];
    let ok = start + count < 65535;
    for (let i = 0; ok && i < count; i++) {
      const s = net.createServer();
      ok = await new Promise<boolean>((resolve) => { s.once("error", () => resolve(false)); s.listen(start + i, "127.0.0.1", () => resolve(true)); });
      if (ok) servers.push(s);
    }
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    if (ok) return start;
  }
  throw new Error("no free port range");
}

/** A plain ftp-srv instance (default filesystem rooted at `root`) used as an independent FTP server for client tests. */
/* eslint-disable @typescript-eslint/no-explicit-any -- ftp-srv's typings do not cover pasv_url/log used here */
export async function startPlainFtpServer(root: string, port: number, user = "u", pass = "p") {
  const mod: any = await import("ftp-srv");
  const FtpSrv = mod.default?.default ?? mod.default ?? mod.FtpSrv;
  const quiet: any = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return quiet; } };
  const pasvMin = await freePortRange(31);
  const srv = new FtpSrv({ url: `ftp://127.0.0.1:${port}`, pasv_url: "127.0.0.1", pasv_min: pasvMin, pasv_max: pasvMin + 30, anonymous: false, log: quiet });
  srv.on("login", ({ username, password }: any, resolve: any, reject: any) => (username === user && password === pass ? resolve({ root }) : reject(new Error("bad credentials"))));
  await srv.listen();
  return srv as { close(): Promise<void>; listen(): Promise<void> };
}

export async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}
