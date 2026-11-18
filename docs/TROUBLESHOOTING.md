# Troubleshooting

## Starting

| Symptom | Fix |
|---|---|
| "StreamNest needs Node.js 24 or newer" / `npm install` fails with `EBADENGINE` | Install Node 24: Windows `winget install OpenJS.NodeJS.LTS` (or `nvm install 24 && nvm use 24`); Linux/Pi `nvm install 24`. |
| PowerShell: `npm.ps1 cannot be loaded because running scripts is disabled` | Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force` once in PowerShell. |
| Double-clicking `start-windows.bat` closes at once | Open it from a terminal to read the message; usually Node is missing or too old. |
| `./start-linux.sh: Permission denied` | `chmod +x start-linux.sh`, or run `bash start-linux.sh`. |
| `bad interpreter: ^M` on Linux | The script got Windows line endings. `sed -i 's/\r$//' start-linux.sh`. (`.gitattributes` keeps `.sh` as LF.) |
| `EADDRINUSE` | Port already used. `PORT=9000 npm start` (Linux) or `set PORT=9000 && npm start` (cmd) / `$env:PORT=9000; npm start` (PowerShell), or change `port` in `config.json`. |
| Other devices cannot open the LAN address | Windows Firewall: allow Node.js on Private networks. Linux: `sudo ufw allow 8080/tcp`. Make sure the devices are on the same network. |
| "No admin password set: only this computer can use StreamNest" | Run `npm run set-password`. A running server picks it up. |

## Libraries

| Symptom | Fix |
|---|---|
| Library shows **unreachable** | Drive unplugged, network share asleep or credentials expired. Press **Test** in `/admin` for the reason. |
| Added a folder but nothing is listed | It is probably empty or unreadable by the user running StreamNest. |
| A symlink inside a library does not open | Links that point outside the library are blocked on purpose. Add the target as its own library. |
| `npm run add` says "does not exist" for a UNC path | Open it in Explorer first. In cmd/PowerShell quote it: `"\\NAS\Media"`. Doubled backslashes (`\\\\NAS\\Media`) are repaired automatically. |
| File counts / search results are missing | The first scan runs in the background after start. Use **Rescan** in `/admin`. Scans stop after 250,000 entries or 2 minutes (shown as `123+`). |
| Video plays but seeking fails | The source must support ranges. All built-in sources do; a reverse proxy in front must pass `Range` headers. |
| Browser cannot play `.mkv`/`.avi`/HEVC | Browsers support only some formats. Use **Open in VLC** (⋯ menu). Transcoding is not part of StreamNest yet. |

## Login and links

| Symptom | Fix |
|---|---|
| "Too many attempts" | Login is limited to 5 tries per minute per address. Wait a minute. |
| Link shows "Link unavailable" (403) | It expired, was revoked, or was changed. Make a new one. Deleting `data/shares.json` revokes every link. |
| "Copy link" says "Press Ctrl+C" | The browser blocked clipboard access (plain HTTP). The link is selected in the box; press Ctrl+C (or long-press → Copy on a phone). |
| "Copy online link" is greyed out | Online mode is not running. |
| Logged out after changing `data/secret.key` | Expected: sessions, share links and stored SMB/FTP passwords depend on it. Re-add remote libraries. Back it up with `config.json`. |

## SMB

See [SMB.md](SMB.md). Short version: on Windows use a UNC path, on Linux mount with `mount -t cifs`. "closed the connection … SMB1 … SMB3" means the server needs features the built-in client lacks.

## FTP

| Symptom | Fix |
|---|---|
| Client test: "Login failed" | Wrong user/password; anonymous servers need user `anonymous`. |
| Client test: "TLS problem" | For a self-signed certificate tick "Allow self-signed certificate"; if the server only does plain FTP choose security "FTP". |
| Listing works but playing hangs | Passive mode blocked by a firewall/NAT on the server side. Open the server's passive port range. |
| Built-in FTP server: client connects but listing hangs | The passive port range is blocked by a firewall. See [FTP.md](FTP.md). |
| "Unable to find valid port" | Windows reserved that range (`netsh int ipv4 show excludedportrange protocol=tcp`). Pick another passive range. |
| "FTP server not started: needs a password" | Set an FTP password (8+ characters) in `/admin`. |

## Online mode

| Symptom | Fix |
|---|---|
| "Online mode needs an admin password" | `npm run set-password`, then start with `online` again. |
| "cloudflared was not found" | Windows `winget install Cloudflare.cloudflared`; Linux see https://pkg.cloudflare.com or the GitHub releases. Or set `CLOUDFLARED=/full/path/to/cloudflared`. |
| The URL changes every start | Quick tunnels get a new random address each time. Share links created earlier keep working through the new address only if you re-copy them. |
