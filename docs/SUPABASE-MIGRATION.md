# Supabase Migration Plan

## What needs to be migrated from Supabase

| Component | Status | Notes |
|---|---|---|
| Supabase Edge Functions | **Replaced** | Moved into Cloudflare Worker |
| Supabase Auth (users) | **Manual migration** | Passwords cannot be copied directly |
| Supabase Auth (sessions) | **Not migrated** | Users re-authenticate against new system |
| Supabase Storage | **Not used** | No files were stored in Supabase Storage |
| Supabase Realtime | **Not used** | Not used in this app |
| Supabase RLS policies | **Replaced** | Auth logic is now in the Worker |
| Row-level security | **Replaced** | Tenant filtering is done in route handlers |
| Supabase config.toml | **Removable** | After migration is complete |
| Email templates | **Portable** | HTML templates in `supabase/templates/` |

---

## Edge Functions → Cloudflare Worker

The two Edge Functions have been replaced by equivalent Cloudflare Worker routes:

| Supabase Edge Function | Cloudflare Worker route |
|---|---|
| `analyze-business-setup` | `POST /functions/v1/analyze-business-setup` |
| `search-place-areas` | `POST /functions/v1/search-place-areas` |

**No Flutter client changes are required.** The route paths and request/response shapes
are identical.

---

## User migration

### The problem

Supabase Auth stores passwords as bcrypt hashes. These hashes cannot be copied to the
new system because:
1. The Web Crypto API (used in Cloudflare Workers) does not support bcrypt.
2. Password hashes are one-way — the plaintext password cannot be recovered.

### Solution: forced password reset

1. Export the user list from Supabase (email addresses only — **do not export hashes**).
2. Import email addresses into D1 using the migration script below.
3. Set a temporary flag indicating password is unset.
4. Redirect users to set a new password on first login.

### Migration script

```bash
# Export user emails from Supabase
supabase db dump --data-only --table auth.users > supabase_users.sql
# Or via Supabase Management API:
# GET https://api.supabase.com/v1/projects/{ref}/users

# Import to D1 (replace EMAIL_LIST with actual emails)
npx wrangler d1 execute desk-api-db --remote --command \
  "INSERT OR IGNORE INTO users (id, email, password_hash) VALUES (lower(hex(randomblob(16))), 'user@example.com', 'NEEDS_RESET');"
```

### First-login password reset flow

When a user tries to sign in and the `password_hash` is `NEEDS_RESET`:
1. `DeskAuthService.signIn()` detects the sentinel and throws `AuthError('password_reset_required')`.
2. The API returns HTTP 401 with `{ "error": "password_reset_required" }`.
3. `AuthController.signIn()` in the Flutter app catches the error, emits a `DeskAuthState` with `pendingPasswordReset: true` and `pendingPasswordResetEmail` set.
4. The UI listens to `authStateChanges` and routes to the password reset screen when `pendingPasswordReset` is true.
5. The user completes `POST /auth/password-reset/request` (sends reset email) then confirms via `POST /auth/password-reset/confirm`.

**Action required in UI:** Any page or widget listening to `authStateChanges` that shows a login form should check `state.pendingPasswordReset` and navigate to the password reset screen when true.

### Alternative: all-users forced reset email

Send a password reset email to all migrated users before going live. Mark existing
Supabase sessions as expired so users must reset before they can access the new system.

---

## Active sessions

Supabase sessions (JWT-based) are not transferable to the new opaque-token system.
All users must re-authenticate when the migration is live.

This is expected behavior. No session migration is required.

---

## Verification steps after migration

```bash
# Verify user count matches Supabase export
npx wrangler d1 execute desk-api-db --remote --command "SELECT COUNT(*) FROM users;"

# Verify no orphaned sessions
npx wrangler d1 execute desk-api-db --remote --command \
  "SELECT COUNT(*) FROM sessions WHERE user_id NOT IN (SELECT id FROM users);"

# Test sign-up with a new account
curl -X POST https://your-worker.workers.dev/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"test-migration@example.com","password":"TestMigration1!"}'

# Test sign-in
curl -X POST https://your-worker.workers.dev/auth/signin \
  -H "Content-Type: application/json" \
  -d '{"email":"test-migration@example.com","password":"TestMigration1!"}'
```

---

## Removing Supabase

Once migration is verified:

1. Pause the Supabase project (do not delete — keep as backup for 30 days).
2. Remove `desk_business/supabase/` directory.
3. Remove Supabase environment variables from all deployment configs.
4. After 30 days with no issues, delete the Supabase project.

**Do not delete the Supabase project until all users have successfully logged in to the
new system and the old project has been inactive for at least 30 days.**
