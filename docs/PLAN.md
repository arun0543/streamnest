# StreamNest – Build Plan

Status: **all phases built** (see the notes under each phase and the acceptance results at the bottom). Greenfield build: `D:\STREAMER` was empty, so there is no existing `media-stream` code to preserve. Baseline features from F5 (range streaming, auto-next, breadcrumbs, filter, LAN IP print, cloudflared) are built fresh in Phase 1–2.

## 0. Environment findings

| Item | Finding | Decision |
|---|---|---|
| Node on this machine | v16.20.2 / npm 8.19 (EOL) | **Decision: target Node 24 (LTS).** `engines: ">=24"`; start scripts check the version and print the install hint (Windows: `winget install OpenJS.NodeJS.LTS`; Linux/Pi: NodeSource or `nvm install 24`). **You must install Node 24 before Phase 1.** Built-in `fetch`, `node:test`, `crypto.hkdf`, `fs.glob` etc. available; no polyfills. |
| Test runner | Node 24 also satisfies `vitest` 5 | Still use **`node:test` + `tsx`**: zero extra dependency, and `tsx` handles path/ESM quirks that Node's native type-stripping doesn't. |
| TypeScript | 7.0.2 is latest (native port) | Pin `typescript@^5.9` for stable `tsc --noEmit` + tsx compatibility; revisit later. |

## 1. Package audit (`npm view`, run 2026-11-12)

| Package | Version / last modified | Verdict |
|---|---|---|
| `basic-ftp` | 6.2.6 / 2026-11-04 | **Use.** Active, pure JS, FTP/FTPS, `downloadTo(stream, path, startAt)` supports REST. |
| `ftp-srv` | 4.6.3 / 2023-10 | **Use, with caveat.** Only maintained server option; pure JS; stale and pulls `ip` (known advisory, we only use it for LAN address helper, not untrusted input), `bunyan`, `lodash`, `moment`. Mitigation: devDependency is not enough (server is a runtime feature) so it is an **optionalDependency**, lazy-`import()`ed only when FTP server enabled; read-only enforced by our own `fs` wrapper that rejects every write op. Re-evaluate if it breaks. |
| `@awo00/smb2` | 1.1.1 / 2025-05 | **Candidate, spike required.** Pure TS, Node>=18, only the maintained fork (others: `@marsaud/smb2` 2022, `v9u-smb2` 2022, `smb2` 2022 – abandoned, OpenSSL legacy issues on Node 17+; rejected). Unknown: ranged reads, SMB3 signing/encryption, SMB1-only servers. Phase 5 starts with a 1-hour spike; if ranged `read` is not possible or auth fails vs Samba/Windows, fall back to **mount/UNC strategy** (decision recorded in `docs/SMB.md`). |
| `cloudflared` (npm) | 0.7.3 / 2026-08 | **Not used.** We spawn the `cloudflared` binary the user installs (as in F5) with `child_process`; avoids downloading a binary at install time. |
| `qrcode-generator` | 2.0.4 / 2025-08 | **Use**, vendored into `public/assets/qr.js` (browser, no CDN). Zero deps. |
| `tsx`, `typescript`, `@types/node` | current | devDependencies only. |
| `zod` | 4.6.7 (6 MB) | **Rejected**; hand-written validators in `config.ts` (small schema). |

### Runtime dependencies (each justified)
1. `basic-ftp` – FTP/FTPS client with REST offset. Writing an FTP client is not worth it.
2. `ftp-srv` (optional) – FTP server for F4. Writing one is not worth it.
3. `@awo00/smb2` (optional, pending spike) – SMB client.

Everything else uses Node built-ins: `http`, `crypto` (HMAC, AES-256-GCM, scrypt), `fs`, `path`, `child_process`, `os`, `node:test`.

## 2. Architecture and data model

```
Browser ─HTTP─> server.ts ─> auth.ts (session cookie / signed links / rate limit)
                    │
                    ├─> sources/index.ts (hot-reloadable registry: id -> Source)
                    │       ├ local.ts (fs, UNC, drive list)
                    │       ├ smb.ts   (client or mount fallback)
                    │       └ ftp.ts   (basic-ftp pool)
                    ├─> stream.ts (range parse + pipe, source-agnostic, TODO(transcode))
                    ├─> ftp-server.ts (optional, read-only, wraps Sources)
                    └─> tunnel.ts (cloudflared child process, parses trycloudflare URL)
```

`config.json` (validated on load, atomic write via temp file + rename):
```jsonc
{
  "port": 8080,
  "admin": { "passwordHash": "scrypt$N$r$p$salt$hash" },
  "libraries": [{
    "id": "a1b2c3", "name": "Movies", "kind": "local|smb|ftp",
    "local": { "path": "D:/Movies" },
    "smb":   { "host":"", "share":"", "path":"", "domain":"", "username":"", "passwordEnc":"v1:iv:tag:ct" },
    "ftp":   { "host":"", "port":21, "secure":"none|explicit|implicit", "username":"", "passwordEnc":"…", "basePath":"/", "maxConnections":2 }
  }],
  "ftpServer": { "enabled": false, "port": 2121, "passivePorts":[40000,40100], "username":"streamnest", "passwordHash":"…" },
  "shares": { "revokedBefore": 0, "revoked": ["jti…"] }
}
```
`data/` (git-ignored): `secret.key` (32 random bytes, mode 0600; also used as HMAC key via HKDF with distinct labels), `sessions.json`, cache.

Share token: `base64url(JSON{v,lib,path,exp,mode,kind:"file|folder",jti}) + "." + base64url(HMAC-SHA256)`, constant-time compare, `exp=0` = never (admin only). Revoke = add `jti` to list; revoke-all = bump `revokedBefore`.

## 3. API routes

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/login`, `POST /api/logout` | none / session | httpOnly, SameSite=Lax cookie (`Secure` when behind tunnel https); 5 tries/min/IP |
| `GET /api/libraries` | session | list with status, kind, file count |
| `GET /api/browse?lib&path` | session | directory listing; `lib=all&q=` for cross-library search |
| `GET /api/stream?lib&path` | session | ranged stream |
| `POST /api/share` | session | create signed link (expiry, mode) → `{lan, online, token}` |
| `GET /s/:token`, `/s/:token/raw`, `/s/:token/browse` | token | share player, raw stream, folder browse (read-only) |
| `/api/admin/*` | admin | libraries CRUD, rescan, test, fs browse (`/api/admin/fs?path=`), shares list/revoke, ftp-server settings, tunnel status |
| `GET /admin`, `/guide`, static `/assets/*` | – | admin page requires login |

## 4. Risks and handling

| Risk | Handling |
|---|---|
| Path traversal across sources | One `resolveSafe()` in `sources/safe.ts`. Local: `path.resolve` + `path.relative` must not start with `..` or be absolute; also reject NUL bytes and (Windows) alternate data streams / reserved names; symlink targets re-checked with `realpath`. FTP/SMB: `path.posix.normalize`, reject `..` segments. |
| Passwords leak | No secrets in URLs (cookie sessions, signed tokens only). Request logger logs method + path with query stripped. API DTOs built from allow-lists, never spreading config objects. Test greps for planted secrets in logs/responses. |
| FTP seeking | `downloadTo(stream, path, startAt)`, destroy the data connection after `end-start+1` bytes; pooled client discarded (not reused) after an aborted transfer. Verified by automated test against local `ftp-srv`. |
| `ftp-srv` is stale | Optional dep, lazy-loaded, read-only wrapper, documented. |
| SMB lib unproven | Spike gate at start of Phase 5; documented fallback (UNC / `mount -t cifs`). Acceptance criterion can be met either way. |
| Raspberry Pi ARM64 / native modules | No native modules planned. |
| Clipboard on HTTP LAN | `navigator.clipboard` → hidden textarea + `execCommand('copy')` → selectable box. Manual test on Chrome Android + Firefox. |
| Tunnel + cookies | Share links and raw streams don't need cookies. Online mode refuses to start without admin password. |
| Windows `net use` with credentials | Optional, documented trade-off (password visible in process list briefly); uses stdin-free arg array, never logged. |
| CRLF/LF | `.gitattributes`: `*.bat eol=crlf`, `*.sh eol=lf`. `chmod +x` documented for Linux; script also runnable via `bash start-linux.sh`. |

## 5. Phases and acceptance criteria

Each phase ends with `npm run typecheck` and `npm test` green, then tick below.

- [x] **Phase 1 – Scaffold + core.** *(Done: 18 tests pass, typecheck clean, `npm start` verified on Node 24.22.2 / Windows; Linux not yet run.)* `package.json` (scripts via Node only), `tsconfig` strict, `.gitignore`, `.gitattributes`, start scripts, `config.ts`, `sources/types.ts`, `safe.ts`, `local.ts`, `stream.ts`, `server.ts`, minimal `public/index.html`.
  *Accept:* `npm start` serves UI at `http://localhost:8080` on cmd, PowerShell and bash; local library lists + streams; `Range: bytes=100-199` returns 206 with correct `Content-Range`; invalid range → 416; `test/path-guard.test.ts` (win32 + posix, UNC, drive roots, `..`, NUL) and `test/range.test.ts` pass.
- [x] **Phase 2 – Auth + share links.** *(Done: 40 tests pass, typecheck clean. Notes: share records/revocation live in `data/shares.json`, not `config.json`; with no password set only direct localhost requests are allowed (proxied/tunnel requests are refused); `npm run set-password` added early; a single password means every logged-in user is admin, so "never" expiry is not yet restricted.)* `crypto.ts`, `auth.ts`, login/session, rate-limit, signed links, revoke.
  *Accept:* `test/auth.test.ts`: valid link 200, expired 403, tampered 403, revoked 403, download-only blocks `/s/:t` player but allows download; 6th login in a minute → 429; `secret.key` created on first run; encrypt/decrypt round-trips; wrong-key decrypt fails.
- [x] **Phase 3 – Multi-folder CLI + admin + hot reload.** *(Done: 61 tests pass, typecheck clean; admin page checked in the browser pane (drive list, library table, no console errors). Config changes from the CLI/admin hot-reload via 1.5 s polling of config.json. SMB/FTP tabs in the add dialog are disabled placeholders until Phases 5–6. Share-link UI in /admin lists and revokes; player copy-link UI is Phase 4.)* `cli.ts` (add/remove/list/set-password; multiple paths; dedupe; skip missing), `admin.html`, server-side folder browser (drive list A–Z on Windows, `/`, `/media`, `/mnt`, `$HOME` on Linux), "All libraries" search.
  *Accept:* `npm run add -- "D:/Movies" "E:/Music" "\\\\NAS\\Media"` adds existing ones and reports the rest; picker adds several at once; libraries appear in player without restart; status badge shows unreachable for a missing path; `test/sources.local.test.ts`.
- [x] **Phase 4 – Player UI: copy link, QR, folder links.** ⋯ menu (Copy link, LAN, online, Open in VLC), clipboard fallbacks, toast, QR via vendored lib, folder share browse page, source icons, auto-next, breadcrumbs, filter.
  *Accept:* link copies on `http://192.168.x.x` in Chrome Android and Firefox desktop (manual); `/s/<token>/raw` plays in VLC with seeking (manual); QR scans on phone.
- [x] **Phase 5 – SMB.** Spike on `@awo00/smb2` (ranged read, Samba + Windows share, error mapping). Implement `smb.ts` or mount/UNC fallback; `npm run smb:share` (`--apply`), `docs/SMB.md`.
  *Accept:* connection test returns distinct errors (auth failed, share not found, unreachable, SMB1-only); SMB library lists + seeks, or documented mount path works; `smb:share` prints correct Windows (`New-SmbShare`) / Linux (`smb.conf` block) commands for `process.platform`.
- [x] **Phase 6 – FTP client.** `ftp.ts` with pool (per-library max, idle timeout, retry), FTP/explicit/implicit FTPS.
  *Accept:* `test/sources.ftp.test.ts` spins local `ftp-srv`, lists, reads a middle range byte-exact, then reads another range on the pool; killed connection recovers via retry.
- [x] **Phase 7 – Built-in FTP server.** `ftp-server.ts`, admin settings, startup address print, `docs/FTP.md`.
  *Accept:* libraries appear as top-level folders; STOR/DELE/RNFR/MKD/RMD rejected (test with `basic-ftp` client); download works; disabled by default.
- [x] **Phase 8 – Tunnel / online mode.** `tunnel.ts`, refuse without admin password, share links use tunnel URL.
  *Accept:* start without password in online mode exits non-zero with message; with password, tunnel URL parsed from cloudflared output (unit-tested with fake stdout) and used by "Copy online link".
- [x] **Phase 9 – Docs + guide + final audit.** `docs/GUIDE.html` (OS toggle, live commands, Copy buttons; sections for folders, links/QR, SMB, FTP) served at `/guide`, `ARCHITECTURE.md` (mermaid), `TROUBLESHOOTING.md`, README; password-leak grep test; final acceptance checklist run and reported.
  *Accept:* every checkbox in the original acceptance list reported pass / manual-needed.

`// TODO(transcode)` hook added in `stream.ts` in Phase 1. No ffmpeg anywhere.

## 6. Open questions (blocking)

1. ~~Node upgrade~~ **Resolved: Node 24.**
2. **SMB server-side** (`npm run smb:share --apply`) and FTP server can only be tested for real on your machine; do you have a NAS/second PC, or should SMB client verification be Windows UNC + Samba only if available? *(Unanswered; built with the UNC/mount-first approach and the native client as an extra. See section 7.)*

## 7. Build notes per phase (added after building)

- **Phase 4:** share dialog (`public/assets/share.js`) with expiry, download-only, Copy link / LAN / online, Open in VLC, QR (vendored `qrcode-generator`, no CDN) and clipboard fallbacks (Clipboard API, then `execCommand`, then a selected text box). Checked in the browser pane: dialog, QR, VLC URL, fallback message, share page, Range 206, tampered link 403. **Not tested on Chrome Android / Firefox desktop over `http://192.168.x.x`** (needs your devices).
- **Phase 5:** `@awo00/smb2` is SMB 2.0.2/2.1 only (no signing or encryption), so the documented recommendation is UNC (Windows) or `mount -t cifs` (Linux), with the native client as an extra. Verified against fakes and up to the login step of this PC's real SMB service; **not** against a real NAS with credentials. `npm run smb:share` prints (or with `--apply` runs) read-only shares; its output is unit-tested, `--apply` was not run.
- **Phase 6:** `basic-ftp` pool plus REST seeking, tested against a local `ftp-srv` (byte-exact ranges, concurrent reads, server-restart recovery, error messages). `stat` looks entries up in the parent listing because `SIZE` on a directory is inconsistent across servers.
- **Phase 7:** read-only FTP server tested with `basic-ftp` as the client: uploads, deletes, mkdir, rename and rmdir are rejected; REST seek works; disabled by default; refuses to start without a password.
- **Phase 8:** `tunnel.ts` plus the `online` start argument; URL parsing and the no-password refusal are unit-tested with a fake `cloudflared`. **Not run against the real cloudflared binary.**
- **Phase 9:** README, GUIDE.html (checked in the browser: OS toggle, live commands, copy buttons), ARCHITECTURE, SMB, FTP, TROUBLESHOOTING.
- The test script uses `--test-force-exit`: a passive-mode listener left behind by the *test* FTP servers (third-party `ftp-srv`) would otherwise keep the process alive.

