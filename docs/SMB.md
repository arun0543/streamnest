# SMB

StreamNest talks SMB in two directions. This page records what is built, what was tested, and why.

## Decision record

| Question | Decision |
|---|---|
| Which client library? | `@awo00/smb2` (1.1.1, 2025): the only maintained fork. `@marsaud/smb2`, `v9u-smb2` and `smb2` were last updated in 2022 and break on Node 17+. |
| What does it support? | SMB 2.0.2 / 2.1 dialects, NTLM login, directory listing, reads. **No SMB3, no signing, no encryption.** The package has no offset read; StreamNest reads one 64 KiB block at a time through its block reader, which is how seeking works. |
| Is that reliable enough to be the only way? | **No.** Windows 11 24H2 and some NAS settings require SMB signing/encryption, which the library cannot do. |
| So what is recommended? | **Windows: UNC path** (`\\server\share\Movies`) as a normal Local library. **Linux: mount with `mount -t cifs`, then add the mount point** as a Local library. The built-in SMB client is an extra for servers that still allow SMB2 without signing (many NAS boxes, Samba with default settings). |
| Serving libraries over SMB? | Not implemented in Node (no production-grade server exists). `npm run smb:share` configures the OS-native share instead. |

### What was verified

- Automated: listing, case-insensitive stat, ranged reads with correct offsets, reconnect on dropped connection, path-escape rejection and error messages are tested against a fake backend (`test/sources.smb.test.ts`).
- Automated, real library: a refused port is reported as "Connection refused".
- Manual: the real client reached the local Windows SMB service, negotiated SMB 2.1 and was rejected at login ("Authentication failed"), which proves the handshake works up to authentication.
- **Not verified:** listing and streaming against a real NAS with real credentials. Please try yours; if it fails, use the UNC/mount routes below.

## Use a NAS or another PC as a source

### Windows (UNC, recommended)

```powershell
npm run add -- "\\192.168.1.20\Media\Movies"
```

Windows must be able to open the path already. Test in Explorer. If a login is needed, connect once in Explorer with "Remember my credentials", or:

```cmd
net use \\192.168.1.20\Media /user:USERNAME * /persistent:yes
```

The `*` makes Windows ask for the password. **Do not put the password on the command line** (it shows in process lists and history). StreamNest never runs `net use` for you, so it never handles your Windows share password.

### Linux / Raspberry Pi (mount, recommended)

```bash
sudo apt install cifs-utils            # Fedora: sudo dnf install cifs-utils
sudo mkdir -p /mnt/nas
sudo mount -t cifs //192.168.1.20/Media /mnt/nas -o ro,username=USERNAME,uid=$(id -u)
npm run add -- "/mnt/nas"
```

Persist it: create `/root/.smbcreds` (`chmod 600`) containing

```
username=USERNAME
password=PASSWORD
```

and add to `/etc/fstab`:

```
//192.168.1.20/Media /mnt/nas cifs ro,credentials=/root/.smbcreds,uid=1000,_netdev,x-systemd.automount 0 0
```

Desktop alternative: `gio mount smb://192.168.1.20/Media` mounts under `/run/user/<uid>/gvfs/`; add that folder as Local.

### Built-in SMB client

`/admin` → Add folders → **SMB** tab: host, share, path inside the share, username, password, domain. Press **Test connection**. The password is encrypted with AES-256-GCM (`data/secret.key`) and never returned by the API.

Error messages:

| Message | Meaning |
|---|---|
| Authentication failed | wrong user, password or domain |
| Share not found | wrong share name |
| Host not found / unreachable / refused | name, network or port 445 problem |
| "closed the connection … SMB1 … SMB3" | the server only speaks SMB1, or demands SMB3 signing/encryption. Use UNC/mount |

SMB1 is obsolete and insecure; do not enable it for StreamNest.

## Share your libraries over SMB

```bash
npm run smb:share                 # prints the commands for this OS, changes nothing
npm run smb:share -- --apply      # runs them
```

Only local folders are shared, always **read-only**.

### Windows

Prints one command per library; run them in an **Administrator** PowerShell (or run `--apply` from one):

```powershell
New-SmbShare -Name 'Movies' -Path 'D:\Movies' -ReadAccess 'Everyone'
```

Use `--read-access alice` to restrict to a user. Remove later with `Remove-SmbShare -Name Movies`.

**Map network drive (another Windows PC):** Explorer → This PC → *Map network drive* → folder `\\THIS-PC\Movies` → tick "Connect using different credentials" if needed.

### Linux

Prints a Samba block per library:

```
[Movies]
   comment = StreamNest: Movies
   path = /mnt/hdd/Movies
   read only = yes
   browseable = yes
   guest ok = no
   valid users = alice
```

Manual steps: `sudo apt install samba`, `sudo smbpasswd -a alice`, append the block to `/etc/samba/smb.conf`, `testparm -s`, `sudo systemctl restart smbd` (Fedora: `smb`). `--apply` does this using sudo: it writes `/etc/samba/streamnest.conf`, adds one `include =` line to `smb.conf` (a backup is saved as `smb.conf.streamnest.bak`), checks the config and restarts Samba. `--user NAME` picks the Samba user (default: your login).

`--apply` on Linux has not been run on a real Samba install in this project's test environment; the generated text is unit-tested.

### Connecting from other devices

- **Android:** VLC → Browse → Local network → add `smb://THIS-PC/Movies`; or CX File Explorer → Network → SMB.
- **Windows Explorer:** type `\\THIS-PC\Movies` in the address bar.
- **Linux file managers:** Files/Dolphin → Other locations → `smb://THIS-PC/Movies`.
- **macOS:** Finder → Go → Connect to Server → `smb://THIS-PC/Movies`.
