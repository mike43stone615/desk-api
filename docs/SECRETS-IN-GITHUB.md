# Secrets held in GitHub Actions, and how exposed they are

| Repository | Secret | What it is |
| --- | --- | --- |
| desk-api, registry-api, market-validation-api, compliance-os, desk-oracle | `DOTENV_CONTENT` | the whole settings file of that service (database login, keys, admin key). Written to `.env` on the runner at every deploy. |
| desk_business | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | lets the web app deploy to Cloudflare Pages |

## Why they are not exposed (checked September 2026)
- **Nobody else can trigger a run.** Every workflow that can see a secret starts only with `workflow_dispatch` (a person
  pressing Run in this account). There are no `pull_request` or `push` triggers, so a fork or an outside contribution can
  never reach a secret. (desk-api is public; that is why this matters.)
- **The workflow token is read-only.** Each workflow declares `permissions: contents: read`, so even a compromised step
  could not write to the repository, create releases or open issues with it.
- **Secrets are never printed.** A search of the last 12 deploy logs of desk-api for the value of every secret-like
  setting (15 of them, including the password inside the database address) found none. GitHub also masks a secret's exact
  value in logs.
- **Only the deployment runner sees them**, and it runs on the operator's own machine under a limited service account.

## What is still true
- One secret holds a whole settings file, so anyone who can edit the repository's secrets can read all of a service's
  settings. Splitting it would not change who can read them, only make rotation more fiddly; it is deliberately not split.
- Rotation: docs/SECRET-ROTATION.md and docs/ROTATING-GATEWAY-SECRETS.md. After changing `DOTENV_CONTENT`, deploy (the
  deploy validates the settings first and stops if they are invalid).
- Re-run the log check after any change to a workflow that prints settings.
