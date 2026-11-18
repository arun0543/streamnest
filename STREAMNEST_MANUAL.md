# StreamNest — Complete User & Deployment Guide

Welcome to **StreamNest**, a fast, lightweight, and cross-platform home media streaming and file sharing server. This document provides an all-in-one guide covering everything configured and available in your setup.

---

## 1. Quick Access Cheatsheet

| Target | Address / Command | Credentials / Notes |
| :--- | :--- | :--- |
| **Local Web Player** | [http://localhost:8090](http://localhost:8090) | Direct browser access on host |
| **Admin Dashboard** | [http://localhost:8090/admin](http://localhost:8090/admin) | Manage folders, shares, and settings |
| **LAN Ethernet** | `http://192.168.0.222:8090` | Devices connected to Router 1 |
| **LAN Wi-Fi** | `http://192.168.31.84:8090` | Devices connected to Router 2 |
| **Built-in Network Sharing** | `ftp://192.168.0.222:2121`<br>`ftp://192.168.31.84:2121` | **User:** `streamnest`<br>**Pass:** `123` |
| **Online Cloudflare Tunnel** | `npm start -- online` | Generates a secure public HTTPS link |
| **Default Password** | `123` | Configured in [config.json](file:///media/arun/New%20Volume1/STREAMER/config.json) |

---

## 2. Server Architecture & How It Works

StreamNest acts as both a **Sender** (host/streaming server) and a **Receiver** (connecting to other network shares):

```
┌─────────────────────────────────────────────────────────────┐
│                Desktop Server (StreamNest)                  │
│                                                             │
│  Local Folders (/media/arun/New Volume1/hhhh)               │
│       │                                                     │
│       ├──► StreamNest Core Web Server (Node.js Port 8090)   │
│       ├──► Built-in Network File Server (Port 2121)         │
│       └──► Storage Backend (JSON / SQLite / PostgreSQL)     │
└──────────────────────────┬──────────────────────────────────┘
                           │
             ┌─────────────┴─────────────┐
             ▼                           ▼
   Router 1 (Ethernet)          Router 2 (Wi-Fi)
     192.168.0.222                192.168.31.84
             │                           │
             ▼                           ▼
   Other PCs on LAN             Phones, Tablets, TVs
```

---

## 3. How to Start and Stop the Server

### Normal Mode (Local & Home Wi-Fi Network)
```bash
cd "/media/arun/New Volume1/STREAMER"
npm start
```

### Online Public Mode (Internet Access Anywhere)
```bash
cd "/media/arun/New Volume1/STREAMER"
npm start -- online
```
*Creates a secure `https://<random-name>.trycloudflare.com` tunnel. Allows full streaming and link sharing over mobile data (4G/5G) or outside networks without needing port forwarding.*

### Stop the Server
Press `Ctrl + C` in the running terminal.

---

## 4. Connecting from Phones, TVs, and Other PCs

### A. Mobile Phones & Tablets (Browser Streaming)
1. Connect your phone to Wi-Fi.
2. Open Chrome, Safari, or Firefox on mobile.
3. Visit:
   * If on Wi-Fi (Router 2): **`http://192.168.31.84:8090`**
   * If on Main Network (Router 1): **`http://192.168.0.222:8090`**
   * If outside home: Your active **`https://*.trycloudflare.com`** URL.
4. Enter password: **`123`**.
5. Select the library (e.g. `hhhh`) to stream video and audio directly in your browser.

### B. Smart TV / Android TV (via VLC)
1. Install **VLC Media Player** or **Nova Video Player** on your TV.
2. Go to **Local Network / Browse** ➔ Select **FTP** or **Network Stream**.
3. Enter:
   * **Server Address:** `192.168.0.222` or `192.168.31.84`
   * **Port:** `2121`
   * **Username:** `streamnest`
   * **Password:** `123`
4. All media files appear as browsable folders with instant seek and playback.

### C. Other Windows Laptops / PCs (Network Drive Mapping)
Map the shared media as a virtual drive in Windows:
1. Open **File Explorer** (`This PC`).
2. Right-click empty space ➔ **Add a network location**.
3. Type: `ftp://192.168.0.222:2121` (or `ftp://192.168.31.84:2121`).
4. Enter username: `streamnest` and password: `123`.
5. Browse and copy files just like a local folder.

---

## 5. Multi-Router Wi-Fi Configuration

When your desktop is connected to Router 1 (`192.168.0.222`) and your phone connects to Router 2 (`192.168.31.84`):

1. **Firewall Rule:** Allow ports on your desktop:
   ```bash
   sudo ufw allow 8090/tcp
   sudo ufw allow 2121/tcp
   ```
2. **Access Point (AP) Mode (Best Long-term Setup):**
   * Log into Router 2's settings (`192.168.31.1`).
   * Change operation mode from **Router** to **Access Point (AP) / Bridge Mode**.
   * Connect the Ethernet cable from Router 1 into a **LAN port** of Router 2.
   * Both devices will share the same `192.168.0.x` subnet.

---

## 6. Storage Backend Configuration (Database)

Settings, shares, and session tokens are stored in `data/` as JSON files by default. You can switch to SQLite or PostgreSQL at any time:

### SQLite (Embedded Database)
```bash
STREAMNEST_DB=sqlite npm start
```
*Stores all tables in `data/streamnest.db` using WAL mode.*

### PostgreSQL
```bash
STREAMNEST_DB="postgres://user:password@localhost:5432/streamnest" npm start
```

---

## 7. Command Line Management

You can manage folders from the admin web interface at `/admin` or via the terminal:

```bash
# Add new folders to library
npm run add -- "/media/arun/New Volume1/Movies"

# List active libraries
npm run list

# Remove a library
npm run remove -- Movies

# Change admin password
npm run set-password
```
