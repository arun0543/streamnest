import readline from "node:readline";
import { deriveKey, hashPassword, loadSecret } from "./crypto.ts";
import { loadConfig, saveConfig } from "./config.ts";
import { addLocalFolders, libraryLocation, removeLibraries } from "./libraries.ts";
import { createSource } from "./sources/index.ts";
import { withTimeout } from "./util/async.ts";

/** Prompts without echoing (TTY), or reads one line from piped stdin. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin });
      rl.once("line", (line) => { rl.close(); resolve(line); });
      rl.once("close", () => resolve(""));
      return;
    }
    process.stdout.write(question);
    let value = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (ch: string): void => {
      for (const c of ch) {
        if (c === "\r" || c === "\n" || c === "\u0004") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve(value);
        }
        if (c === "\u0003") process.exit(130);
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else value += c;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function setPassword(): Promise<void> {
  // The password is read interactively (or from stdin), never from argv, so it stays out of shell history.
  const pw = await promptHidden("New admin password (min 8 characters): ");
  if (pw.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }
  if (process.stdin.isTTY && (await promptHidden("Repeat password: ")) !== pw) {
    console.error("Passwords do not match.");
    process.exit(1);
  }
  const config = loadConfig();
  config.admin = { passwordHash: hashPassword(pw) };
  saveConfig(config);
  console.log("Admin password saved. A running server picks it up automatically.");
}

function parseArgs(args: string[]): { positional: string[]; name?: string } {
  const positional: string[] = [];
  let name: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--name" || a === "-n") name = args[++i];
    else if (a.startsWith("--name=")) name = a.slice(7);
    else positional.push(a);
  }
  return name === undefined ? { positional } : { positional, name };
}

async function add(args: string[]): Promise<number> {
  const { positional, name } = parseArgs(args);
  if (positional.length === 0) {
    console.error('Usage: npm run add -- "D:/Movies" "E:/Music" "\\\\NAS\\Media" [--name "My Music"]');
    return 1;
  }
  if (name !== undefined && positional.length !== 1) {
    console.error("--name can only be used when adding a single path.");
    return 1;
  }
  const config = loadConfig();
  const result = await addLocalFolders(config, positional, name);
  if (result.added.length > 0) saveConfig(config);
  for (const l of result.added) console.log(`added    ${l.name}  (${libraryLocation(l)})  id ${l.id}`);
  for (const s of result.skipped) console.log(`skipped  ${s.input}: ${s.reason}`);
  if (result.added.length > 0) console.log("A running server picks this up automatically (no restart needed).");
  return result.added.length === 0 ? 1 : 0;
}

async function list(): Promise<number> {
  const config = loadConfig();
  if (config.libraries.length === 0) {
    console.log('No libraries yet. Add some with: npm run add -- "D:/Movies"');
    return 0;
  }
  const ctx = { credKey: deriveKey(loadSecret(), "credentials") };
  const rows = await Promise.all(
    config.libraries.map(async (l) => {
      const source = createSource(l, ctx);
      const ok = (await withTimeout(source.test(), 5000, { ok: false as const, error: "timed out" })).ok;
      await source.close();
      const where = libraryLocation(l);
      return { id: l.id, name: l.name, kind: l.kind, path: where, status: ok ? "online" : "unreachable" };
    }),
  );
  console.table(rows);
  return 0;
}

function remove(args: string[]): number {
  const { positional } = parseArgs(args);
  if (positional.length === 0) {
    console.error("Usage: npm run remove -- <id|name|path> [...more]");
    return 1;
  }
  const config = loadConfig();
  const r = removeLibraries(config, positional);
  if (r.removed.length > 0) saveConfig(config);
  for (const l of r.removed) console.log(`removed  ${l.name}  (${libraryLocation(l)})`);
  for (const s of r.notFound) console.log(`not found  ${s}`);
  for (const s of r.ambiguous) console.log(`ambiguous  ${s} matches several libraries; use the id from "npm run list"`);
  return r.notFound.length + r.ambiguous.length > 0 && r.removed.length === 0 ? 1 : 0;
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "set-password":
    await setPassword();
    break;
  case "add":
    process.exitCode = await add(rest);
    break;
  case "list":
    process.exitCode = await list();
    break;
  case "remove":
  case "rm":
    process.exitCode = remove(rest);
    break;
  default:
    console.error("Usage: npm run add|list|remove|set-password");
    process.exitCode = cmd ? 1 : 0;
}
