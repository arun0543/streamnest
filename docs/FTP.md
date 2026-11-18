# FTP

## FTP as a source (client)

`/admin` → Add folders → **FTP** tab (or an entry in `config.json`):

| Field | Notes |
|---|---|
| Host, port | default 21 (990 for implicit FTPS) |
| Security | `none` (plain FTP), `explicit` (FTPS via AUTH TLS), `implicit` (FTPS on 990) |
| Username / password | blank user = `anonymous`. The password is stored AES-256-GCM encrypted and never returned by the API |
| Base path | the library root on the server, default `/` |
| Allow self-signed certificate | off by default; turn on for NAS boxes with their own certificate |

Press **Test connection** before adding. Messages: wrong username/password, host not found, connection refused, unreachable (timed out), base path not found, TLS problem.

How it works (`src/sources/ftp.ts`):

- Library: `basic-ftp`. Seeking uses the FTP `REST` offset (`downloadTo(stream, path, startAt)`). Bytes after the end of the requested range are not forwarded and the connection is dropped (an FTP transfer cannot be stopped any other way), so each range request costs a reconnect. Fine for video seeking; not tuned for heavy scrubbing.
- FTP allows one transfer per connection, so each library has a pool (default 2 connections) with a 30 s idle timeout. Extra requests queue.
- A dropped connection is retried once on a fresh one.
- `..` is rejected by the same path guard used for every source.

## Built-in FTP server (optional, off by default)

Exposes every library, read-only, as a top-level folder. Configure in `/admin` or `config.json`:

```json
"ftpServer": { "enabled": true, "port": 2121, "passivePorts": [40000, 40100], "username": "streamnest", "passwordHash": "…" }
```

(`passwordHash` is written for you when you set the password in the admin page; the FTP password is separate from the admin password and must be at least 8 characters.)

- The server will not start without a password.
- Read-only twice over: `STOR STOU APPE DELE MKD RMD RNFR RNTO SITE ALLO` are blacklisted and the file system rejects writes. Uploads, deletes, renames and folder changes fail (tested).
- 10 failed logins per minute per IP are blocked.
- On start the terminal prints `ftp://<lan-ip>:2121`.
- Uses the optional dependency `ftp-srv` (last released 2023). If it is not installed, the server reports that and everything else keeps working.
- **Plain FTP is unencrypted**: use it on your home network only and never forward the ports to the internet.

### Ports and firewall

Clients use the control port (default **2121**) and, for each transfer, a **passive** port from your range (default **40000–40100**). Both must be reachable.

Windows (Administrator PowerShell):

```powershell
New-NetFirewallRule -DisplayName "StreamNest FTP" -Direction Inbound -Protocol TCP -LocalPort 2121,40000-40100 -Action Allow -Profile Private
```

The default range is deliberately below 49152, the start of the ports Windows and Linux hand out to outgoing connections: the FTP library only probes five ports in a row, so a range inside the ephemeral area can run out of free ports.

If the server fails with "Unable to find valid port", Windows may have reserved that range. Check with `netsh int ipv4 show excludedportrange protocol=tcp` and choose a range outside those lines (for example 41000–41100).

Linux:

```bash
sudo ufw allow from 192.168.0.0/16 to any port 2121,40000:40100 proto tcp
# Fedora / firewalld
sudo firewall-cmd --add-port=2121/tcp --add-port=40000-40100/tcp --permanent && sudo firewall-cmd --reload
```

Ports below 1024 need root on Linux; keep the default 2121.

### Connecting

- VLC: Media → Open Network Stream → `ftp://streamnest@192.168.x.x:2121/Movies/film.mkv` (it asks for the password).
- Windows Explorer: address bar `ftp://192.168.x.x:2121`.
- Android: any FTP client or VLC → Local network → FTP.
- Command line: `curl --user streamnest ftp://192.168.x.x:2121/Movies/`.
