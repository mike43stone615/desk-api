# Legal drafts (not published)

`privacy-policy.draft.md` and `terms-of-service.draft.md` are **drafts for the owner to review**. Nothing here is served by
the API or linked from any page, and no sign-up checkbox depends on them.

- Every statement about what the service stores or does is taken from the code and was true when written. Each has a
  `(source: …)` note so a reviewer can re-check it after the code changes.
- Anything in `[[double brackets]]` is a decision or a fact only the owner can supply (business name, contact, country
  whose law applies, whether account deletion exists, …). It must be filled in or removed before publishing.
- These drafts are not legal advice. Have a lawyer read them before they are published, especially the terms.

## To publish (needs the owner's go-ahead)

1. Resolve every `[[…]]`, and have the drafts reviewed.
2. Save the final text as two web pages (for example `https://app.deskbusiness.co/privacy` and `/terms`) and link them
   from the sign-up form.
3. Optionally record acceptance at sign-up: nullable `users.terms_accepted_at` / `users.terms_version`, written by
   `POST /auth/signup` when the request says `acceptedTerms: true`. This is **not built**: it changes the sign-up form
   and only makes sense once the pages exist.
