# Bad release? How desk-api protects itself and how to undo one

## What happens automatically on every deploy

1. **Unapplied migrations stop the deploy.** Deploys never change the database. Before swapping versions,
   `scripts/check-migrations.ts` compares the migration files in the new version with what the database has recorded.
   If any are missing the deploy stops with the list, and **the running version is not touched**. Apply them first:
   `npm run migrate -- --dry-run --production --env-file <deployed .env>`, then again without `--dry-run`, then re-run
   the deploy. (Migrations are additive by rule, so the old version keeps working after they are applied.)
2. **The old version keeps serving while the new one is built.** The service runs from its own live copy
   (`C:\actions-runners\desk-api\_work\live`); the previous `dist` and `library-ui` are kept next to it as `*.prev`.
3. **A version that does not start is refused by the deploy itself.** The service runs under a small supervisor
   (`src/supervisor.ts`, see below). A new version starts beside the current one; if it is not ready within 45 seconds
   it is discarded, the previous files are put back, and the deploy is reported as failed. **The current version never
   stopped serving.** (Only when the supervisor is not running, for example the first deploy after a reboot, is the
   old stop/start path used: not healthy within 60 seconds means the previous version is restored and started.)

## How a deploy swaps versions without a gap

`npm run start:prod` starts `dist/supervisor.js`, which runs the real server (`dist/server.js`) as a worker and listens
on `127.0.0.1:3468` for control requests. A deploy copies the new files over `dist/` and asks the supervisor to reload:
a new worker starts and joins the same port; once it reports ready, the old worker answers with `Connection: close` for
about 2.5 seconds (so clients move to new connections), stops taking requests, finishes the ones in flight and exits.
Checked with steady traffic through 8 consecutive reloads: no request failed.

A **full restart** (a few seconds of downtime) still happens when: dependencies changed (`package-lock.json`), the
supervisor's own code changed, or no supervisor is running. The deploy log says which one applies. To look at it:
`curl http://127.0.0.1:3468/status`.

## Undoing a release that started fine but is wrong

Actions -> **Rollback** -> Run workflow (or, as the service's account, `scripts/rollback.ps1`). It swaps the current and previous versions
and has the supervisor start the previous one beside the current one, so there is no gap (without a supervisor it
stops and starts the service, about 10 seconds). Running it again swaps back.
Only the code goes back: **database migrations are not undone**, which is safe because every migration is additive and
the previous code ignores new tables and columns. If a migration itself must be reversed, its file starts with a
`Rollback:` comment holding the exact statements.

To go back further than one release, revert the commit on `main` and run Deploy.

## What is not covered

- A change to `package.json` dependencies replaces `node_modules` for good; rolling back the code does not restore the
  old packages (the lockfile is the same only if it did not change). If the release changed dependencies, prefer
  reverting the commit and deploying.
- Settings (`DOTENV_CONTENT`) are not versioned by the deploy: change them in the GitHub secret and deploy again.
