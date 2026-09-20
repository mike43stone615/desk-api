# Outside services that receive data (September 2026)

Every company that receives data from Desk, what it receives, why, and what is **not** verified. This is a factual list taken from the code and the provider dashboards that could be read; it is not a legal review. Read it together with [PERSONAL-DATA.md](PERSONAL-DATA.md) and [DATA-RETENTION.md](DATA-RETENTION.md).

| Service | Receives | Why | Where | Agreement on file? |
| --- | --- | --- | --- | --- |
| **Resend** (email) | The recipient's email address; for invitations, the business name and the inviter's email; the subject and body of the message (reset and confirmation links carry a one-time token). | Sending password-reset, confirmation, invitation and security-notice emails. | Sending region **us-east-1** (checked in the dashboard). The domain's DKIM is verified. | Not verified by this review. |
| **Sentry** (error reports) | Error type, stack trace, request id, release. Both the server and the web app set `sendDefaultPii: false`, and the web app removes email addresses, tokens and long secrets from every report before it is sent (`scrubSentryEvent`, tested). | Finding bugs. | Sentry's US region (as configured). | Not verified by this review. |
| **OpenAI** | For the business-setup analysis: the person's business idea text, chosen industries, business structure, number of partners, and the city and state of formation. Nothing from the account (no email, name or password) is sent. | The AI-written classification, market-validation and business-plan sections. | OpenAI's API. | Not verified by this review. Whether OpenAI keeps or trains on API data depends on the terms of the account that owns the key. |
| **Google Places** | The text a person types into the place-search box, and the place identifiers chosen. | Suggesting cities and areas. | Google. | Not verified by this review. |
| **Cloudflare** | All traffic to `*.deskbusiness.co` passes through it (it terminates HTTPS), so it can see requests and responses, including passwords at sign-in. It also serves the web app (Pages) and carries the tunnel to this machine. | Hosting, DDoS protection, the tunnel. | Global network. | Standard terms; not reviewed. |
| **GitHub** | The source code (public for desk-api, private for the others), CI logs, and the encrypted-at-rest deployment secret. | Code hosting and automated deployment. | GitHub. | Standard terms; not reviewed. |

## What the review could and could not confirm

- **Confirmed from code and dashboards:** the list of fields above, the Resend region, Sentry's scrubbing and `sendDefaultPii: false`, and that no code path sends an account password hash or a session cookie to Resend, Sentry, OpenAI or Google. (Cloudflare carries all traffic, so it necessarily sees cookies in transit.)
- **Cannot be confirmed from here:** the signed data-processing terms with each company, whether any of them has a "zero retention" setting turned on, and their sub-processors. That needs the account owner to read each dashboard's privacy and data settings.
- **What a person is told:** the draft privacy policy in `docs/legal/` names these services. Nothing is published until the owner and a lawyer approve it.

## If one of them has a breach or shuts down

- **Resend:** rotate `RESEND_API_KEY` (see SECRET-ROTATION.md). Emails stop being sent; sign-in and everything else continue.
- **Sentry:** unset the DSN; nothing else depends on it.
- **OpenAI / Google:** the affected features return their plain "temporarily unavailable" answers; the rest keeps working (the status page shows this as "degraded").
