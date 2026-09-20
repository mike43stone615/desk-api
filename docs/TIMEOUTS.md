# Timeouts and how long things take

Every wait in the service has a limit, and the limits are ordered so that the inner one always fires first and says
something useful, before the outer one cuts the connection silently.

## What each limit is

| Where | Limit | What happens when it is hit |
| --- | --- | --- |
| A client sending the request's headers (`server.headersTimeout`) | 10 s | Connection closed. A client that trickles bytes cannot hold a slot. |
| A client sending the whole request (`requestTimeout`) | 30 s | Request refused (Node answers 408) and the connection closed. |
| An idle kept-alive connection (`keepAliveTimeout`) | 65 s | Closed quietly. (The tunnel reconnects.) |
| desk-api calling registry-api (lookups) | 15 s (30 s through the gateway) | 502 `upstream_unreachable`; lookups are retried once. |
| desk-api calling market-validation-api (analysis) | 75 s (80 s through the gateway) | 503/502 with a message; never retried, it costs money. |
| desk-api calling compliance-os | 15 s | 502. |
| Cloudflare, in front of everything | 100 s | 524 to the caller. This is the outer limit: everything above is shorter. |
| A caller who disconnects first | immediately | The call to the backend is dropped as well (see `abortWhenClientLeaves`). It is not counted against the backend. |
| A backend that keeps failing | 5 failures in a row | The circuit opens for 15 s: instant 503 with `Retry-After`, then one trial call. |

The database pool has its own limits (waiting for a connection 5 s, a statement 20 s, idle connections released after 30 s, a stalled transaction 30 s); they can be tuned with `DB_*_MS` settings, see `src/db.ts`.

## Why these numbers (measured, live, September 2026)

| Call | Typical | Slowest seen | Budget |
| --- | --- | --- | --- |
| Ordinary desk-api call | 64 to 132 ms (medians) | not measured | none needed |
| Name check, one-word common name in Florida | 3.3 to 3.7 s | 3.7 s | 15 s |
| Market analysis of an idea (12 ideas across 12 states, live, 20 Sep 2026) | median 1.3 s | 2.4 s (was 26 s for North Dakota before the fix below) | 75 s |

Rules of thumb used when choosing the budgets: a budget is at least 3x the slowest measured time for that call, but
always under Cloudflare's 100 s. The market analysis budget (75 s) is far above what was measured; it is kept because a
first analysis for an unusual state may have to fetch data that later ones find cached, and nobody has yet measured
that worst case. If measurements ever show analyses regularly taking more than about 20 s, it should become "start it,
then poll for the answer" (it costs money upstream, so it is never retried).

Re-measure against the live service before changing a budget, and change this page in the same commit. Rows marked
"not measured" have no written measurement behind them yet.

### The slow analysis that was found (20 September 2026)

Measuring twelve analyses instead of two showed one state, North Dakota, taking 25 s every time. The cause was not the
analysis: it asks Compliance-OS for the state's zoning rules, and that search scanned all 2.1 million requirements in id
order to find a state with few matches (25 to 110 s in the database). The market service then waited 8 s, tried
again twice (3 x 8 s), and gave up. Three fixes: Compliance-OS now looks the state's jurisdictions up first and pages
through the matching ids (and has a covering index in its next migration); the market service no longer retries a
timeout and skips Compliance-OS for 30 s after one; and the planner statistics of Compliance-OS's `Jurisdiction` table
(never analysed, so the planner believed it was empty) were refreshed. After the fix the twelve analyses took 0.8 to
2.4 s. Because the worst case is now well under 20 s, "start it, then poll" was not built.
