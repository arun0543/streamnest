# StreamNest

Lightweight cross-platform home media server to stream video and music from local folders, SMB/network shares, and FTP servers to browsers or VLC. Works on Windows 10/11 and Linux (Ubuntu/Debian, Fedora, Raspberry Pi OS ARM64). No native modules, no build step.

## How to run

### 1. Install Node.js 24 or newer

Download it from <https://nodejs.org>, then check the version in a terminal:

```
node -v
```

It must print `v24` or higher. StreamNest refuses to start on older versions.

### 2. Start the server

Open a terminal in the StreamNest folder (the one containing `package.json`).

**Windows:** double-click `start-windows.bat`. It installs the dependencies on the first run and then starts the server. Or run it by hand in cmd/PowerShell:

```
npm install
npm start
```

**Linux / Raspberry Pi:**

```bash
chmod +x start-linux.sh
./start-linux.sh
```

`npm install` is only needed the first time (and after an update).

### 3. Open it in a browser

The terminal prints the addresses. On the same computer open <http://localhost:8080>. The `LAN:` addresses (for example `http://192.168.1.20:8080`) are for phones, TVs and other computers on your home network.

### 4. Add your media folders

Open <http://localhost:8080/admin> and click *Add folders…* (folder picker, plus SMB and FTP tabs). Or use the command line:

```
npm run add -- "D:/Movies" "E:/Music" "\\NAS\Media"   # add several folders at once
npm run list
npm run remove -- Movies
```

Changes apply without a restart.

### 5. Set a password (needed for other devices)

Without a password only this computer can use the server. To sign in from a phone or TV, set one:

```
npm run set-password
```

### 6. Optional: a public link

To reach the server from outside your home, install [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), set a password (step 5), then start with:

```
npm start -- online
```

On Linux: `./start-linux.sh online`. The terminal prints a `trycloudflare.com` address.

### Stopping and changing the port

- Stop the server with **Ctrl+C** in its terminal.
- The port is the `port` value in `config.json` (default `8080`). Change it and start the server again.
- If something does not work, see [Troubleshooting](docs/TROUBLESHOOTING.md) or the step-by-step guide at <http://localhost:8080/guide>.

## Features

- Multiple libraries from **local folders, UNC paths, SMB shares and FTP/FTPS servers**, with seeking everywhere; "All libraries" search.
- **⋯ → Copy link / LAN link / online link / Open in VLC**, QR code, expiry (1 h, 24 h, 7 d, never), download-only option, revoke from `/admin`. Folder links give a read-only browse page.
- `npm run smb:share` shares your libraries read-only over SMB using the OS (Windows `New-SmbShare`, Linux Samba).
- Optional built-in **read-only FTP server** (off by default).
- Optional **online mode** through a Cloudflare quick tunnel (`npm start -- online`, needs `cloudflared` and an admin password).
- Interactive setup guide at **/guide** (Windows/Linux toggle, copyable commands).

## Documentation

[GUIDE (open /guide)](docs/GUIDE.html) · [Architecture](docs/ARCHITECTURE.md) · [SMB](docs/SMB.md) · [FTP](docs/FTP.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) · [Plan and status](docs/PLAN.md)

## Security notes

- Without an admin password only this computer can use the server.
- Passwords are never put in URLs or logs; stored SMB/FTP passwords are AES-256-GCM encrypted with `data/secret.key` (keep it private and back it up with `config.json`).
- Plain FTP is unencrypted; keep the FTP server on your home network.

## Development

```
npm run typecheck
npm test            # node:test + tsx, includes a local FTP server and FTP-server tests
```

Not included yet: transcoding (a `TODO(transcode)` hook is in `src/stream.ts`).
