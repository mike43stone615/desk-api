# Secret Rotation

Tracked as a gap in `docs/KNOWN-LIMITATIONS.md` #5: no runbook existed for
rotating any of this service's secrets. This describes the procedure for
each one, given the current deployment reality — this service isn't
deployed anywhere yet (see `README.md`), so "rotation" today just means
updating `.env` and restarting the process; there's no atomic,
zero-downtime rotation because there's no multi-instance/load-balanced
deployment to make that meaningful yet. Revisit this doc once a real
deployment target (and its env-injection mechanism — Docker secrets, a
platform's env-var UI, a secrets manager) is chosen.

## General procedure (all secrets below)

1. Generate the new secret value.
2. Update `.env` (or the eventual deployment's env-injection mechanism).
3. Restart the process (`npm run dev` locally; once deployed, whatever
   restarts the service — a brief drop in availability during restart is
   expected until this runs as multiple replicas behind a load balancer).
4. Verify the specific behavior each secret gates (see below) still works.
5. If the secret is also configured in a sibling service that authenticates
   *to* this one (or that this one authenticates to), update both sides —
   see each secret's "Shared with" note.

## Secrets

### `OPENAI_API_KEY`

Used by `src/routes/functions/analyzeBusinessSetup.ts` for idea/target-market
plausibility scoring. Rotate via the OpenAI dashboard; no coordination
needed elsewhere. If unset, `fallbackEnrichment`'s offline heuristics take
over automatically (not a startup-blocking secret).

### `GOOGLE_PLACES_API_KEY`

Used for `search-place-areas`. Rotate via Google Cloud Console. No
coordination needed elsewhere.

### `REGISTRY_API_SECRET` / `REGISTRY_API_ADMIN_KEY`

Sent as `x-api-key` when this service calls registry-api's own admin/proxy
routes (`src/routes/admin.ts`'s `proxyUpstreamJson`, `src/routes/apiGateway.ts`).
**Shared with registry-api**: registry-api must be configured with the
matching secret (its own `ADMIN_API_KEY`/equivalent env var) or every
proxied admin-table and gateway call from this service starts returning
401/503. Rotate on registry-api's side first (accepting both old and new
briefly if registry-api supports multiple valid keys), then update this
service's `.env`, then revoke the old value on registry-api.

### `COMPLIANCE_OS_API_KEY`

Same pattern as the registry-api secret above, but for compliance-os's
admin/gateway routes. **Shared with compliance-os** — rotate compliance-os's
side first, then this service's `.env`.

### `RESEND_API_KEY`

Used by `src/infrastructure/email/resend.ts` for password-reset and
email-confirmation delivery. Rotate via the Resend dashboard. No
coordination needed elsewhere. If unset (or during a rotation gap), the
affected endpoints still return `200` (deliberate, to avoid account
enumeration) but silently send no email — see `docs/KNOWN-LIMITATIONS.md`
#4 and the startup warning in `src/app.ts` that now fires in production
when this is unset.

### `METRICS_DOCS_API_KEY`

Gates `GET /metrics` and `GET /docs` behind a shared secret
(`src/middleware/auth.ts`'s `requireMetricsDocsKey`) — opt-in, not a
default. Rotating this is entirely internal to this service: update
`.env`, restart, and update whatever's actually calling `/metrics` with
the `x-api-key` header (a scraper, a dashboard) to use the new value at
the same time, or metrics collection will silently 401 until it's updated
too.

### `DATABASE_URL` (Postgres credentials)

Not an application secret in the usual sense, but rotating the Postgres
password follows the same shape: update the password on the Postgres side,
update `DATABASE_URL` in `.env`, restart. No other service depends on
this service's own database credentials.

## Not yet applicable

Session tokens, password-reset tokens, and email-confirmation tokens
(`src/domain/auth/tokens.ts`) are per-user, generated at runtime, and
already have their own expiry (`SESSION_DURATION_HOURS`,
`RESET_TOKEN_DURATION_MINUTES`, `CONFIRMATION_TOKEN_DURATION_MINUTES`) —
nothing to "rotate" here, they're not long-lived service secrets.
