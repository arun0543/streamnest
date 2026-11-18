import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { defaultConfig } from "../src/config.ts";
import { hashPassword } from "../src/crypto.ts";
import { assertOnlineAllowed, parseTunnelUrl, startTunnel } from "../src/tunnel.ts";

test("parseTunnelUrl finds the trycloudflare URL in cloudflared's log noise", () => {
  const line = "2026-11-12T10:00:00Z INF |  https://quiet-river-lamp-9x.trycloudflare.com                      |";
  assert.equal(parseTunnelUrl(line), "https://quiet-river-lamp-9x.trycloudflare.com");
  assert.equal(parseTunnelUrl("INF Starting tunnel"), null);
});

test("online mode refuses to start without an admin password", () => {
  assert.throws(() => assertOnlineAllowed(defaultConfig()), /admin password/i);
  assert.doesNotThrow(() => assertOnlineAllowed({ ...defaultConfig(), admin: { passwordHash: hashPassword("longenough") } }));
});

function fakeSpawn() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), killed: false, kill() { this.killed = true; return true; } });
  return { child, spawn: ((..._args: unknown[]) => child) as never };
}

test("startTunnel resolves with the URL printed on stderr, and stop() kills the process", async () => {
  const { child, spawn } = fakeSpawn();
  const p = startTunnel({ port: 8080, spawn });
  child.stderr.write("INF Requesting new quick Tunnel\n");
  child.stderr.write("INF https://abc-def-ghi.trycloudflare.com\n");
  const t = await p;
  assert.equal(t.url, "https://abc-def-ghi.trycloudflare.com");
  t.stop();
  assert.equal(child.killed, true);
});

test("startTunnel gives an install hint when cloudflared is missing", async () => {
  const { child, spawn } = fakeSpawn();
  const p = startTunnel({ port: 8080, spawn });
  child.emit("error", Object.assign(new Error("spawn cloudflared ENOENT"), { code: "ENOENT" }));
  await assert.rejects(p, /cloudflared was not found.*winget/s);
});

test("startTunnel fails if cloudflared exits early or never prints a URL", async () => {
  const a = fakeSpawn();
  const early = startTunnel({ port: 1, spawn: a.spawn });
  a.child.emit("exit", 1);
  await assert.rejects(early, /exited early/);
  const b = fakeSpawn();
  await assert.rejects(startTunnel({ port: 1, spawn: b.spawn, timeoutMs: 50 }), /did not report/);
  assert.equal(b.child.killed, true);
});
