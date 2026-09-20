# Where the platform runs, what can fail, and how to get it back

Everything server-side runs on **one Windows machine** (this one). That is a deliberate, cheap choice, and it means one
machine is a single point of failure. This page says exactly what depends on it, what happens when it is off, and the
order to bring things back. Nothing here contains a secret.

## What runs where

| Piece | Where | How it starts | Port |
| --- | --- | --- | --- |
| desk-api (this repo) | this machine, from `C:\actions-runners\desk-api\_work\live` | GitHub Actions deploy (`deploy.yml`) | 3458 |
| registry-api | this machine | its own deploy workflow | 3456 |
| market-validation-api | this machine | its own deploy workflow | 3457 |
| compliance-os | this machine | its own deploy workflow | 3000 |
| desk-oracle | this machine | its own service task | 3459 |
| PostgreSQL 17 (all five databases) | this machine, Windows service `postgresql-x64-17` | automatic | 5432 |
| Redis (one container per service) | Docker Desktop on this machine | Docker | various |
| Cloudflare Tunnel (`desk-local-services`) | this machine, `cloudflared.exe` | watchdog task `Desk Watchdog Boot` restarts it every 5 minutes | outbound only |
| Web app (`app.deskbusiness.co`) | Cloudflare Pages (not this machine) | deployed by the desk_business `Deploy` workflow | n/a |
| DNS, TLS, HTTP→HTTPS, the tunnel's public side | Cloudflare | managed | n/a |
| GitHub (code, Actions, secrets `DOTENV_CONTENT`) | GitHub | managed | n/a |

Only `api.deskbusiness.co` (desk-api) is published through the tunnel; the other services are reachable only from
this machine and through desk-api's API Library.

## What happens when something fails

| It fails | People see | Recovers by itself? |
| --- | --- | --- |
| One service process dies | Its part of the API errors; desk-api reports it in `/health/ready` (`degraded`) and Prometheus (`desk_dependency_up`); the uptime watch alerts after about 4 minutes | **No.** Nothing restarts services locally on purpose (a locally started process blocks the deploy pipeline). Run its `deploy.yml` (Actions → Deploy → Run workflow). |
| desk-api dies | `api.deskbusiness.co` answers Cloudflare's 502; the web app cannot sign in | No: run desk-api's `deploy.yml` |
| The tunnel process dies | Every public API call fails; the sites on Pages still load | Yes, within 5 minutes (watchdog) |
| PostgreSQL stops | desk-api answers `/health/ready` 503 and every data call fails; it **keeps running** and reconnects on its own when the database returns | Windows restarts the service; nothing to do in desk-api |
| The machine reboots | Everything is down until it is back | The boot task waits 90 seconds, then runs the deploy workflow for any service whose port is not listening (`boot-recovery-trigger-deploys.ps1`). Expect a few minutes. |
| Power / internet / the machine is lost | Total outage of the API. The web app's pages still load but cannot do anything. | **No** (see below) |
| Cloudflare has an outage | Same as the tunnel being down | When Cloudflare recovers |
| A deploy fails | The old version keeps running (desk-api deploys build first and only then swap) | n/a |

**Deploys** of desk-api normally have **no gap**: the new version starts beside the old one and takes over when it is
ready (see ROLLBACK.md, "How a deploy swaps versions without a gap"). A few seconds of downtime remain only for a full
restart: changed dependencies, a changed supervisor, or the first start after a reboot.

## What restarts what (checked September 2026)

| If this stops | What brings it back | How long | Tested |
| --- | --- | --- | --- |
| The API's worker process (a crash, a kill) | the supervisor starts another at once (backing off if it keeps dying) | seconds | yes, repeatedly (`node scripts/check-supervisor.mjs`) |
| The supervisor itself | the uptime watch: after 3 failed checks in a row (about 6 minutes) it starts the service's own deploy workflow through GitHub, at most once every 30 minutes | about 8 to 10 minutes | the watch's logic yes, 3 rounds against a fake service and fake GitHub (21 checks); not by really killing production |
| The Cloudflare tunnel | the tunnel watchdog task (checks every 5 minutes) | up to 5 minutes | yes, earlier |
| Redis or a database (Docker) | Docker's own restart policy; the services keep answering without Redis (in-memory limits) and reconnect by themselves | seconds after it returns | yes, `npm run check:chaos` (database connections killed) |
| The whole machine (reboot) | the boot task waits 90 seconds, then starts the deploy workflow of any service whose port is not listening | about 5 minutes | not rehearsed (it needs a reboot); it worked on the reboots of 19 and 20 September |

Order after a reboot that matters: Docker Desktop and the database must be up before the services can serve data. The
services start regardless and report `degraded` on `/health/ready` until they are; nothing needs to be started in a
particular order by hand.

## Watching it

`scripts/uptime-watch.ps1`, run every 2 minutes by the `Desk Uptime Watch` task (install with
`scripts/install-uptime-watch.ps1`), checks: the public API and web app, every service on this machine, the tunnel
process, free disk space, and that a recent desk-api backup exists. After two failed checks in a row it raises an
alert (Windows notification, `logs/uptime-watch.log`, and a webhook or email if `scripts/alerts.json` is set up, see
`scripts/alerts.example.json`); when it recovers it says so. **The alert cannot reach anyone if this machine is off or
offline**, so a check from outside the machine (a free uptime service pointed at
`https://api.deskbusiness.co/health/ready`) is the one thing this page cannot replace; setting one up needs an account,
so it is a person's job.

## Bringing everything back after a total loss

The order matters: data first, then services, then the tunnel.

1. **Get a Windows machine**, install PostgreSQL 17, Node 24, Docker Desktop, Git, `cloudflared`, and the GitHub
   Actions runner for each repo (registration tokens come from each repo's Settings → Actions → Runners).
2. **Restore the databases** from the newest backup. Backups are `backup-*.sql.gz` in each repo's `backups\` folder and
   an off-machine copy in the OneDrive folder `DeskPlatformBackups\<repo>` (see `docs/BACKUP-RESTORE.md` for the exact
   restore commands and the rehearsed procedure). Restore desk-api first: it holds every account and session.
   registry-api's database can instead be rebuilt from public sources by its sync task if the backup is lost;
   compliance-os keeps only its newest two copies off-machine.
3. **Create each database and its own limited login first** (`CREATE ROLE ... LOGIN`, `CREATE DATABASE ... OWNER ...`, and revoke `CONNECT` from PUBLIC), so the restore lands in a database owned by that login. The logins' passwords are inside each service's `DOTENV_CONTENT` secret.
4. **Run each service's deploy workflow** (Actions → Deploy → Run workflow). The workflow writes the `.env` from the
   `DOTENV_CONTENT` secret, which is why that secret is stored in GitHub and not only on the machine.
5. **Apply any migrations the deploy does not run**: `npm run migrate -- --production --env-file <the deployed .env>`
   (deploys never run migrations; `--dry-run` first).
6. **Start the tunnel**: run the `Desk Watchdog Boot` task (it holds the tunnel token), or
   `cloudflared tunnel run --token <token>` by hand. The token is in the Cloudflare dashboard (Zero Trust → Tunnels).
7. **Check**: `https://api.deskbusiness.co/health/ready` must say `"ok": true, "degraded": false`.

## Known risks that remain (need a decision, not code)

- **One machine, one internet connection, one power supply.** Moving desk-api and PostgreSQL to a small cloud server
  would remove the biggest risk; the code is portable (Node + Postgres, no machine-specific paths besides the scripts
  in this folder). It costs money and a migration, so it is the owner's call.
- **Backups that live only on this machine's disk or OneDrive** protect against disk failure, not against losing
  this machine and the OneDrive account together.
- **No monitoring from outside the machine** (see above).
