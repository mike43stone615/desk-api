# API conventions (September 2026)

The rules the API follows, and the places where the older paths deliberately behave differently so existing apps keep working.
Everything here applies to the `/v1` paths; the unprefixed paths are the legacy spelling and keep their old answers.

## Names

| In the app and errors | In the API | Meaning |
| --- | --- | --- |
| registration, "business registration in progress" | **draft** (`/setup/drafts`) | A business setup that is not finished. |
| workspace, business | **business** (`/setup/businesses`) | A finished setup a person belongs to. |
| member, teammate | **member** (`/setup/businesses/:id/members`) | Someone with a role in a business. |
| API key | **key** (`/gateway/api-keys`) | A developer credential. Owned by one person. |

Collections are plural (`/setup/drafts`); a single thing that exists once per caller is singular (`/auth/session`).
Actions that are not a change to one resource are verbs under it (`/accept`, `/complete`, `/suspend`): they are the
exception, and each is listed in the API description.

## Methods and answers

- `GET` never changes anything the caller would notice. (A key's "last used" time is refreshed at most every 5 minutes.)
- A **create** answers `201 Created` with a `Location` header (drafts, businesses from a draft, invitations, keys) under `/v1`.
- A **delete** answers `204 No Content` under `/v1`; the legacy path answers `200 {"ok":true}`.
- `PUT` and `PATCH` on a draft do the same thing: replace the whole draft (with `If-Match` for safe concurrent saves).
- Errors are always `application/problem+json` with `type`, `title`, `status`, `detail`, `code`, and `errors[]` for field problems.

## Fields and formats

- Timestamps are ISO-8601 in UTC. Ids are opaque strings (the format differs by service and may change; never parse them).
- Names: JSON fields and query names are camelCase; ids are `id` (a thing's own) or `<thing>Id` (a reference to another:
  `userId`, `businessId`, `teamId`, `keyId`); times end in `At` (`createdAt`, `acceptedAt`, `invitedAt`); a person's own tag on
  a credential is `label`, the name of a business, team or registered entity is `name`. Roles in the newer APIs (teams) are the
  lower-case values `owner`, `admin`, `developer`, `viewer`; the business endpoints still return display text ("Owner", "Member")
  because the shipped apps read it, and that stays until `/v2`.
- A pending invitation looks the same for a business and for a team: `id`, the thing's id and name (`businessId` and
  `businessName`, `teamId` and `teamName`), `role`, `invitedAt`, `invitedByUserId`, `invitedBy`. A member looks the same too:
  `id`, the thing's id, `userId`, `role`, `invitedByUserId`, `invitedAt`, `acceptedAt`, `createdAt`, and the person under `user`.
- The same thing has the same name everywhere: a member's person is under `user` (`email`, `firstName`, `lastName`), and an
  invitation carries both `invitedBy` (the person) and `invitedByUserId` (their id).
- Text is stored in Unicode NFC form (an accented letter is one character however it was typed).
- States are two-letter codes (`FL`) or a full state name; anything else is a `400`.

## Rate-limit numbers

Two limits can apply to a call: this API's (per key) and, for proxied calls, the backend's (per backend key). A response
reports the one **closest to running out** in `X-RateLimit-Limit/Remaining/Reset`. A key can be given its own limit by an
administrator; the standard is half of what one address gets.

## What is not changed, and why

- **One response envelope for every endpoint** (`{ data: ... }`) would break the web and Flutter apps that read today's
  shapes (`{drafts}`, `{businesses}`, `{apiKey}`, ...). It is a `/v2` decision, not a `/v1` fix; the rules above are what
  `/v1` promises.
- **Paging** is offered where lists can grow (drafts, businesses, members); reference lists (business structures) accept
  `limit` and `cursor` but return everything when they are not given, so existing callers see no change.
- **Two paging styles, on purpose** (decided 21 September 2026): the small personal lists of the Desk API (drafts,
  businesses, members, teams, keys: tens of rows at most) use `limit` and `offset` ("skip this many"), because a person
  rarely sees more than one page and it is simple. Lists that can grow large use `limit` and `cursor` ("the next batch after
  this bookmark"), which does not skip or repeat rows when the list changes between pages: today that is the registry's
  reference lists, and it is the style every list will use in `/v2`. Which list uses which is in the API description.
  Small lists say `hasMore` so a client knows whether another page exists.

## Reserved names

The first path segments `auth`, `setup`, `gateway`, `admin`, `integrations`, `functions`, `health`, `metrics`, `docs`,
`errors`, `status`, `webhooks`, `v1`, `v2`, `api`, `.well-known`, `openapi.json`, `internal`, `oauth`, `graphql` belong to the
API. No web page or library file may use one; the server refuses to start if one does (`RESERVED_API_ROOTS`).

## Deleting things

| What | How it is removed | Why |
| --- | --- | --- |
| API keys | Soft: marked revoked, secrets wiped, row kept (usage history, audit trail) | Keeps the history a developer and an investigation need. |
| Sessions, e-mail tokens, drafts | Hard | Nothing to keep; keeping them only holds personal data longer. |
| Business members | Hard (the business survives; migration 0019 makes sure it always keeps an owner) | A removed person should not remain in the database. A restore is a new invitation. |
| Accounts | Hard, after keys are revoked; a business other people share is handed over | Right to erasure (see DATA-SUBJECT-REQUESTS.md). |
