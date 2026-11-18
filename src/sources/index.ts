import { decrypt } from "../crypto.ts";
import type { Library } from "../config.ts";
import { FtpSource } from "./ftp.ts";
import { LocalSource } from "./local.ts";
import { SmbSource } from "./smb.ts";
import type { Source } from "./types.ts";

export interface SourceContext {
  /** Key for decrypting stored SMB/FTP passwords (see crypto.ts deriveKey(secret, "credentials")). */
  credKey: Buffer;
}

function password(enc: string, ctx: SourceContext): string {
  return enc === "" ? "" : decrypt(enc, ctx.credKey);
}

export function createSource(lib: Library, ctx: SourceContext): Source {
  switch (lib.kind) {
    case "local":
      return new LocalSource(lib.path);
    case "smb":
      return new SmbSource({
        host: lib.host, share: lib.share, path: lib.path, domain: lib.domain, username: lib.username,
        password: password(lib.passwordEnc, ctx), ...(lib.port ? { port: lib.port } : {}),
      });
    case "ftp":
      return new FtpSource({
        host: lib.host, port: lib.port, secure: lib.secure, username: lib.username, password: password(lib.passwordEnc, ctx),
        basePath: lib.basePath, maxConnections: lib.maxConnections, ...(lib.allowSelfSigned ? { allowSelfSigned: true } : {}),
      });
  }
}

/** A source that failed to build (e.g. undecryptable password) so one bad library cannot break the rest. */
class BrokenSource implements Source {
  readonly kind: "local" | "smb" | "ftp";
  constructor(kind: "local" | "smb" | "ftp", private reason: string) { this.kind = kind; }
  async list(): Promise<never> { throw new Error(this.reason); }
  async stat(): Promise<never> { throw new Error(this.reason); }
  async read(): Promise<never> { throw new Error(this.reason); }
  async test(): Promise<{ ok: false; error: string }> { return { ok: false, error: this.reason }; }
  async close(): Promise<void> {}
}

interface Mounted {
  lib: Library;
  source: Source;
}

/** Holds the live libraries; `reload` swaps them without restarting the server. */
export class LibraryRegistry {
  private mounted = new Map<string, Mounted>();

  constructor(private ctx: SourceContext) {}

  async reload(libs: Library[]): Promise<void> {
    const old = this.mounted;
    const next = new Map<string, Mounted>();
    for (const lib of libs) {
      let source: Source;
      try {
        source = createSource(lib, this.ctx);
      } catch {
        source = new BrokenSource(lib.kind, "Stored password cannot be decrypted (data/secret.key changed?). Re-add this library.");
      }
      next.set(lib.id, { lib, source });
    }
    this.mounted = next;
    await Promise.allSettled([...old.values()].map((m) => m.source.close()));
  }

  get(id: string): Mounted | undefined {
    return this.mounted.get(id);
  }

  list(): Mounted[] {
    return [...this.mounted.values()];
  }

  async close(): Promise<void> {
    await this.reload([]);
  }
}
