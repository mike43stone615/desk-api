# Limits and quotas

Limits protect the service and other developers. All of them are counted per minute unless stated. When you hit one you
get `429` with `Retry-After`, and every answer (a `429` too) carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and
`X-RateLimit-Reset` so you can slow down before it happens.

| What | Limit | Notes |
| --- | --- | --- |
| One **API key** | 60 calls a minute to the Desk API | Checked before your address, so a busy key does not use up other callers' allowance on a shared address. |
| One **account** (all its keys, sessions and devices together) | 300 calls a minute | A leaked key or session used from many places is still one account. |
| One **network address** | 120 calls a minute | Counts calls that do not carry a key, and calls with a made-up key. |
| **Registry API** and **Market Validation API** | 60 calls a minute per key (their own limit) | Their answers carry their own `X-RateLimit-*` headers. |
| A **market analysis** | 2 at once per person, 30 an hour per address | It costs money upstream. Never retried automatically. |
| **Keys per account** | 10 active | Revoke one to make another. |
| **Expiry** | optional (1 to 730 days); unused for **180 days** = switched off | Make a new key when this happens. |
| Sign-in, sign-up, password reset, invitations, key creation | hourly limits, stated in the `429` message | See AUTHENTICATION.md. |

There is no monthly quota today. Your own usage, per key and per day (calls and how many failed), is
`GET /v1/gateway/api-keys/{id}/usage`.

Timeouts (how long a call may take before it is cut off) are in [TIMEOUTS.md](TIMEOUTS.md).
