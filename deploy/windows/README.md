# Thuso on a Windows VPS

Thuso runs as one always-on Node process: the agents' engine (waits, schedules,
Moodle syncs every 5 minutes, sheet reads, reply reading) lives inside it, so
it needs a machine that never sleeps. A Windows VPS does that; no paid
"always-on" plan and no keep-awake pings are needed.

## What you need

- The VPS (Windows Server 2019 or newer), with an Administrator login.
- A subdomain, e.g. `thuso.melsoft.org`, with a DNS **A record**
  pointing at the VPS's public IP.
- Node.js 20 LTS or newer and Git, installed on the VPS.
- `caddy.exe` (Windows, amd64) from https://caddyserver.com/download, for HTTPS.

## First install

In PowerShell **as Administrator**:

```powershell
cd C:\
git clone https://github.com/Nagyvee/student-success-colleague.git thuso
cd thuso
Set-ExecutionPolicy -Scope Process Bypass
.\deploy\windows\install.ps1 -Domain thuso.melsoft.org
```

The first run writes `.env.local` and stops. Open it in Notepad, add
`ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY` and the Postgres user and password
(`PGUSER`, `PGPASSWORD`; the `student-success` database already on this VPS),
put `caddy.exe` into
`deploy\windows\`, and run the same command again. It builds the app and
registers three tasks that run with nobody logged in:

| Task | What it does |
|---|---|
| **Thuso** | Starts the app at boot on port 3200 and restarts it if it stops (`run-thuso.ps1`). Logs: `logs\thuso-<date>.log`. |
| **Thuso Backup** | Zips `.data` every night at 02:00 into `backups\`, keeping 14 copies (`backup.ps1`). |
| **Thuso HTTPS** | Caddy serves `https://<your domain>` with a free, auto-renewing certificate and passes traffic to the app. |

### If the VPS already serves another site (e.g. the dialer)

Only one program can use ports 80 and 443. Check with
`netstat -ano | findstr ":443 "`. If something already listens there (IIS,
nginx, or a Caddy serving `dialer.melsoft.org`), do not install a second Caddy:
leave `caddy.exe` out (install.ps1 then skips HTTPS) and add Thuso as one more
site in the server you already have, passing traffic to `localhost:3200`. For
an existing Caddy that is two lines in its Caddyfile:

```
thuso.melsoft.org {
  reverse_proxy localhost:3200
}
```

(IIS: a site for `thuso.melsoft.org` with URL Rewrite + ARR as a reverse proxy
to `http://localhost:3200`.) Also check nothing else uses port 3200; if it
does, pass `-Port 3300` (any free port) to install.ps1 and use that port in
the proxy.

## Moving your current workspace to the VPS

Until now the app ran on a laptop and saved to two places: the `.data` folder
on the laptop, and the VPS's Postgres through an SSH tunnel (port 5433). When
the tunnel was down, changes reached only `.data`. The app now remembers when
each part last reached the database (`.data/db-sync.json`), and on start the
newer copy wins: what changed only in `.data` is sent up instead of being
overwritten.

To move:

1. Stop the app on the laptop for good: from now on only the VPS runs it
   (two copies writing to one database would overwrite each other).
2. Copy the laptop's `.data` folder to `C:\thuso\.data` on the VPS (over
   Remote Desktop; it holds passwords, so do not email it). It includes
   `db-sync.json`, so the VPS knows which parts are newer than its database.
3. Start the **Thuso** task on the VPS. The newer copies from `.data` are sent
   up to Postgres on the first start.

Without step 2 the VPS loads what the database has, which misses everything
done while the tunnel was down.

## Updating

After new code is pushed to GitHub, on the VPS as Administrator:

```powershell
cd C:\thuso
.\deploy\windows\update.ps1
```

It backs up `.data`, pulls, installs, builds and restarts.

## Settings that live on the VPS

Only in `C:\thuso\.env.local` (never in git):

| Key | Value |
|---|---|
| `PUBLIC_BASE_URL` | `https://thuso.melsoft.org`: the links in every email (quiz, video, voucher, unsubscribe). |
| `ANTHROPIC_API_KEY` | The Claude key. |
| `DEEPGRAM_API_KEY` | The voice for videos (optional). |
| `SENDING_PAUSED` | `true` until the team is happy; then `false`, and switch Live Outreach on in Channels & API. |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | The Postgres on this VPS: `127.0.0.1`, `5432`, `student-success`, and its user and password. Everything is also kept in `.data`, which the nightly backup copies. |

Everything else (Moodle, email, escalations, sheets, what the agents know) is
set in the app under **Channels & API** and kept in `.data`.

The sign-in key is made on the first start and kept in `.data/session-secret`:
nothing to set. Keep it in the backups: if it is lost, everyone signs in again
and links in emails already sent stop working.
