# Architecture

```mermaid
flowchart LR
  subgraph Clients
    B[Browser player / admin]
    V[VLC, TV, phone via share link]
    F[FTP clients]
  end
  B -->|cookie session| S
  V -->|/s/token/raw| S
  F -->|ftp :2121 read-only| FS[ftp-server.ts]
  subgraph StreamNest
    S[server.ts<br/>routing, API] --> A[auth.ts<br/>sessions, rate limit,<br/>signed links]
    S --> R[sources/index.ts<br/>LibraryRegistry]
    S --> ST[stream.ts<br/>Range parsing + piping]
    S --> IDX[indexer.ts<br/>search index]
    FS --> R
    R --> L[local.ts<br/>disk, UNC, mounts]
    R --> M[smb.ts<br/>SMB 2.1 client]
    R --> P[ftp.ts<br/>basic-ftp pool]
    L & M & P --> G[safe.ts<br/>one path-escape guard]
    S --> T[tunnel.ts<br/>cloudflared]
    CFG[(config.json)] --> S
    CLI[cli.ts add/list/remove/set-password] --> CFG
    CFG -. polled every 1.5 s .-> S
    K[(data/secret.key)] --> A
    K --> C[crypto.ts<br/>AES-256-GCM, scrypt]
  end
  L --> D[(local disks, UNC shares)]
  M --> N[(NAS / PC via SMB)]
  P --> X[(FTP / FTPS servers)]
  T --> W((trycloudflare.com))
```

## Modules

| File | Responsibility |
|---|---|
| `src/server.ts` | HTTP server, routing, admin API, hot reload (`applyConfig`), startup. Pages: `/` player, `/admin`, `/guide`, `/s/<token>` share pages. |
| `src/config.ts` | Types, hand-written validation, atomic load/save of `config.json`. |
| `src/auth.ts` | Password sessions (httpOnly cookie, hashed tokens in `data/sessions.json`), 5/min login limiter, HMAC-signed share links with a revocable record store (`data/shares.json`), localhost-only rule when no password is set. |
| `src/crypto.ts` | `data/secret.key`, HKDF-derived keys (links, stored credentials), AES-256-GCM, scrypt password hashes. |
| `src/sources/types.ts` | The `Source` interface every backend implements. |
| `src/sources/safe.ts` | The single path guard: rejects `..`, NUL, drive letters/streams (Windows), re-checks with `path.relative`. Used by local, SMB, FTP and static files. |
| `src/sources/local.ts` | Local disks, UNC paths and mounts. Follows symlinks only if they stay inside the library. |
| `src/sources/ftp.ts` | `basic-ftp` with a per-library connection pool; ranges via `REST`. |
| `src/sources/smb.ts` | `@awo00/smb2` behind a small backend interface (testable with a fake). |
| `src/sources/index.ts` | `createSource` factory and the hot-swappable `LibraryRegistry`. |
| `src/stream.ts` | `parseRange` and `serveFile`: 200/206/416, HEAD, download mode. `TODO(transcode)` hook lives here. |
| `src/indexer.ts` | Background name index for "All libraries" search and file counts. |
| `src/libraries.ts` | Add/remove logic shared by CLI and admin API (dedupe, path normalization). |
| `src/ftp-server.ts` | Optional read-only FTP server (`ftp-srv`) exposing libraries as folders. |
| `src/tunnel.ts` | Starts `cloudflared`, parses the public URL, refuses to run without an admin password. |
| `src/smb-share.ts` | `npm run smb:share`: prints/applies OS-native read-only SMB shares. |
| `src/cli.ts` | `add`, `list`, `remove`, `set-password`. |
| `src/util/` | `net.ts` (LAN IPs, drive list, folder browser), `async.ts` (timeouts). |
| `public/` | Player (`index.html`), `admin.html`, `assets/share.js` (share dialog, clipboard fallbacks), `assets/qrcode.js` (vendored, MIT). No build step. |

## Request flow: seeking in a video

1. Browser requests `/api/stream?lib=…&path=…` with `Range: bytes=100000000-`.
2. `server.ts` checks the session cookie, finds the library in the registry.
3. `serveFile` calls `source.stat`, `parseRange`, writes `206` + `Content-Range`, then `source.read(path, {start,end})`.
4. The source opens a ranged read (file offset / FTP `REST` / SMB block offset) and the stream is piped to the response; closing the tab destroys the pipeline.

## Security model

- One master (admin) password; sessions are random tokens stored hashed. Cookies are `HttpOnly; SameSite=Lax` (`Secure` behind HTTPS).
- Share links: `base64url(payload).base64url(HMAC-SHA256)`; valid only if the signature matches, not expired and the record exists and is not revoked.
- Remote passwords are AES-256-GCM encrypted with a key derived from `data/secret.key`; API responses are built from allow-lists and never include them. Logs strip query strings and share tokens.
- No password configured ⇒ only direct localhost requests are accepted (requests carrying proxy headers are refused), so a tunnel can't expose an open server. Online mode additionally refuses to start without a password.
