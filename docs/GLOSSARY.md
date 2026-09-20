# Words used in Desk

| Word | What it means |
| --- | --- |
| **Account** | A person's sign-in (email, password, name). Everything else belongs to an account. |
| **Session** | One signed-in browser or app. Lasts 30 days from sign-in and ends after 14 days without use. A person can list and end them. |
| **Draft** ("registration" in the app) | An unfinished business setup, saved as you go. Up to 5 per person. Completing a draft creates a business. |
| **Business** ("workspace" in the app) | A company set up through the wizard. Belongs to its members. |
| **Member / role** | A person with access to a business: `owner`, `admin`, `member` or `accountant`. A business always keeps at least one owner. |
| **Invitation** | An offer of membership sent to an email address. If the address has no account yet, it waits (up to 24 hours per address to repeat, a limited number per business) and attaches when that address is confirmed. |
| **API key** | A `deskgw_…` credential for a server. Belongs to one account. Shown once. |
| **Grant** | One API a key may use (`desk_api`, `registry_api`, `market_validation_api`). A key has one or more. Fixed when the key is made. |
| **Backend key** | The real key the Registry or Market service issued for one grant. Kept encrypted; a developer never sees it. |
| **Suspended** | Switched off but not deleted: an account (cannot sign in, its keys are refused) or a single key. Can be switched back on. |
| **Revoked** | Permanently ended. A revoked key is gone for good, including its backend keys. |
| **Expired / idle** | A key past its chosen date, or unused for 180 days. Refused, then revoked by the nightly clean-up. |
| **Idempotency-Key** | A header that makes a retry safe: the same key replays the first answer instead of doing the action twice. |
| **ETag / If-Match** | A version tag on a draft. Saving with an old tag is refused (412) so two tabs cannot silently overwrite each other. |
| **Request id** | The `x-request-id` on every answer. Quote it to find one request in the logs. |
| **Circuit open** | A backend that keeps failing is not called for a few seconds; callers get an instant 503 with `Retry-After`. |
| **Legacy path** | An unprefixed path such as `/setup/drafts`. Answers the same as `/v1/setup/drafts` but is not covered by the versioning policy. |
