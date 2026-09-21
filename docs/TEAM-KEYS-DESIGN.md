# Team keys (built 21 September 2026)

Several people share API keys and one allowance. Decided by the owner on 21 September 2026: **limits are shared across a
team; roles are owner, admin, developer and viewer; a team is its own table, not a business.**

## How it works

- `teams` and `team_members` (migration 0021). A person joins only by accepting an invitation; an invitation gives nothing until
  then. Inviting works only for accounts that exist, and the answer is the same for an address that has none.
- A key with a `team_id` belongs to the team, not to the person who made it (the maker is kept as its recorded owner for audit).
- **One allowance.** Every key of a team draws on one per-minute bucket (a whole address's worth by default, or the number an
  administrator sets with `POST /admin/teams/:id/limit`) and one daily cap of market analyses (twice a single key's).
- **Roles.** owner: everything, may delete the team. admin: invite and remove developers and viewers, change their roles,
  manage every key; cannot touch an owner or another admin. developer: create keys and manage the ones they made. viewer: see
  the team, its keys and their usage. A stranger and a team that does not exist look the same (404).
- **A team key never carries the Desk API** (it would act as whoever made it and hand their data to the whole team): only the
  Registry and Market APIs (`api_key_team_desk_api`).
- **When a person goes** (leaves or is deleted) the keys they made are handed to the best remaining member (an owner, else an
  admin, else the earliest joiner) and no key stops working; that member becomes an owner if none remains; a team with nobody
  left is deleted with its keys. The last owner cannot leave or be demoted (`team_last_owner`). Account deletion revokes only
  the person's personal keys.
- Limits: 5 teams created per person, 50 members and 25 keys per team.

## API (session-only, like the key routes)

`POST/GET /teams`, `GET/DELETE /teams/:id`, `POST /teams/:id/members`, `PATCH/DELETE /teams/:id/members/:membershipId`,
`GET /teams/invites`, `POST /teams/invites/:membershipId/accept`, `DELETE /teams/invites/:membershipId`; and `teamId` on
`POST /gateway/api-keys`, `?teamId=` on `GET /gateway/api-keys`.

## Invitation e-mails

The person invited is e-mailed (they see the invitation on the Teams page, or in `GET /teams/invites`). An address with no account is
kept in `team_email_invites` for 30 days and e-mailed a link to sign up; when that address is confirmed the invitation becomes a
pending membership. The answer to the inviter is the same either way, and the same pending invitation is not e-mailed twice in a day.

## Screens

The API Library site has a **Teams** tab (`/developer/teams`): create a team, accept or decline invitations, invite people, change
roles, remove people or leave, create and revoke team keys, delete the team. The page only shows buttons the person's role
allows (`library-ui/team-rules.js`, tested against the server's rules); the server still decides. The API is tested against a real
database in `src/__tests__/e2e/teams.e2e.test.ts`.
