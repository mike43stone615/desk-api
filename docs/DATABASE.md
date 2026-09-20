# The database: what points at what, and how it changes

Generated from the real schema (September 2026); regenerate the table when a migration adds a relation.

## What is deleted along with what (`ON DELETE`)

| Table | Column | Points at | When that row is deleted |
| --- | --- | --- | --- |
| `sessions` | `user_id` | `users` | the session goes |
| `password_reset_tokens`, `email_confirmation_tokens` | `user_id` | `users` | the tokens go |
| `business_setup_drafts` | `user_id` | `users` | the drafts go |
| `businesses` | `user_id` | `users` | the business goes — **unless** other people belong to it (trigger `trg_users_keep_shared_businesses`, migration 0011: it is handed to another owner/admin/member first) |
| `business_memberships` | `user_id` | `users` | their memberships go |
| `business_memberships` | `business_id` | `businesses` | memberships go with the business |
| `business_memberships`, `business_email_invites` | `invited_by_user_id` | `users` | set to empty (the invitation stays) |
| `business_email_invites` | `business_id` | `businesses` | invitations go with the business |
| `gateway_api_keys` | `owner_user_id` | `users` | the person's keys go |
| `gateway_api_key_grants` | `api_key_id` | `gateway_api_keys` | grants go with the key; trigger `trg_gateway_grant_queue_backend_revocation` (migration 0010) first queues each backend key in `gateway_backend_key_revocations`, and the sweeper revokes it upstream within minutes |
| `security_events` | `user_id` | `users` | set to empty; account deletion deletes the person's events explicitly first |

`mutation_audit_log`, `idempotency_keys` and `gateway_backend_key_revocations` have no foreign keys.

## Migrations
- Files `migrations/NNNN_name.sql`, applied in order, each once (`schema_migrations`). They are additive: new tables and
  columns, never a drop of something the previous version uses, so the previous version keeps working on the new schema
  (this is what makes a code rollback safe, see ROLLBACK.md).
- Deploys **never** run migrations, and a deploy is refused while the version it carries has unapplied ones. Apply by
  hand: `npm run migrate -- --dry-run --production --env-file <live .env>`, then without `--dry-run`.
- There are no down-migrations. Each migration's own header says how to undo it by hand if it ever has to be.
  Recovery from a bad migration is: stop the deploy, restore the newest backup taken before it (BACKUP-RESTORE.md),
  or write a follow-up migration that repairs forward.
- Timestamps in the older tables are ISO-8601 **text** (a deliberate carry-over from the first version's storage; they
  sort and compare correctly as text). Newer tables use real timestamps. Converting them is a large migration with no
  user-visible benefit and is intentionally not planned.
