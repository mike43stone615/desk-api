# How much one machine can carry, and what changes with more keys

## Measured (September 2026)
`node scripts/load-test.mjs` against a copy of the compiled service on this machine (development database, one worker
process, per-address and per-account limits raised so the limits are not what is measured). Three kinds of call mixed
equally: a public page, a signed-in call (session lookup in the database), and an API-key call (key lookup, suspension
check, usage count). 40 accounts, 8 seconds per step.

| Simultaneous callers | Requests per second | p50 | p95 | p99 | Failures |
| --- | --- | --- | --- | --- | --- |
| 1 | 169 | 6 ms | 12 ms | 17 ms | 0 |
| 5 | 330 | 17 ms | 31 ms | 40 ms | 0 |
| 10 | 346 | 33 ms | 55 ms | 74 ms | 0 |
| 25 | 362 | 85 ms | 127 ms | 144 ms | 0 |
| 50 | 363 | 175 ms | 255 ms | 275 ms | 0 |
| 100 | 364 | 345 ms | 520 ms | 610 ms | 0 |

**Reading it:** one worker process tops out at about **360 requests a second** of this mix. Past about 10 simultaneous
callers nothing gets faster, calls simply wait in line (latency grows in proportion), and nothing fails. The first point
where the 95th percentile passes half a second is about 100 callers at once.

For scale: every account is limited to 300 calls a minute (5 a second) and every key to 60 a minute, so 360 requests a
second is the whole allowance of about **70 accounts all using their full limit at the same moment**. Real traffic is
bursty and far below its limits, so the practical ceiling is well above that.

## What happens with 1,000 keys
- **Looking a key up** is one indexed query on a unique hash (plus one on suspensions); it does not slow down with more keys.
- **Memory**: one small counter per key that was used recently; idle counters are dropped after a day.
- **Database**: usage is one row per key per day (1,000 keys is about 365,000 rows a year, tens of megabytes), removed
  with the key.
- **The hourly comparison with the backends** downloads each backend's full key list in one call (no paging, no cap);
  1,000 keys is a few hundred kilobytes. It runs once an hour.
- **The 10-keys-per-account cap** means 1,000 keys is at least 100 accounts.

## When to act
- Sustained load above roughly 250 requests a second (about 70% of the measured ceiling) or a p95 above 500 ms in
  `node scripts/latency-report.mjs`: run two workers (the supervisor runs one today; running two is a small change to it), then measure again.
- More than a few thousand keys: page the hourly comparison and move the usage counters into a summary table.
- The machine, the tunnel and Cloudflare are still a single point of failure whatever the software does
  (HOSTING-AND-RECOVERY.md).

The numbers above come from one run on one afternoon; re-run the script after big changes and update this page.

## Measured on the host, 20 September 2026

- **Disk:** C: had 174 GB free of 476 GB. Logs are 4 MB (30 days kept, rotated daily), so they are not a concern.
- **Memory:** 15.9 GB total, about 1.9 GB (12%) free with everything running; PostgreSQL uses about 1.4 GB and each Node service 60-190 MB (one process, the largest at about 720 MB, is not a Desk service). This is the tightest resource. The uptime watch now alerts if free memory stays under 4% for three checks in a row (`memory` in `scripts/uptime-targets.json`).
- **CPU:** about 14% at rest.
- **Database queries:** the 13 queries behind the busiest routes all use indexes (`scripts/query-plans.mjs`; tables hold at most a few hundred rows).
- **First request after a restart:** at most about 130 ms slower than a warm one; the service starts listening in 3-4 s.
- **Cloudflare (read from the account):** security level medium, browser integrity check on, minimum TLS 1.2, always-use-HTTPS on, HSTS one year with subdomains (not preloaded, see DECISIONS.md). The bot-management and custom firewall rulesets could not be read with the available token.

## Locking under concurrency

`scripts/stress-locks.mjs` runs the same locking statements the routes use (creating drafts, removing owners, deleting an account) 13 at a time, for many rounds, and reports database deadlocks and broken rules (a sixth draft, a business left with no owner). It only runs against a scratch database (name ending `_test` or `_dev`). **It has not been run yet**: creating a scratch database on the shared server was not permitted in the session that wrote it. Run it once after creating `deskapi_stress_test` and migrating it.
