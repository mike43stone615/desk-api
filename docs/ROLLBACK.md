# Bad release? How desk-api protects itself and how to undo one

## What happens automatically on every deploy

1. **Unapplied migrations stop the deploy.** Deploys never change the database. Before swapping versions,
   `scripts/check-migrations.ts` compares the migration files in the new version with what the database has recorded.
   If any are missing the deploy stops with the list, and **the running version is not touched**. Apply them first:
   `npm run migrate -- --dry-run --production --env-file <deployed .env>`, then again without `--dry-run`, then re-run
   the deploy. (Migrations are additive by rule, so the old version keeps working after they are applied.)
2. **The old version keeps serving while the new one is built.** The service runs from its own live copy
   (`C:\actions-runners\desk-api\_work\live`); the previous `dist` and `library-ui` are kept next to it as `*.prev`.
3. **A version that does not start is rolled back by the deploy itself.** If the new version is not healthy within 60
   seconds the deploy restores the previous one, starts it, and then reports the deploy as failed. The service stays up.

## Undoing a release that started fine but is wrong

Actions -> **Rollback** -> Run workflow (or, as the service's account, `scripts/rollback.ps1`). It stops the service,
swaps the current and previous versions, and starts the previous one; about 10 seconds. Running it again swaps back.
Only the code goes back: **database migrations are not undone**, which is safe because every migration is additive and
the previous code ignores new tables and columns. If a migration itself must be reversed, its file starts with a
`Rollback:` comment holding the exact statements.

To go back further than one release, revert the commit on `main` and run Deploy.

## What is not covered

- A change to `package.json` dependencies replaces `node_modules` for good; rolling back the code does not restore the
  old packages (the lockfile is the same only if it did not change). If the release changed dependencies, prefer
  reverting the commit and deploying.
- Settings (`DOTENV_CONTENT`) are not versioned by the deploy: change them in the GitHub secret and deploy again.
