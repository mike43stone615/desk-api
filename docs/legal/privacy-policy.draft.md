# Privacy policy — DRAFT for review

**Status:** draft, not published. Brackets `[[…]]` need the owner's input. Effective date: `[[date]]`.

**Who we are.** `[[legal name of the business that runs Desk]]`, `[[country/state]]`. Contact for privacy questions:
`[[privacy contact email]]`.

This policy covers Desk's website and app (`app.deskbusiness.co`) and its API (`api.deskbusiness.co`, including the
Desk API Library for developers).

## What we collect and why

| What | Why | Where it comes from |
| --- | --- | --- |
| Your name, email address, and a one-way scrambled form of your password (we cannot read your password) | To create your account and sign you in | You, at sign-up (source: `users` table) |
| Sign-in sessions: an unreadable fingerprint of your session token, when it was created, when it was last used, the device/browser description and the network address it came from | Keeping you signed in, and showing you your signed-in devices so you can end one | Your browser (source: `sessions`, migration 0012) |
| Security activity: sign-ins, failed sign-ins, password changes and resets, sessions ended, developer keys created or removed, with the time, network address and device description | Letting you see what happened on your account, and warning you by email about unusual events | Us (source: `security_events`, kept 180 days) |
| The businesses and business-setup drafts you enter: business name, structure, state, and the answers you give in the setup wizard | To provide the setup guidance the app exists for | You |
| Who else has access to a business (their account, role, and the email address of anyone you invite) | To share a business with people you choose | You |
| A record of changes made to businesses (who, what, when) | Accountability and support | Us (source: `mutation_audit_log`) |
| Developer keys you create in the API Library: a label, an unreadable fingerprint of the key, which services it may use, when it was last used | To let your software call the API | You |
| Technical logs: request time, address requested, response code, network address. Email addresses in logs are replaced by a short fingerprint and secrets are removed | Keeping the service running and investigating problems | Us (source: `src/middleware/log-redaction.ts`) |

We do not sell your information and do not use it for advertising. `[[confirm: no analytics or advertising trackers besides those listed below]]`

## Who else sees it (our service providers)

- **Email delivery (Resend)**: receives your email address and the text of the emails we send you (confirmation, password
  reset, security notices, invitations).
- **AI features (OpenAI)**: if you use the AI setup analysis, the text you enter for that feature is sent to OpenAI to get an
  answer. `[[confirm what OpenAI's data-use terms for your account say and describe it here]]`
- **Place search (Google Places)**: city and place search text you type is sent to Google.
- **Error monitoring (Sentry)**: if enabled, error reports go to Sentry with secrets and email addresses removed on the
  server first. `[[confirm whether Sentry is enabled in the web app and what it captures]]`
- **Hosting and network (Cloudflare)**: all traffic passes through Cloudflare, which sees network addresses and request
  contents in transit.
- **Backups**: copies of our databases are kept on our own machines and in a private cloud folder. `[[confirm wording]]`

## How long we keep it

- Account and business data: until you ask us to delete it. `[[Automated account deletion is not built yet; say so or replace once it exists.]]`
- Security activity: 180 days.
- Sessions: until they expire or you end them.
- Backups: only the most recent copies. `[[state how many days/generations]]`
- Logs: `[[state a period, for example 30 days; log retention is not currently managed by the service]]`.

## Your choices

- See and end your signed-in devices, and see recent security activity: in the app under *Signed-in Devices*.
- Correct your name or email: `[[describe how; currently by contacting us]]`.
- Ask for a copy or deletion of your data: email `[[privacy contact email]]`.
- If you are in a region with a privacy law (for example the EU/UK GDPR or California's CCPA), you have additional rights.
  `[[have a lawyer confirm which apply and add them]]`

## Security

Passwords are stored only as salted one-way hashes. Session tokens and developer keys are stored only as hashes. Stored
third-party keys are encrypted. All traffic uses HTTPS. No system is perfectly secure. Report a vulnerability to
`[[security contact; also published at /.well-known/security.txt once SECURITY_CONTACT is set]]`.

## Children

Desk is for business owners and is not directed to children under `[[13 / 16]]`.

## Changes

We will update this page when our practices change and change the effective date above.
`[[say how you will notify users of material changes]]`
