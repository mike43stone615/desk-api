# Limits and quotas

Limits protect the service and other developers. All of them are counted per minute unless stated. When you hit one you
get `429` with `Retry-After`, and every answer (a `429` too) carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and
`X-RateLimit-Reset` so you can slow down before it happens.

| What | Limit | Notes |
| --- | --- | --- |
| Your **plan** (all your keys together) | Free: each API 60 a minute and 300 a month, all three 100 a minute and 500 a month. Pro: 600 / 3,000 and 1,000 / 5,000. Business: 3,000 / 15,000 and 3,000 / 15,000 | Per-minute limits always refuse. On Free a monthly limit refuses until next month; on Pro and Business calls past it keep working and are billed ($0.05 and $0.03 each). Only calls that succeed count; sandbox keys never do. Your numbers are on the Plans & billing page. |
| **Market analyses** (plan) | Free 5, Pro 75, Business 350 a month | Free stops at 5; paid plans are billed $0.30 for each one beyond. |
| One **API key** | the plan's calls a minute across all APIs (60 a minute to the Desk API for a key with no plan of its own) | Checked before your address. A real key's calls do not use up its address's allowance, so one server can reach its plan's limits. |
| One **account** (all its keys, sessions and devices together) | 300 calls a minute | A leaked key or session used from many places is still one account. |
| One **network address** | 120 calls a minute | Counts calls that do not carry a real key (including calls with a made-up key). |
| **Registry API** and **Market Validation API** | 60 calls a minute per key (their own limit) | Their answers carry their own `X-RateLimit-*` headers. |
| A **market analysis** | 2 at once per person, 30 an hour per address | It costs money upstream. Never retried automatically. |
| **Keys, webhook endpoints, apps** | Free 10 / 3 / 1, Pro 25 / 10 / 3, Business 100 / 50 / 10 | Remove one to add another. |
| **Expiry** | optional (1 to 730 days); unused for **180 days** = switched off | Make a new key when this happens. |
| Sign-in, sign-up, password reset, invitations, key creation | hourly limits, stated in the `429` message | See AUTHENTICATION.md. |

Monthly limits count calendar months (UTC). Your own usage, per key and per day (calls and how many failed), is
`GET /v1/gateway/api-keys/{id}/usage`.

Timeouts (how long a call may take before it is cut off) are in [TIMEOUTS.md](TIMEOUTS.md).
