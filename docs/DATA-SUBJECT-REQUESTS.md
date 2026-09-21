# Requests about personal data: access, correction, deletion (September 2026)

A person can ask what Desk holds about them, ask for a correction, or ask for it to be deleted. Most of this is done by the
person themselves, signed in; the owner handles the rest by hand.

| Request | How the person does it | If they cannot sign in |
| --- | --- | --- |
| **See my data** | `GET /auth/account/export` (a JSON file: account, sign-in history, businesses, drafts, keys and their usage) | Ask the owner (below). |
| **Correct my data** | Change name and e-mail in the app; edit drafts and businesses there | Ask the owner. |
| **Delete my data** | `POST /auth/account/delete` (asks for the current password; keys are revoked first; a business other people share is handed to its best remaining member, a business only they belong to is deleted) | Ask the owner. |
| **Stop e-mails** | Security notices cannot be turned off; sign-up and reset e-mails only go to an address someone asked for | Bounces and spam complaints are added to the do-not-mail list automatically. |

## When the owner has to do it (the person cannot sign in)

1. **Check who is asking.** Reply to the address on the account, asking them to confirm it is them by replying from that
   address. Do not act on a request that comes from a different address.
2. **Export:** sign in as an administrator and produce the same export for that user id (admin data browser).
3. **Delete:** suspend the account first (`POST /admin/users/:id/suspend`), then delete it from the admin data browser or with
   the deletion function, which revokes keys and hands over shared businesses.
4. **Confirm in writing within 30 days**, saying what was deleted and what is kept and why (see below).
5. **Log it:** administrator actions are recorded automatically (`admin_actions`); note the date of the request.

## What is kept after a deletion

Nothing tied to the person, except backups (local copies roll off after 14 generations; the off-machine copies are
encrypted and roll off the same way), counters with no personal detail, and any record the law requires. Outside services
(see THIRD-PARTIES.md) keep their own copies under their own terms: mail logs at the mail provider and error reports at the
error-report service.

The dates and the person who handles requests are the owner's to fill in once the privacy policy in `docs/legal/` is approved.
