# Team and organization keys: design (September 2026)

Today a key belongs to one person and dies with their account. A team needs keys that outlive one person and are managed
by several. This page is the design. It is written down and **not built**, because building it needs three decisions that
are the owner's, and changes what an account owns (deletion, export and suspension all touch it).

## Decisions needed

1. **Who is limited?** Limits and the daily market-analysis cap are per key today. A team key would need a team allowance
   shared across its keys, or stay per key.
2. **Who may do what?** Proposed roles: `owner` (everything, can delete the team), `admin` (create/revoke keys, invite),
   `developer` (create their own keys, see usage), `viewer` (see usage only).
3. **Is a team a business?** Reusing business membership (owner/admin/member) needs no new people model but makes every
   business a team. A separate `teams` table is cleaner and costs one small migration.

## Proposed model (recommended: separate teams)

- `teams (id, name, created_by, created_at)` and `team_members (team_id, user_id, role, accepted_at)`.
- `gateway_api_keys` gains a nullable `team_id`. A key with a `team_id` belongs to the team: any `admin`/`owner` can revoke
  it, its usage is visible to `viewer` and above, and it survives its creator leaving (the creator is recorded for audit).
- Deleting a person hands their team keys to the team (no key silently stops working); the last owner cannot leave.
- Scopes, expiry, limits and suspension apply to team keys unchanged.
- API: `POST /teams`, `GET /teams`, `POST /teams/:id/members`, and `teamId` on `POST /gateway/api-keys`.

## Why not now

It is roughly two days of work plus screens, and no team is asking for it yet. When it is wanted, the three decisions above
are the only things blocking the build.
