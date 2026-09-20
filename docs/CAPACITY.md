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
