# If this computer is lost: bringing everything back on another one (September 2026)

Everything runs on one Windows machine behind one Cloudflare Tunnel. That is the biggest single risk, and a second live
machine is a cost decision. What *is* possible without one is a **cold standby**: a written, tested-in-parts recipe to rebuild
on another computer (or a rented server) from what already lives off this machine. Times below are estimates from measured
steps; the whole recipe has not been run end to end on a second computer.

## What survives the loss of this computer

| Thing | Where it lives off this machine |
| --- | --- |
| The code of all six repositories | GitHub |
| The settings each service needs (`.env`) | The `DOTENV_CONTENT` secret of each repository (write-only; the deploy rewrites the file from it) |
| The databases | Encrypted backups in OneDrive (`DeskPlatformBackups`), the newest 1 to 14 generations per service |
| The key to open those backups | `BACKUP_PRIVATE_KEY` in the private `desk_business` repository's secrets, and the owner's password manager |
| The web app | Cloudflare Pages (independent of this machine) |
| The DNS and the tunnel definition | Cloudflare (the tunnel token is in the Cloudflare dashboard, Zero Trust, Networks, Tunnels) |

## What does NOT survive, and what to do about it

- **Redis** holds only counters and caches: start an empty one.
- **desk-oracle's `data\source-snapshots`**: the files themselves are only on this machine; the database rows that point at
  them survive. Snapshots can be re-fetched from their sources.
- **The Windows scheduled tasks** (uptime watch, backups, drift check, registry sync): the task definitions are in
  `ops/machine/tasks/*.xml` in the desk-api repository.

## The recipe (about 2 to 3 hours for someone who has done it once)

1. **A Windows machine** with Node 24, Git, PostgreSQL 17, Docker (for Redis), and the GitHub CLI signed in.
2. **Databases:** create the five databases and users as in `docs/HOSTING-AND-RECOVERY.md`. For each service take the newest
   `backup-*.sql.gz.enc` from OneDrive, decrypt it (`node scripts/decrypt-backup.mjs <file.enc> <private-key.pem> <out.gz>`;
   the private key comes from the secret or the password manager), and load it (`docs/BACKUP-RESTORE.md`). The registry
   database is the largest (about 1.1 GB compressed; allow an hour to load).
3. **Runners:** register one GitHub Actions self-hosted runner per service (labels as in each deploy workflow) on the new
   machine, under the same service account layout as before (`ops/machine/README.md`).
4. **Services:** run each repository's *Deploy* workflow. Each one checks out, installs, builds and starts the service from its
   own live folder under its supervisor. Order: desk-oracle, registry-api, market-validation-api, desk-api.
5. **The tunnel:** on the new machine run `cloudflared tunnel run --token <the tunnel token>`. The public hostnames
   (`api.`, `oracle.`, `compliance-api.`) keep working with no DNS change, because they point at the tunnel, not at a machine.
   Remove the old connector in the dashboard if the old machine is gone for good.
6. **Watch and back up:** import the scheduled tasks from `ops/machine/tasks`, and run `scripts/run-live-checks.ps1` to confirm.

## Cheaper protection worth having now

- The tunnel already reconnects on its own if the connection drops; a watchdog restarts the process every 5 minutes if it
  dies. A second connector on the same machine adds nothing against a machine failure, so none is run.
- The uptime watch alerts within about 4 minutes if the public API stops answering (desktop notification today; an e-mail
  or webhook address in `scripts/alerts.json` would reach the owner away from the computer).
- Keep the private backup key somewhere that is not this computer (done: a repository secret, plus the owner's password manager).
