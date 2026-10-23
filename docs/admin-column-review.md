# Administration tab: column review (Desk API 38 tables, Registry API 5 + 9 views, Market API 7)

Every column of every table (38) checked against the same list. Review date 2026-10-22. Nothing here is committed or deployed.

## The checklist (same for every column and table)

**Per column:** C1 locked? | C2 necessary / consolidated, no hard-to-parse JSON? | C3 dates checked? | C4 visible by default unless sensitive? | C5 shows what is needed to navigate (names beside ids)? | C6 typed or automatic on add, dropdown if few options? | C7 numbers checked (whole, range)? | C8 text formats and length checked, auth-page errors for emails and names? | C9 sensitive values never shown?

**Per table:** T1 table decisions | T2 Add row: required unless blank means something, lowest default, search for ids | T3 duplicate errors in plain words | T4 delete: what goes and stays, note | T5 audit, updated_at, version, related rows kept consistent | T6 filter and sort on every column, read-only tables really read-only | T7 no duplicated information


## Table 1 of 38: users

**What it is:** One row per person with a Desk account.

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `id` | nobody (row key) | none needed | automatic |
| `email` | owners and administrators | sign-up rules | required |
| `first_name` | owners and administrators | sign-up rules | required |
| `last_name` | owners and administrators | sign-up rules | required |
| `email_confirmed_at` | owners and administrators | date checked, may be empty | blank |
| `totp_enabled_at` | owners and administrators | date checked, may be empty | blank |
| `created_at` | nobody (locked) | none needed | automatic |
| `updated_at` | nobody (locked) | none needed | automatic |
| `password_set` | nobody (locked) | worked out, filterable, sortable | blank |

**Hidden columns (in the database, not shown):** password_hash, totp_secret_enc (secrets).

**Adding a row:** must enter: email, first_name, last_name. Pre-filled: none. Automatic: id, password, created_at, updated_at.

**Deleting:** owners and administrators can delete. The pop-up lists everything that goes with the person (sessions, links, keys, webhooks, apps, setups, memberships, businesses nobody else is in, payment methods, backup codes, counters, admin access, suspension) and what stays (businesses with another member, subscription history, invoices, security events).

**Changed in this review:** Names are checked with the sign-up rules on edit; the email is saved trimmed and lower case; a duplicate email says "An account with this email already exists." Password set column (read-only) added earlier.


## Table 2 of 38: business_email_invites

**What it is:** Invitations to join a business that were sent to an email address (the person may have no account yet).

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `id` | nobody (row key) | none needed | n/a (no Add row) |
| `business_id` | nobody (locked) | none needed | n/a (no Add row) |
| `business_name` | nobody (locked) | worked out, filterable, sortable | n/a (no Add row) |
| `email` | nobody (locked) | none needed | n/a (no Add row) |
| `role` | owners and administrators | dropdown: owner, admin, member, accountant | n/a (no Add row) |
| `invited_by_user_id` | nobody (locked) | none needed | n/a (no Add row) |
| `inviter_name` | nobody (locked) | worked out, filterable, sortable | n/a (no Add row) |
| `invited_at` | nobody (locked) | none needed | n/a (no Add row) |

**Hidden columns (in the database, not shown):** None.

**Adding a row:** not offered (the system creates these rows; a hand-made row would be broken or unsafe).

**Deleting:** owners and administrators can delete. Pop-up note: The invitation link stops working.

**Changed in this review:** Added Business name and Inviter name (read-only).


## Table 3 of 38: email_outbox

**What it is:** Emails waiting to be sent, or failing.

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `id` | nobody (row key) | none needed | n/a (no Add row) |
| `to_email` | nobody (locked) | none needed | n/a (no Add row) |
| `kind` | nobody (locked) | none needed | n/a (no Add row) |
| `subject` | nobody (locked) | none needed | n/a (no Add row) |
| `attempts` | owners and administrators | whole number 0+ | n/a (no Add row) |
| `next_attempt_at` | owners and administrators | date checked | n/a (no Add row) |
| `last_error` | nobody (locked) | none needed | n/a (no Add row) |
| `created_at` | nobody (locked) | none needed | n/a (no Add row) |

**Hidden columns (in the database, not shown):** html, text_body (the message holds sign-in links).

**Adding a row:** not offered (the system creates these rows; a hand-made row would be broken or unsafe).

**Deleting:** owners and administrators can delete. Pop-up note: That email is never sent.

**Changed in this review:** attempts must be a whole number 0 or more; next_attempt_at is checked as a date. No Add row: the system writes emails.


## Table 4 of 38: email_suppressions

**What it is:** Addresses we must not email (a bounce or a complaint).

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `email` | nobody (locked) | none needed | required |
| `reason` | owners and administrators | dropdown: bounced, complained | required, dropdown |
| `created_at` | nobody (locked) | none needed | automatic |

**Hidden columns (in the database, not shown):** None.

**Adding a row:** must enter: email, reason. Pre-filled: none. Automatic: created_at.

**Deleting:** owners and administrators can delete. Pop-up note: Email to this address is allowed again.

**Changed in this review:** reason is now a dropdown (bounced, complained) on add and edit.


## Table 5 of 38: gateway_api_key_grants

**What it is:** Which APIs each key may call, and the backend key issued for it.

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `id` | nobody (read-only table) | none needed | n/a (no Add row) |
| `api_key_id` | nobody (read-only table) | none needed | n/a (no Add row) |
| `key_label` | nobody (read-only table) | worked out, filterable, sortable | n/a (no Add row) |
| `service` | nobody (read-only table) | none needed | n/a (no Add row) |
| `backend_key_id` | nobody (read-only table) | none needed | n/a (no Add row) |
| `created_at` | nobody (read-only table) | none needed | n/a (no Add row) |

**Hidden columns (in the database, not shown):** encrypted_backend_key (secret).

**Adding a row:** not offered (read-only table).

**Deleting:** not deletable (read-only).

**Changed in this review:** Added Key label (read-only). Stays read-only: grants are made and ended with the key.


## Table 6 of 38: gateway_backend_key_revocations

**What it is:** Backend keys that still have to be ended at another API (a retry queue).

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `id` | nobody (row key) | none needed | n/a (no Add row) |
| `service` | nobody (locked) | none needed | n/a (no Add row) |
| `backend_key_id` | nobody (locked) | none needed | n/a (no Add row) |
| `attempts` | owners and administrators | whole number 0+ | n/a (no Add row) |
| `last_error` | nobody (locked) | none needed | n/a (no Add row) |
| `created_at` | nobody (locked) | none needed | n/a (no Add row) |

**Hidden columns (in the database, not shown):** None.

**Adding a row:** not offered (the system creates these rows; a hand-made row would be broken or unsafe).

**Deleting:** owners and administrators can delete.

**Changed in this review:** attempts checked as a whole number 0 or more. Nothing else needed.


## Table 7 of 38: gateway_key_shares

**What it is:** API keys shared with another person.

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `id` | nobody (row key) | none needed | n/a (no Add row) |
| `api_key_id` | nobody (locked) | none needed | n/a (no Add row) |
| `key_label` | nobody (locked) | worked out, filterable, sortable | n/a (no Add row) |
| `shared_with_user_id` | nobody (locked) | none needed | n/a (no Add row) |
| `shared_with_name` | nobody (locked) | worked out, filterable, sortable | n/a (no Add row) |
| `invited_by_user_id` | nobody (locked) | none needed | n/a (no Add row) |
| `inviter_name` | nobody (locked) | worked out, filterable, sortable | n/a (no Add row) |
| `accepted_at` | nobody (locked) | none needed | n/a (no Add row) |
| `created_at` | nobody (locked) | none needed | n/a (no Add row) |

**Hidden columns (in the database, not shown):** None.

**Adding a row:** not offered (the system creates these rows; a hand-made row would be broken or unsafe).

**Deleting:** owners and administrators can delete. Pop-up note: The person loses access to the shared key.

**Changed in this review:** Added Key label, Shared with name, Inviter name (read-only). All columns locked; delete cancels the share.


## Table 8 of 38: gateway_key_usage

**What it is:** Calls and errors per key per day (the usage charts).

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `api_key_id` | nobody (locked) | none needed | n/a (no Add row) |
| `key_label` | nobody (locked) | worked out, filterable, sortable | n/a (no Add row) |
| `day` | nobody (locked) | none needed | n/a (no Add row) |
| `calls` | owners and administrators | whole number 0+ | n/a (no Add row) |
| `errors` | owners and administrators | whole number 0+ | n/a (no Add row) |

**Hidden columns (in the database, not shown):** None.

**Adding a row:** not offered (the system creates these rows; a hand-made row would be broken or unsafe).

**Deleting:** owners and administrators can delete.

**Changed in this review:** Added Key label. Only calls and errors can be corrected (whole numbers, 0 or more); the key and the day are locked. Previously every column was open.


## Table 9 of 38: idempotency_keys

**What it is:** Stored answers to repeated requests, so a repeat does not run twice.

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `key` | nobody (locked) | none needed | n/a (no Add row) |
| `response_status` | nobody (locked) | none needed | n/a (no Add row) |
| `expires_at` | nobody (locked) | none needed | n/a (no Add row) |
| `created_at` | nobody (locked) | none needed | n/a (no Add row) |

**Hidden columns (in the database, not shown):** request_hash, response_body (stored responses can hold personal data).

**Adding a row:** not offered (the system creates these rows; a hand-made row would be broken or unsafe).

**Deleting:** owners and administrators can delete.

**Changed in this review:** No change: all columns locked, delete clears a stored answer.


## Table 10 of 38: key_suspensions

**What it is:** API keys that are switched off for now.

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `api_key_id` | nobody (locked) | none needed | required, search by name |
| `key_label` | nobody (locked) | worked out, filterable, sortable | blank |
| `owner_name` | nobody (locked) | worked out, filterable, sortable | blank |
| `suspended_at` | nobody (locked) | none needed | automatic |
| `reason` | owners and administrators | text up to 500, required | required |
| `suspended_by` | nobody (locked) | none needed | automatic |

**Hidden columns (in the database, not shown):** None.

**Adding a row:** must enter: api_key_id, reason. Pre-filled: none. Automatic: suspended_at, suspended_by.

**Deleting:** owners and administrators can delete. Pop-up note: The key works again.

**Changed in this review:** Added Key label and Owner name. reason is required, up to 500 characters; delete note: the key works again.


## Table 11 of 38: mfa_pending_logins

**What it is:** Sign-ins waiting for the second step of two-factor.

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `id` | nobody (row key) | none needed | n/a (no Add row) |
| `user_id` | nobody (locked) | none needed | n/a (no Add row) |
| `person_name` | nobody (locked) | worked out, filterable, sortable | n/a (no Add row) |
| `ip_address` | nobody (locked) | none needed | n/a (no Add row) |
| `user_agent` | nobody (locked) | none needed | n/a (no Add row) |
| `expires_at` | nobody (locked) | none needed | n/a (no Add row) |
| `created_at` | nobody (locked) | none needed | n/a (no Add row) |

**Hidden columns (in the database, not shown):** token_hash (secret).

**Adding a row:** not offered (the system creates these rows; a hand-made row would be broken or unsafe).

**Deleting:** owners and administrators can delete.

**Changed in this review:** Added Person name (read-only).


## Table 12 of 38: oauth_codes

**What it is:** Short-lived codes an app trades for access.

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `code_ref` | nobody (read-only table) | worked out, filterable, sortable | n/a (no Add row) |
| `client_id` | nobody (read-only table) | none needed | n/a (no Add row) |
| `client_name` | nobody (read-only table) | worked out, filterable, sortable | n/a (no Add row) |
| `user_id` | nobody (read-only table) | none needed | n/a (no Add row) |
| `person_name` | nobody (read-only table) | worked out, filterable, sortable | n/a (no Add row) |
| `redirect_uri` | nobody (read-only table) | none needed | n/a (no Add row) |
| `scopes` | nobody (read-only table) | none needed | n/a (no Add row) |
| `expires_at` | nobody (read-only table) | none needed | n/a (no Add row) |
| `used_at` | nobody (read-only table) | none needed | n/a (no Add row) |

**Hidden columns (in the database, not shown):** code_hash, code_challenge (secrets); a short reference of the hash is shown instead.

**Adding a row:** not offered (read-only table).

**Deleting:** not deletable (read-only).

**Changed in this review:** The code hash is no longer shown: a short reference (first 10 characters of the hash) identifies the row. Added Client name and Person name.


## Table 13 of 38: oauth_tokens

**What it is:** Access an app has been given to act for a person.

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `id` | nobody (row key) | none needed | n/a (no Add row) |
| `client_id` | nobody (locked) | none needed | n/a (no Add row) |
| `client_name` | nobody (locked) | worked out, filterable, sortable | n/a (no Add row) |
| `user_id` | nobody (locked) | none needed | n/a (no Add row) |
| `person_name` | nobody (locked) | worked out, filterable, sortable | n/a (no Add row) |
| `scopes` | nobody (locked) | none needed | n/a (no Add row) |
| `access_expires_at` | nobody (locked) | none needed | n/a (no Add row) |
| `refresh_expires_at` | nobody (locked) | none needed | n/a (no Add row) |
| `revoked_at` | owners and administrators | date checked, may be empty | n/a (no Add row) |
| `created_at` | nobody (locked) | none needed | n/a (no Add row) |
| `last_used_at` | nobody (locked) | none needed | n/a (no Add row) |

**Hidden columns (in the database, not shown):** access_hash, refresh_hash, previous_refresh_hash (secrets).

**Adding a row:** not offered (the system creates these rows; a hand-made row would be broken or unsafe).

**Deleting:** owners and administrators can delete. Pop-up note: The app loses its access for this person.

**Changed in this review:** Added Client name and Person name. revoked_at checked as a date. Delete note: the app loses its access.


## Table 14 of 38: payment_methods

**What it is:** Saved payment methods (brand and last four digits only).

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `id` | nobody (read-only table) | none needed | n/a (no Add row) |
| `user_id` | nobody (read-only table) | none needed | n/a (no Add row) |
| `person_name` | nobody (read-only table) | worked out, filterable, sortable | n/a (no Add row) |
| `provider` | nobody (read-only table) | none needed | n/a (no Add row) |
| `brand` | nobody (read-only table) | none needed | n/a (no Add row) |
| `last4` | nobody (read-only table) | none needed | n/a (no Add row) |
| `created_at` | nobody (read-only table) | none needed | n/a (no Add row) |

**Hidden columns (in the database, not shown):** provider_ref (the provider's customer reference).

**Adding a row:** not offered (read-only table).

**Deleting:** not deletable (read-only).

**Changed in this review:** Added Person name (read-only). Stays read-only.


## Table 15 of 38: status_subscribers

**What it is:** People subscribed to status-page emails.

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `id` | nobody (row key) | none needed | n/a (no Add row) |
| `email` | nobody (locked) | none needed | n/a (no Add row) |
| `confirmed_at` | nobody (locked) | none needed | n/a (no Add row) |
| `created_at` | nobody (locked) | none needed | n/a (no Add row) |

**Hidden columns (in the database, not shown):** confirm_token_hash, confirm_expires_at, unsubscribe_token (secrets).

**Adding a row:** not offered (the system creates these rows; a hand-made row would be broken or unsafe).

**Deleting:** owners and administrators can delete.

**Changed in this review:** No change: all locked; delete unsubscribes the address.


## Table 16 of 38: system_state

**What it is:** Small facts the system remembers about itself.

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `key` | nobody (read-only table) | none needed | n/a (no Add row) |
| `value` | nobody (read-only table) | none needed | n/a (no Add row) |
| `updated_at` | nobody (read-only table) | none needed | n/a (no Add row) |

**Hidden columns (in the database, not shown):** None.

**Adding a row:** not offered (read-only table).

**Deleting:** not deletable (read-only).

**Changed in this review:** No change (read-only).


## Table 17 of 38: totp_backup_codes

**What it is:** Two-factor backup codes (the codes are never shown).

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `id` | nobody (read-only table) | none needed | n/a (no Add row) |
| `user_id` | nobody (read-only table) | none needed | n/a (no Add row) |
| `person_name` | nobody (read-only table) | worked out, filterable, sortable | n/a (no Add row) |
| `used_at` | nobody (read-only table) | none needed | n/a (no Add row) |
| `created_at` | nobody (read-only table) | none needed | n/a (no Add row) |

**Hidden columns (in the database, not shown):** code_hash (secret).

**Adding a row:** not offered (read-only table).

**Deleting:** not deletable (read-only).

**Changed in this review:** Added Person name (read-only).


## Table 18 of 38: schema_migrations

**What it is:** Which database changes have been applied.

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `filename` | nobody (read-only table) | none needed | n/a (no Add row) |
| `applied_at` | nobody (read-only table) | none needed | n/a (no Add row) |

**Hidden columns (in the database, not shown):** None.

**Adding a row:** not offered (read-only table).

**Deleting:** not deletable (read-only).

**Changed in this review:** No change (read-only).


## Table 19 of 38: account_suspensions

**What it is:** People whose accounts are switched off for now.

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `user_id` | nobody (locked) | none needed | required, search by name |
| `person_name` | nobody (locked) | worked out, filterable, sortable | blank |
| `suspended_at` | nobody (locked) | none needed | automatic |
| `reason` | owners and administrators | text up to 500, required | required |
| `suspended_by` | nobody (locked) | none needed | automatic |

**Hidden columns (in the database, not shown):** None.

**Adding a row:** must enter: user_id, reason. Pre-filled: none. Automatic: suspended_at, suspended_by.

**Deleting:** owners and administrators can delete. Pop-up note: The person can sign in again.

**Changed in this review:** Added Person name. reason required, up to 500 characters; delete note: the person can sign in again.


## Table 20 of 38: platform_admins

**What it is:** Who has administrator or owner access.

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `user_id` | nobody (read-only table) | none needed | n/a (no Add row) |
| `person_name` | nobody (read-only table) | worked out, filterable, sortable | n/a (no Add row) |
| `role` | nobody (read-only table) | none needed | n/a (no Add row) |
| `note` | nobody (read-only table) | none needed | n/a (no Add row) |
| `added_by_email` | nobody (read-only table) | none needed | n/a (no Add row) |
| `added_at` | nobody (read-only table) | none needed | n/a (no Add row) |
| `promoted_by_email` | nobody (read-only table) | none needed | n/a (no Add row) |
| `promoted_at` | nobody (read-only table) | none needed | n/a (no Add row) |

**Hidden columns (in the database, not shown):** added_by_user_id (the email is shown).

**Adding a row:** not offered (read-only table).

**Deleting:** not deletable (read-only).

**Changed in this review:** Added Person name (read-only). Stays read-only: access is managed in "Who has access", which keeps the owner from being locked out.


## Table 21 of 38: sessions

**What it is:** Browser sign-ins.

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `id` | nobody (row key) | none needed | n/a (no Add row) |
| `user_id` | nobody (locked) | none needed | n/a (no Add row) |
| `person_name` | nobody (locked) | worked out, filterable, sortable | n/a (no Add row) |
| `status` | nobody (locked) | worked out, filterable, sortable | n/a (no Add row) |
| `expires_at` | owners and administrators | date checked | n/a (no Add row) |
| `created_at` | nobody (locked) | none needed | n/a (no Add row) |
| `user_agent` | nobody (locked) | none needed | n/a (no Add row) |
| `ip` | nobody (locked) | none needed | n/a (no Add row) |
| `last_used_at` | nobody (locked) | none needed | n/a (no Add row) |

**Hidden columns (in the database, not shown):** token (secret).

**Adding a row:** not offered (the system creates these rows; a hand-made row would be broken or unsafe).

**Deleting:** owners and administrators can delete.

**Changed in this review:** expires_at is checked as a date (done in this pass for every date column).


## Table 22 of 38: email_tokens

**What it is:** Confirmation and password-reset links that were emailed.

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `id` | nobody (row key) | none needed | n/a (no Add row) |
| `purpose` | nobody (locked) | none needed | n/a (no Add row) |
| `status` | nobody (locked) | worked out, filterable, sortable | n/a (no Add row) |
| `user_id` | nobody (locked) | none needed | n/a (no Add row) |
| `person_name` | nobody (locked) | worked out, filterable, sortable | n/a (no Add row) |
| `sent_to` | nobody (locked) | none needed | n/a (no Add row) |
| `expires_at` | owners and administrators | date checked | n/a (no Add row) |
| `used_at` | owners and administrators | date checked, may be empty | n/a (no Add row) |
| `created_at` | nobody (locked) | none needed | n/a (no Add row) |

**Hidden columns (in the database, not shown):** token (secret).

**Adding a row:** not offered (the system creates these rows; a hand-made row would be broken or unsafe).

**Deleting:** owners and administrators can delete.

**Changed in this review:** expires_at and used_at are checked as dates.


## Table 23 of 38: business_setup_drafts

**What it is:** A person's unfinished business setup.

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `id` | nobody (row key) | none needed | n/a (no Add row) |
| `user_id` | nobody (locked) | none needed | n/a (no Add row) |
| `person_name` | nobody (locked) | worked out, filterable, sortable | n/a (no Add row) |
| `version` | nobody (locked) | none needed | n/a (no Add row) |
| `created_at` | nobody (locked) | none needed | n/a (no Add row) |
| `updated_at` | nobody (locked) | none needed | n/a (no Add row) |
| `business_name` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `is_registered_business` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `formation_state` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `formation_city` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `formation_address` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `formation_place_id` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `business_structure` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `legal_entity` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `tax_election` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `special_legal_designation` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `has_partners` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `number_of_partners` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `regulatory_statuses` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `regulatory_statuses_reviewed` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `s_corp_eligible_owners_confirmed` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `s_corp_single_class_confirmed` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `s_corp_business_eligible_confirmed` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `business_idea` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `idea_industry` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `additional_industries` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `classification_source` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `customer_type` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `customer_problem` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `geographic_scope` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `competitors` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `pricing_hypothesis` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `validation_plan` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `idea_plausible` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `idea_feedback` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `market_research` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `name_availability` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `manual_verification_acknowledged` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `business_plan_mode` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `uploaded_business_plan_name` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `business_plan_sections` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `requirements` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `registered_agent_status` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `registered_agent_name` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `venture_backed` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `wants_stock` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `real_estate_or_holdings` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `wants_liability_protection` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `recommended_legal_entity` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `recommended_tax_election` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `recommended_special_designation` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `recommended_reasons` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `last_analyzed_idea_fingerprint` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `market_research_fingerprint` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `current_step` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |

**Hidden columns (in the database, not shown):** draft_json (replaced by one column per fact).

**Adding a row:** not offered (the system creates these rows; a hand-made row would be broken or unsafe).

**Deleting:** owners and administrators can delete.

**Changed in this review:** No new change (done earlier).


## Table 24 of 38: businesses

**What it is:** Finished businesses, with everything the setup collected.

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `id` | nobody (row key) | none needed | n/a (no Add row) |
| `name` | owners and administrators | text up to 200, required | n/a (no Add row) |
| `industry` | owners and administrators | dropdown: Restaurant, Food Truck, Bakery, Coffee Shop / Cafe, Bar / Tavern, Brewery / Winery, Catering Service, Grocery Store, Convenience Store, Medical Practice, Dental Practice, Mental Health Practice, Physical Therapy Clinic, Chiropractic Practice, Optometry Practice, Pharmacy, Hospital, Home Health Agency, Veterinary Practice, Gym / Fitness Center, Spa / Salon, Barbershop, Tattoo Studio, Personal Training, Auto Repair Shop, Auto Dealership, Collision / Auto Body Repair, Car Wash, General Contractor, Electrical Contractor, Plumbing Contractor, HVAC Contractor, Roofing Contractor, Landscaping, Concrete Contractor, Painting Contractor, Excavation Contractor, Light Manufacturing, Heavy Manufacturing, Food Manufacturing, Chemical Manufacturing, Real Estate Brokerage / Agent, Property Management, Real Estate Developer, Short-Term Rental, Hotel / Motel / Inn, Bed & Breakfast, Law Firm, Financial Advisor, Insurance Agency, Mortgage Broker, Accounting / Bookkeeping / Tax Preparation, Bank / Financial Institution, Credit Union, Engineering Firm, Childcare Center / Daycare, Private School, Tutoring Center, Driving School, Retail Store, Liquor Store, Cannabis Dispensary, Pawn Shop, Firearms Dealer, Secondhand / Consignment Store, E-commerce / Online Store, Dropshipping / Reselling, Print on Demand, Handmade / Craft Business, Trucking / Freight / Transportation, Taxi / Rideshare / Limo, Moving Company, Courier / Delivery Service, Waste Management, Warehousing / Self-Storage, Software Development, IT / Managed Services, AI Services, Cybersecurity Services, Staffing Agency, Security Guard Company, Cleaning / Janitorial Service, Pest Control, Consulting / Professional Services, Marketing Agency, PR / Public Relations, Social Media Management, Virtual Assistant Services, Translation Services, Farm / Agricultural Operation, Nursery / Greenhouse, Solar Energy Installer, Utility / Pipeline Contractor, Photography / Videography, Graphic Design, Content Creator, Event Planning, Wedding Services, Music / Entertainment, Funeral Home, Nonprofit Organization, Pet Services, Subscription Box Business, Import / Export, Home Daycare, Laundromat / Dry Cleaning | n/a (no Add row) |
| `created_at` | nobody (locked) | none needed | n/a (no Add row) |
| `updated_at` | nobody (locked) | none needed | n/a (no Add row) |
| `business_name` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `is_registered_business` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `formation_state` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `formation_city` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `formation_address` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `formation_place_id` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `business_structure` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `legal_entity` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `tax_election` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `special_legal_designation` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `has_partners` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `number_of_partners` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `regulatory_statuses` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `regulatory_statuses_reviewed` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `s_corp_eligible_owners_confirmed` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `s_corp_single_class_confirmed` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `s_corp_business_eligible_confirmed` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `business_idea` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `idea_industry` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `additional_industries` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `classification_source` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `customer_type` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `customer_problem` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `geographic_scope` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `competitors` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `pricing_hypothesis` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `validation_plan` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `idea_plausible` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `idea_feedback` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `market_research` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `name_availability` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `manual_verification_acknowledged` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `business_plan_mode` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `uploaded_business_plan_name` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `business_plan_sections` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `requirements` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `registered_agent_status` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `registered_agent_name` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `venture_backed` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `wants_stock` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `real_estate_or_holdings` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `wants_liability_protection` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `recommended_legal_entity` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `recommended_tax_election` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `recommended_special_designation` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `recommended_reasons` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `last_analyzed_idea_fingerprint` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `market_research_fingerprint` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |
| `current_step` | nobody (worked out) | worked out, filterable, sortable; typed fact, checked by kind | n/a (no Add row) |

**Hidden columns (in the database, not shown):** business_json (replaced by one column per fact); user_id (the creator; who belongs is in Business memberships).

**Adding a row:** not offered (the system creates these rows; a hand-made row would be broken or unsafe).

**Deleting:** owners and administrators can delete. The pop-up lists the members who have joined, pending in-app and email invitations, and keys limited to the business.

**Changed in this review:** name is required, up to 200 characters. user_id removed from the tab.


## Table 25 of 38: business_memberships

**What it is:** Who belongs to which business, in what role.

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `id` | nobody (row key) | none needed | automatic |
| `business_id` | nobody (locked) | none needed | required, search by name |
| `user_id` | nobody (locked) | none needed | required, search by name |
| `role` | owners and administrators | dropdown: owner, admin, member, accountant | required, starts as member, dropdown |
| `invited_by_user_id` | nobody (locked) | none needed | automatic |
| `invited_at` | owners and administrators | date checked | automatic |
| `accepted_at` | owners and administrators | date checked, may be empty | optional, starts as now |
| `created_at` | nobody (locked) | none needed | automatic |
| `updated_at` | nobody (locked) | none needed | automatic |
| `person_name` | nobody (locked) | worked out, filterable, sortable | blank |
| `business_name` | nobody (locked) | worked out, filterable, sortable | blank |
| `inviter_name` | nobody (locked) | worked out, filterable, sortable | blank |

**Hidden columns (in the database, not shown):** None.

**Adding a row:** must enter: business_id, user_id. Pre-filled: role, accepted_at. Automatic: id, invited_by_user_id, invited_at, created_at, updated_at.

**Deleting:** owners and administrators can delete. Plain confirmation, plus a warning when it is the business's last joined member.

**Changed in this review:** Added Inviter name (read-only).


## Table 26 of 38: plans

**What it is:** The price list: price, included usage and limits.

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `id` | nobody (row key) | none needed | automatic |
| `name` | owners and administrators | text up to 100, required | required |
| `monthly_price_cents` | owners and administrators | whole number 0+ | required, starts as 0 |
| `included_analyses` | owners and administrators | whole number 0+ | required, starts as 0 |
| `overage_cents_per_analysis` | owners and administrators | whole number 0+ | optional |
| `max_keys` | owners and administrators | whole number 1+ | required, starts as 1 |
| `max_webhooks` | owners and administrators | whole number 0+ | required, starts as 0 |
| `max_apps` | owners and administrators | whole number 0+ | required, starts as 0 |
| `service_per_minute` | owners and administrators | whole number 1+ | required, starts as 1 |
| `service_per_month` | owners and administrators | whole number 1+ | required, starts as 1 |
| `total_per_minute` | owners and administrators | whole number 1+ | required, starts as 1 |
| `total_per_month` | owners and administrators | whole number 1+ | required, starts as 1 |
| `overage_cents_per_call` | owners and administrators | whole number 0+ | optional |
| `active` | owners and administrators | true/false | required, starts as false |
| `sort_order` | owners and administrators | whole number 0+ | required, starts as 0 |
| `subscribers` | nobody (locked) | worked out, filterable, sortable | blank |

**Hidden columns (in the database, not shown):** description (removed earlier by you).

**Adding a row:** must enter: name. Pre-filled: monthly_price_cents, included_analyses, max_keys, max_webhooks, max_apps, service_per_minute, service_per_month, total_per_minute, total_per_month, active, sort_order. Automatic: id.

**Deleting:** owners and administrators can delete; the Free-plan and in-use checks apply. Blocked for Free and for any plan still used by subscriptions or invoices; the pop-up says why and to switch it off instead.

**Changed in this review:** name required, up to 100 characters; the limits that cannot be 0 now say so ("from 1 up").


## Table 27 of 38: subscriptions

**What it is:** Each person's or team's plan and billing period.

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `id` | nobody (row key) | none needed | automatic |
| `subject_type` | nobody (locked) | none needed | required, starts as user, dropdown |
| `subject_id` | nobody (locked) | none needed | required, search by name |
| `subscriber_name` | nobody (locked) | worked out, filterable, sortable | blank |
| `plan_id` | owners and administrators | dropdown of plans | required, starts as free, search by name |
| `status` | owners and administrators | dropdown: active, past_due, canceled | required, starts as active, dropdown |
| `period_start` | owners and administrators | date checked, end after start | required, starts as now |
| `period_end` | owners and administrators | date checked, end after start | required, starts as a month from now |
| `provider` | owners and administrators | text up to 50, required | required, starts as manual |
| `provider_ref` | owners and administrators | text up to 200, may be empty | optional |
| `created_at` | nobody (locked) | none needed | automatic |
| `canceled_at` | owners and administrators | date checked, may be empty | blank |
| `scheduled_plan_id` | owners and administrators | none needed | blank |
| `scheduled_for` | owners and administrators | date checked, may be empty | blank |

**Hidden columns (in the database, not shown):** None.

**Adding a row:** must enter: subject_id. Pre-filled: subject_type, plan_id, status, provider, period_start, period_end. Automatic: id, created_at.

**Deleting:** owners and administrators can delete. The pop-up says the person (or team) goes back to the Free plan.

**Changed in this review:** plan_id is a dropdown of the plans; canceled_at and scheduled_for are checked as dates; provider required (50 characters), provider_ref up to 200.


## Table 28 of 38: invoices

**What it is:** Bills: who, which plan and period, line items, paid or not.

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `id` | nobody (row key) | none needed | automatic |
| `number` | owners and administrators | whole number 1+ | automatic |
| `subject_type` | nobody (locked) | none needed | required, starts as user, dropdown |
| `subject_id` | nobody (locked) | none needed | required, search by name |
| `subscriber_name` | nobody (locked) | worked out, filterable, sortable | blank |
| `plan_id` | owners and administrators | dropdown of plans | required, starts as free, search by name |
| `period_start` | owners and administrators | date checked, end after start | required, starts as now |
| `period_end` | owners and administrators | date checked, end after start | required, starts as a month from now |
| `currency` | owners and administrators | text up to 3, required, fixed form | required, starts as usd |
| `lines` | owners and administrators | list of items with amounts | required, starts as [] |
| `subtotal_cents` | nobody (locked) | follows the lines | automatic |
| `status` | owners and administrators | dropdown: draft, open, paid, void | required, starts as draft, dropdown |
| `created_at` | nobody (locked) | none needed | automatic |

**Hidden columns (in the database, not shown):** None.

**Adding a row:** must enter: subject_id. Pre-filled: subject_type, plan_id, period_start, period_end, currency, lines, status. Automatic: id, number, subtotal_cents, created_at.

**Deleting:** never deleted, by anyone: an invoice is a financial record, so the way to remove one is to mark it void.

**Changed in this review:** created_at and subtotal_cents locked; currency must be a three-letter code; lines must be a list of items with description, quantity, unitCents, totalCents; the subtotal is recalculated when lines are edited; the end must be after the start; plan_id is a dropdown; the duplicate-period error is in plain words; it can no longer be deleted by anyone (mark it void); Add row pre-fills user, now to a month on.


## Table 29 of 38: usage_meter

**What it is:** Market analyses used per person per month.

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `subject_type` | nobody (locked) | none needed | required, starts as user, dropdown |
| `subject_id` | nobody (locked) | none needed | required, search by name |
| `subscriber_name` | nobody (locked) | worked out, filterable, sortable | blank |
| `month` | nobody (locked) | text up to 7, required, fixed form | required, starts as this month (2026-10) |
| `metric` | nobody (locked) | dropdown: market_analyses | required, starts as market_analyses, dropdown |
| `quantity` | owners and administrators | whole number 0+ | required, starts as 0 |

**Hidden columns (in the database, not shown):** None.

**Adding a row:** must enter: subject_id. Pre-filled: subject_type, month, metric, quantity. Automatic: none.

**Deleting:** owners and administrators can delete. Pop-up note: This resets that month's count, so the person gets that month's included analyses back.

**Changed in this review:** Key columns locked (only quantity is editable); metric is a dropdown; month must look like 2026-10; Add row pre-fills user, this month, market_analyses; duplicate error in plain words; Subscriber name added.


## Table 30 of 38: api_usage

**What it is:** Calls per person per API per minute or month.

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `user_id` | nobody (locked) | none needed | required, search by name |
| `person_name` | nobody (locked) | worked out, filterable, sortable | blank |
| `service` | nobody (locked) | dropdown: desk_api, registry_api, market_validation_api | required, dropdown |
| `window_key` | nobody (locked) | text up to 20, required, fixed form | required, starts as this month (M2026-10) |
| `calls` | owners and administrators | whole number 0+ | required, starts as 0 |

**Hidden columns (in the database, not shown):** None.

**Adding a row:** must enter: user_id, service. Pre-filled: window_key, calls. Automatic: none.

**Deleting:** owners and administrators can delete. Pop-up note: This resets that call counter, so the person gets those calls back.

**Changed in this review:** Key columns locked (only calls is editable); window_key must look like m2026-10-07T14:05 or M2026-10; Add row pre-fills this month's key; Person name added.


## Table 31 of 38: incidents

**What it is:** Status-page incidents.

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `id` | nobody (row key) | none needed | automatic |
| `title` | owners and administrators | text up to 200, required | required |
| `severity` | owners and administrators | dropdown: minor, major, critical | required, starts as minor, dropdown |
| `status` | owners and administrators | dropdown: investigating, identified, monitoring, resolved | required, starts as investigating, dropdown |
| `started_at` | nobody (locked) | none needed | automatic |
| `resolved_at` | owners and administrators | date checked, may be empty | optional |

**Hidden columns (in the database, not shown):** None.

**Adding a row:** must enter: title. Pre-filled: severity, status. Automatic: id, started_at.

**Deleting:** owners and administrators can delete. Pop-up note: The incident disappears from the status page. Counts: incident updates.

**Changed in this review:** started_at locked; resolving stamps resolved_at; resolved_at cannot be before started_at; title required up to 200; Add row pre-fills minor and investigating (a resolved incident added gets resolved_at stamped).


## Table 32 of 38: incident_updates

**What it is:** Updates posted on an incident.

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `id` | nobody (row key) | none needed | automatic |
| `incident_id` | nobody (locked) | none needed | required, search by name |
| `incident_title` | nobody (locked) | worked out, filterable, sortable | blank |
| `status` | owners and administrators | dropdown: investigating, identified, monitoring, resolved | required, starts as investigating, dropdown |
| `message` | owners and administrators | text up to 2000, required | required |
| `created_at` | nobody (locked) | none needed | automatic |

**Hidden columns (in the database, not shown):** None.

**Adding a row:** must enter: incident_id, message. Pre-filled: status. Automatic: id, created_at.

**Deleting:** owners and administrators can delete.

**Changed in this review:** incident_id and created_at locked; Incident title added; message required up to 2000; Add row pre-fills investigating.


## Table 33 of 38: webhook_endpoints

**What it is:** Addresses a person asked to be notified at.

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `id` | nobody (row key) | none needed | n/a (no Add row) |
| `owner_user_id` | nobody (locked) | none needed | n/a (no Add row) |
| `owner_name` | nobody (locked) | worked out, filterable, sortable | n/a (no Add row) |
| `url` | owners and administrators | text up to 500, required | n/a (no Add row) |
| `events` | nobody (locked) | none needed | n/a (no Add row) |
| `active` | owners and administrators | true/false | n/a (no Add row) |
| `consecutive_failures` | owners and administrators | whole number 0+ | n/a (no Add row) |
| `disabled_reason` | owners and administrators | text up to 200, may be empty | n/a (no Add row) |
| `created_at` | nobody (locked) | none needed | n/a (no Add row) |

**Hidden columns (in the database, not shown):** secret_enc, team_id (secret / internal).

**Adding a row:** not offered (the system creates these rows; a hand-made row would be broken or unsafe).

**Deleting:** owners and administrators can delete. Pop-up note: No more events are sent to this address. Counts: recorded deliveries.

**Changed in this review:** owner, events and created_at locked; url must be a safe address (the same check the app uses); switching on resets failures and the reason; switching off records "Switched off by an administrator."; Owner name added; delete note lists the recorded deliveries.


## Table 34 of 38: webhook_deliveries

**What it is:** A record of each notification sent.

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `id` | nobody (row key) | none needed | n/a (no Add row) |
| `endpoint_id` | nobody (locked) | none needed | n/a (no Add row) |
| `endpoint_url` | nobody (locked) | worked out, filterable, sortable | n/a (no Add row) |
| `event_id` | nobody (locked) | none needed | n/a (no Add row) |
| `event_type` | nobody (locked) | none needed | n/a (no Add row) |
| `status` | nobody (locked) | none needed | n/a (no Add row) |
| `attempts` | nobody (locked) | none needed | n/a (no Add row) |
| `next_attempt_at` | nobody (locked) | none needed | n/a (no Add row) |
| `last_status` | nobody (locked) | none needed | n/a (no Add row) |
| `last_error` | nobody (locked) | none needed | n/a (no Add row) |
| `created_at` | nobody (locked) | none needed | n/a (no Add row) |
| `delivered_at` | nobody (locked) | none needed | n/a (no Add row) |

**Hidden columns (in the database, not shown):** payload (the event body).

**Adding a row:** not offered (the system creates these rows; a hand-made row would be broken or unsafe).

**Deleting:** owners and administrators can delete.

**Changed in this review:** Every column locked (it is a record); Endpoint url added.


## Table 35 of 38: oauth_clients

**What it is:** Apps registered to sign people in.

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `id` | nobody (row key) | none needed | n/a (no Add row) |
| `owner_user_id` | nobody (locked) | none needed | n/a (no Add row) |
| `owner_name` | nobody (locked) | worked out, filterable, sortable | n/a (no Add row) |
| `name` | owners and administrators | text up to 64, required | n/a (no Add row) |
| `redirect_uris` | nobody (locked) | none needed | n/a (no Add row) |
| `scopes` | nobody (locked) | none needed | n/a (no Add row) |
| `created_at` | nobody (locked) | none needed | n/a (no Add row) |
| `revoked_at` | owners and administrators | date checked, may be empty | n/a (no Add row) |

**Hidden columns (in the database, not shown):** secret_hash (secret).

**Adding a row:** not offered (the system creates these rows; a hand-made row would be broken or unsafe).

**Deleting:** owners and administrators can delete. Pop-up note: The app can no longer sign anyone in. Counts: access given to the app (the app loses it); sign-in codes not yet used.

**Changed in this review:** owner, redirect addresses, scopes and created_at locked; name required up to 64; revoked_at checked as a date; Owner name added; delete note lists the access given.


## Table 36 of 38: gateway_api_keys

**What it is:** People's API keys (the key itself is never shown).

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `id` | nobody (row key) | none needed | n/a (no Add row) |
| `owner_user_id` | nobody (locked) | none needed | n/a (no Add row) |
| `owner_name` | nobody (locked) | worked out, filterable, sortable | n/a (no Add row) |
| `label` | owners and administrators | text up to 64, required | n/a (no Add row) |
| `key_prefix` | nobody (locked) | none needed | n/a (no Add row) |
| `sandbox` | nobody (locked) | none needed | n/a (no Add row) |
| `rate_limit_per_minute` | owners and administrators | whole number 1-6000 | n/a (no Add row) |
| `created_at` | nobody (locked) | none needed | n/a (no Add row) |
| `last_used_at` | nobody (locked) | none needed | n/a (no Add row) |
| `expires_at` | owners and administrators | date checked, may be empty | n/a (no Add row) |
| `revoked_at` | nobody (locked) | none needed | n/a (no Add row) |

**Hidden columns (in the database, not shown):** key_hash (secret), desk_scopes, allowed_ips, restricted_business_id, team_id (key settings the owner manages in the app).

**Adding a row:** not offered (the system creates these rows; a hand-made row would be broken or unsafe).

**Deleting:** owners and administrators can delete. Pop-up note: The key stops working at once, and its keys at the other APIs are ended. Counts: API grants (which APIs the key can call); shares with other people; days of usage history; a suspension record.

**Changed in this review:** owner, key prefix, sandbox, created_at, last_used_at and revoked_at locked (revoking is done by deleting, which now ends the key and its backend keys first); label 1-64 characters; rate limit 1-6000; expires_at checked as a date; Owner name added; delete note lists what goes with the key.


## Table 37 of 38: mutation_audit_log

**What it is:** Every change made by a person or an admin tool.

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `id` | nobody (read-only table) | none needed | n/a (no Add row) |
| `user_email` | nobody (read-only table) | none needed | n/a (no Add row) |
| `action` | nobody (read-only table) | none needed | n/a (no Add row) |
| `entity_type` | nobody (read-only table) | none needed | n/a (no Add row) |
| `entity_id` | nobody (read-only table) | none needed | n/a (no Add row) |
| `before` | nobody (read-only table) | none needed | n/a (no Add row) |
| `after` | nobody (read-only table) | none needed | n/a (no Add row) |
| `ip_address` | nobody (read-only table) | none needed | n/a (no Add row) |
| `user_agent` | nobody (read-only table) | none needed | n/a (no Add row) |
| `created_at` | nobody (read-only table) | none needed | n/a (no Add row) |

**Hidden columns (in the database, not shown):** user_id (the email is shown).

**Adding a row:** not offered (read-only table).

**Deleting:** not deletable (read-only).

**Changed in this review:** Browser (user_agent) now shown. Read-only.


## Table 38 of 38: security_events

**What it is:** Sign-in and security events.

| Column | Who can edit | Checks on edit | On Add row |
|---|---|---|---|
| `id` | nobody (read-only table) | none needed | n/a (no Add row) |
| `user_id` | nobody (read-only table) | none needed | n/a (no Add row) |
| `person_name` | nobody (read-only table) | worked out, filterable, sortable | n/a (no Add row) |
| `subject` | nobody (read-only table) | none needed | n/a (no Add row) |
| `event` | nobody (read-only table) | none needed | n/a (no Add row) |
| `outcome` | nobody (read-only table) | none needed | n/a (no Add row) |
| `ip_address` | nobody (read-only table) | none needed | n/a (no Add row) |
| `user_agent` | nobody (read-only table) | none needed | n/a (no Add row) |
| `created_at` | nobody (read-only table) | none needed | n/a (no Add row) |

**Hidden columns (in the database, not shown):** detail (extra JSON).

**Adding a row:** not offered (read-only table).

**Deleting:** not deletable (read-only).

**Changed in this review:** Added Person name and Browser (user_agent). Read-only.


---

# Registry API tables (5 + 9 read-only views)

Who can edit: owners and administrators alike, except locked columns. "Locked" = system-written or part of the row's identity.

## R1: state_business_registry_sources
**What it is:** one row per state: where its business records come from, how often they are synced, and how healthy the live lookups are.

| Column | Edit | Checks | On Add row |
|---|---|---|---|
| `state_code` | nobody (row key) | two capital letters | required, typed |
| `state_name` | yes | required, up to 100 | required |
| `sync_status` | yes | dropdown of the six statuses | required, starts as not_implemented |
| `source_name` | yes | required, up to 200 | required |
| `source_url` | yes | a web address, may be empty | optional |
| `terms_url` | yes | a web address, may be empty | optional |
| `last_synced_at` | locked (the sync job) | n/a | automatic |
| `next_sync_after` | yes | real date and time, may be empty | optional |
| `freshness_days` | yes | whole number 1 to 3650 | required, starts as 30 |
| `notes` | yes | up to 2000, may be empty | optional |
| `created_at`, `updated_at` | locked | n/a | automatic |
| `checker_status`, `checker_last_check_at`, `checker_last_success_at`, `checker_last_failure_at`, `checker_consecutive_failures`, `checker_last_error`, `checker_avg_response_ms`, `checker_updated_at` | locked (written by the live checkers) | n/a | blank |
| `dba_live_check_available`, `business_name_live_check_available` | locked (what the code can do) | n/a | blank |

Hidden: none. Delete: blocked while any registry entry uses the state ("N registry entries use this state, so it cannot be deleted"); otherwise its sync runs go with it. Duplicate code: "A state with that code already exists."

## R2: business_name_registry_entries
**What it is:** the synced list of registered business names (millions of rows).

| Column | Edit | Checks | On Add row |
|---|---|---|---|
| `id` | nobody (row key) | n/a | automatic |
| `state_code` | locked (identity) | n/a | required, dropdown of state codes; must exist in the sources list |
| `entity_name` | yes | required, up to 500 | required |
| `normalized_name` | locked (made by the database) | n/a | automatic |
| `entity_id`, `entity_type`, `status` | yes | up to 100, may be empty | optional |
| `active` | yes | true or false | required, starts as true |
| `city` | yes | up to 100, may be empty | optional |
| `source_name` | yes | required, up to 200 | required, starts as "Added by hand" |
| `source_url` | yes | a web address, may be empty | optional |
| `source_record_id` | yes | up to 200, may be empty | optional |
| `source_key` | locked (the sync's identity for the row) | n/a | automatic (marked as added by hand) |
| `filing_date` | yes | a real date (YYYY-MM-DD), may be empty | optional |
| `last_seen_at`, `created_at`, `updated_at` | locked | n/a | automatic |
| `raw_record` | locked (the original record; JSON, hidden by default in the page) | n/a | automatic |

Hidden: none (raw_record is read-only and collapsed by default). Delete: allowed; "a later sync may add this record back from the official source (a record added by hand is not synced)."

## R3: business_name_registry_sync_runs
**What it is:** one row per sync run. A record of what happened. All columns locked (it can be deleted to tidy up). No Add row. Hidden: `idempotency_key` (internal). Columns: id, state_code, source_name, status, records_seen, records_upserted, error_message, started_at, finished_at.

## R4: business_structures
**What it is:** the legal-structure reference list the /business-structures answers come from (live within a minute).

| Column | Edit | Checks | On Add row |
|---|---|---|---|
| `slug` | nobody (row key) | lower-case letters, digits, underscores | required |
| `name` | yes | required, up to 200 | required |
| `category` | yes | dropdown of the five categories | required |
| `family` | yes | dropdown of the ten families | required |
| `aliases`, `best_for`, `cautions` | yes | a list of words (up to 50 items) | required, start as an empty list |
| `summary`, `ownership`, `liability`, `taxation`, `management`, `formation` | yes | required, up to 4000 | required |
| `variants`, `tax_election_options`, `jurisdiction_notes`, `countries`, `related_structures` | yes | a list of words, may be empty | optional |
| `sort_order` | yes | whole number 0 to 100000 | required, starts as 0 |
| `created_at`, `updated_at` | locked | n/a | automatic |

Delete: allowed; "It disappears from the business-structures answers at once. Other structures that list it as related are not changed."

## R5: availability_check_log
**What it is:** one row per availability check, kept 90 days. Read-only, no Add row, not deletable. Columns: id, checked_at, check_type, state_code, query_name, result, method, duration_ms, names_checked. All shown, nothing sensitive.

## R6 to R14: read-only views (rules held in code, and live state)
name_match_scores, name_word_lists, name_normalization_rules, phonetic_rules, reserved_word_rules, live_checkers, business_structure_recommender_rules, rate_limits (rules); circuit_breakers, result_cache (live). Read-only by design, no dates or numbers to check, every column shown. No change.

---

# Market Validation API tables (7)

Same rules: owners and administrators alike; locked columns are keys and import times.

## M1: oews_wage_rows
**What it is:** wages by occupation and area from the BLS survey.

| Column | Edit | Checks | On Add row |
|---|---|---|---|
| `dataset_year` | locked (key) | whole number 1990 to 2100 | required |
| `area_code` | locked (key) | digits only | required |
| `occupation_code` | locked (key) | the form 11-1011 | required |
| `area_name`, `occupation_title` | yes | required, up to 200 | required |
| `state_code` | yes | two capital letters | required |
| `employment` | yes | whole number 0+, may be empty | optional (not every row has it) |
| `hourly_mean_wage`, `hourly_median_wage` | yes | number 0 to 10000, may be empty | optional |
| `annual_mean_wage`, `annual_median_wage` | yes | whole number 0 to 100 million, may be empty | optional |
| `source_url` | yes | a web address | required |
| `imported_at` | locked | n/a | automatic |

## M2: import_runs
**What it is:** the history of the four data imports. Only `status` (dropdown: running, completed, failed, skipped) and `finished_at` (real date; cannot be before the run started) are editable, to unstick a run left running. Everything else (id, job, started_at, the counters, errors, message, shard plan) is locked. No Add row. Delete: "only the history row is removed."

## M3: market_reference_values
Keys locked (`metric`, `jurisdiction_level`, `geo_id`); `geo_name` required up to 200; `state_fips` two digits or empty; `value` a number; `fetched_at` locked. Add row: `jurisdiction_level` is a dropdown (place, county, state, national); `metric` lower-case letters, digits and underscores.

## M4: market_reference_breakpoints
Keys locked (`metric`, `jurisdiction_level`); `p10` to `p90` numbers that must rise from p10 to p90 (checked on edit and add); `sample_size` whole number 0+; `computed_at` locked.

## M5: market_commuter_density
`county_fips` (row key, five digits); `state_fips` two digits; `geo_name` required; `workplace_jobs` whole number 0+; `fetched_at` locked.

## M6: market_industry_dynamics
`naics` (row key, two to six digits); `data_year` 1990 to 2100; `exit_rate` 0 to 100; `entry_rate` 0 to 100 or empty; `establishments` whole number 0+; `fetched_at` locked. An edit can take up to an hour to show in a score (memory cache).

## M7: market_sba_lending
Keys locked (`state_fips` two digits, `naics_sector` industry digits); `loan_count` whole number 0+; `total_gross_approval` number 0+; `fetched_at` locked.

For M3 to M7 the delete note says the next import may put the row back. All seven market tables have an Add row; none has a default for a required value (they are measurements), and the empty-allowed ones are the real optional figures.
