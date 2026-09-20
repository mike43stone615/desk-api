# Machine-level scripts and scheduled tasks

Everything that keeps the platform running on this Windows machine but is not part of a service's own code, kept in
version control so it can be reviewed, restored and rebuilt. **No secrets are stored here.**

| File | What it does |
| --- | --- |
| `watchdog-desk-local-services.ps1` | Restarts the Cloudflare tunnel if it dies (checked every 5 minutes) |
| `boot-recovery-trigger-deploys.ps1` | After a reboot, runs the deploy workflow for any service that is not listening |
| `run-tunnel.cmd` | Starts the tunnel by hand |
| `start-desk-local-services.ps1` | Legacy: starts services directly. Not used any more (it would resurrect stale code); kept for reference |
| `tunnel-ingress-config.json` | A record of the tunnel's routing (the Cloudflare dashboard is the real control plane; the ids are removed) |
| `tasks\*.xml` | The scheduled tasks (backups, drift check, uptime watch, watchdog, boot recovery, oracle, registry sync) |
| `install.ps1` | Copies the scripts to `%USERPROFILE%\.cloudflared` and (with `-RegisterTasks`) recreates the tasks |

## Two things you must create by hand (never committed)

1. `%USERPROFILE%\.cloudflared\desk-local-services.token`: the tunnel's token (Cloudflare dashboard -> Zero Trust -> Networks -> Tunnels).
2. `%USERPROFILE%\Downloads\api.txt` containing a line `GITHUB_RUNNER_REGISTRATION_PAT_2=<token>`: a GitHub token with Actions read/write on the repos (used by the boot recovery script).

## Rebuilding this machine's automation

```powershell
cd <repo>\ops\machine
.\install.ps1 -RegisterTasks
```

Tasks that run at start-up or with elevated rights (`Desk Watchdog Boot`, `Desk Oracle Service`) can only be created from
an **Administrator** PowerShell; the installer names any it could not register, so run it once elevated to add them.

Keep this folder as the source of truth: change a script here, commit, run `install.ps1`. The test
`src/__tests__/opsMachine.test.ts` fails if anything in this folder looks like a secret.
