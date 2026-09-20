# What is kept, and for how long

Enforced by code unless it says "by hand". The nightly cleanup (`src/jobs/cron.ts`, 02:00) runs the deletions below.

| Data | Kept | Removed by |
| --- | --- | --- |
| Account (name, email, password hash) | until the person deletes it (`POST /auth/account/delete`) or an admin does | the person / an admin |
| Sessions | until they expire (30 days) or are ended; the person can list and end them | nightly cleanup |
| Password-reset and email-confirmation links | expire in 60 minutes / 24 hours, then deleted | nightly cleanup |
| Idempotency records | 24 hours | expiry + nightly cleanup |
| Emailed invitations to addresses with no account | until accepted or expired | nightly cleanup |
| Security events (sign-ins, failed sign-ins, password and key events; hold network address and browser) | 180 days, **and all of a person's events are deleted when they delete their account** | nightly cleanup / account deletion |
| Admin change history (`mutation_audit_log`: who changed which row, before and after) | 2 years (730 days) | nightly cleanup |
| API keys | until revoked; a revoked key's record is kept (only a hash and a label) | never removed on its own |
| Service logs | 30 days, one file per day (`LOG_DIR`, default `<live folder>\logs`; error output in `.err.log`) | the supervisor deletes older files when it starts and at midnight (UTC) |
| Database backups | see BACKUP-RESTORE.md: the newest copies only, plus the newest copy off-machine | the backup script |

Searching the logs: `node scripts/search-logs.mjs <text>` or `--request <id>` or `--errors`, over the last `--days 7`.

## Personal data in logs
Request logs hold the network address and the request address, never a password, token, key or email (see
`src/middleware/log-redaction.ts`; failed sign-ins log a short fingerprint of the address, not the address).

## Changing a period
The periods are constants next to the code that enforces them (`SECURITY_EVENT_RETENTION_DAYS`,
`AUDIT_RETENTION_DAYS`, `LOG_RETENTION_DAYS`); change the constant and this page together.
