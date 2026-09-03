// A tiny in-memory stand-in for `pool` (see src/db.ts) that understands just
// enough SQL — matched by prefix/substring against the exact query strings
// issued by src/infrastructure/database/pg/adapter.ts, src/routes/setup.ts,
// src/routes/admin.ts, and src/middleware/idempotency.ts — to exercise full
// signup -> confirm -> signin -> session -> draft -> complete -> admin flows
// end to end without a real Postgres connection. Modeled on
// market-validation-api's src/__tests__/helpers/fake-auth-db.ts.
import { vi } from 'vitest';

export interface FakeRow {
  [key: string]: unknown;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createFakeDb() {
  const users = new Map<string, FakeRow>(); // keyed by id
  const sessions = new Map<string, FakeRow>(); // keyed by token
  const passwordResetTokens = new Map<string, FakeRow>(); // keyed by token
  const emailConfirmationTokens = new Map<string, FakeRow>(); // keyed by token
  const drafts = new Map<string, FakeRow>(); // keyed by id
  const businesses = new Map<string, FakeRow>(); // keyed by id
  const memberships = new Map<string, FakeRow>(); // keyed by id
  const mutationAuditLog: FakeRow[] = [];
  const idempotencyKeys = new Map<string, FakeRow>(); // keyed by key

  function findUserByEmail(email: string): FakeRow | undefined {
    return [...users.values()].find((u) => u.email === email);
  }

  async function query(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: FakeRow[]; rowCount: number }> {
    const s = sql.replace(/\s+/g, ' ').trim();
    const p = params as string[];

    if (s.startsWith('SELECT 1')) return { rows: [{ '?column?': 1 }], rowCount: 1 };

    // ── users ──────────────────────────────────────────────────────────────
    if (s.includes('FROM users WHERE email = $1')) {
      const row = findUserByEmail(p[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (s.includes('FROM users WHERE id = $1') || s.includes('FROM "users" WHERE "id" = $1')) {
      const row = users.get(p[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (s.startsWith('SELECT COUNT') && s.includes('FROM "users"')) {
      return { rows: [{ count: String(users.size) }], rowCount: 1 };
    }
    if (s.startsWith('SELECT') && s.includes('FROM "users"')) {
      // Admin table browser — list/filter. Only unfiltered "list all" is
      // exercised by tests below; returns every user row.
      return { rows: [...users.values()], rowCount: users.size };
    }
    if (s.startsWith('INSERT INTO users')) {
      const [id, email, password_hash, first_name, last_name] = p;
      if (findUserByEmail(email)) {
        const err = new Error(
          'duplicate key value violates unique constraint "idx_users_email"',
        ) as Error & {
          code?: string;
        };
        err.code = '23505';
        throw err;
      }
      const row: FakeRow = {
        id,
        email,
        password_hash,
        first_name,
        last_name,
        email_confirmed_at: null,
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      users.set(id, row);
      return { rows: [row], rowCount: 1 };
    }
    if (s.startsWith('UPDATE users SET password_hash')) {
      const [password_hash, updated_at, id] = p;
      const row = users.get(id);
      if (row) {
        row.password_hash = password_hash;
        row.updated_at = updated_at;
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (s.startsWith('UPDATE users SET email_confirmed_at')) {
      const [confirmedAt, updatedAt, id] = p;
      const row = users.get(id);
      if (row) {
        row.email_confirmed_at = confirmedAt;
        row.updated_at = updatedAt;
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (s.startsWith('UPDATE "users" SET')) {
      // Admin table update — values already validated by caller. Parses
      // `"column" = $N` assignment pairs out of the SQL text so the fake
      // actually applies the edit (not just existence-checks), since
      // admin.test.ts's PATCH test reads the response body back.
      const id = p[p.length - 1];
      const row = users.get(id);
      if (row) {
        const assignments = [...s.matchAll(/"(\w+)" = \$(\d+)/g)];
        for (const [, column, index] of assignments) {
          row[column] = p[Number(index) - 1];
        }
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    // ── sessions ───────────────────────────────────────────────────────────
    if (s.startsWith('INSERT INTO sessions')) {
      const [id, user_id, token, expires_at] = p;
      const row: FakeRow = { id, user_id, token, expires_at, created_at: nowIso() };
      sessions.set(token, row);
      return { rows: [row], rowCount: 1 };
    }
    if (s.startsWith('DELETE FROM sessions WHERE token = $1')) {
      const existed = sessions.delete(p[0]);
      return { rows: [], rowCount: existed ? 1 : 0 };
    }
    if (s.includes('FROM sessions WHERE token = $1')) {
      const row = sessions.get(p[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (s.startsWith('DELETE FROM sessions WHERE expires_at')) {
      let count = 0;
      const cutoff = p[0];
      for (const [token, row] of sessions) {
        if ((row.expires_at as string) < cutoff) {
          sessions.delete(token);
          count++;
        }
      }
      return { rows: [], rowCount: count };
    }

    // ── password reset tokens ────────────────────────────────────────────
    if (s.startsWith('INSERT INTO password_reset_tokens')) {
      const [id, user_id, token, expires_at] = p;
      const row: FakeRow = { id, user_id, token, expires_at, used_at: null, created_at: nowIso() };
      passwordResetTokens.set(token, row);
      return { rows: [row], rowCount: 1 };
    }
    if (s.includes('FROM password_reset_tokens WHERE token = $1')) {
      const row = passwordResetTokens.get(p[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (s.includes('FROM password_reset_tokens WHERE user_id = $1')) {
      const matches = [...passwordResetTokens.values()]
        .filter((r) => r.user_id === p[0])
        .sort((a, b) => (b.created_at as string).localeCompare(a.created_at as string));
      return { rows: matches[0] ? [matches[0]] : [], rowCount: matches[0] ? 1 : 0 };
    }
    if (s.startsWith('UPDATE password_reset_tokens SET used_at = $2 WHERE user_id')) {
      const [userId, usedAt] = p;
      let count = 0;
      for (const row of passwordResetTokens.values()) {
        if (row.user_id === userId && !row.used_at) {
          row.used_at = usedAt;
          count++;
        }
      }
      return { rows: [], rowCount: count };
    }
    if (s.startsWith('UPDATE password_reset_tokens SET used_at')) {
      const [usedAt, token] = p;
      const row = passwordResetTokens.get(token);
      if (row) row.used_at = usedAt;
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    // ── email confirmation tokens ────────────────────────────────────────
    if (s.startsWith('DELETE FROM email_confirmation_tokens WHERE user_id')) {
      return { rows: [], rowCount: 0 };
    }
    if (s.startsWith('INSERT INTO email_confirmation_tokens')) {
      const [id, user_id, token, expires_at] = p;
      const row: FakeRow = { id, user_id, token, expires_at, used_at: null, created_at: nowIso() };
      emailConfirmationTokens.set(token, row);
      return { rows: [row], rowCount: 1 };
    }
    if (s.includes('FROM email_confirmation_tokens WHERE token = $1')) {
      const row = emailConfirmationTokens.get(p[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (s.includes('FROM email_confirmation_tokens WHERE user_id = $1')) {
      const matches = [...emailConfirmationTokens.values()]
        .filter((r) => r.user_id === p[0])
        .sort((a, b) => (b.created_at as string).localeCompare(a.created_at as string));
      return { rows: matches[0] ? [matches[0]] : [], rowCount: matches[0] ? 1 : 0 };
    }
    if (s.startsWith('UPDATE email_confirmation_tokens SET used_at')) {
      const [usedAt, token] = p;
      const row = emailConfirmationTokens.get(token);
      if (row) row.used_at = usedAt;
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    // ── business_setup_drafts ────────────────────────────────────────────
    if (s.startsWith('SELECT COUNT(*)::text AS count FROM business_setup_drafts')) {
      const count = [...drafts.values()].filter((d) => d.user_id === p[0]).length;
      return { rows: [{ count: String(count) }], rowCount: 1 };
    }
    if (
      s.startsWith(
        'SELECT id, draft_json, created_at, updated_at FROM business_setup_drafts WHERE user_id = $1',
      )
    ) {
      const rows = [...drafts.values()].filter((d) => d.user_id === p[0]);
      return { rows, rowCount: rows.length };
    }
    if (
      s.startsWith(
        'SELECT id, draft_json, created_at, updated_at FROM business_setup_drafts WHERE id = $1 AND user_id = $2',
      )
    ) {
      const row = drafts.get(p[0]);
      const match = row && row.user_id === p[1] ? row : undefined;
      return { rows: match ? [match] : [], rowCount: match ? 1 : 0 };
    }
    if (
      s.startsWith(
        'SELECT id, draft_json FROM business_setup_drafts WHERE id = $1 AND user_id = $2',
      )
    ) {
      const row = drafts.get(p[0]);
      const match = row && row.user_id === p[1] ? row : undefined;
      return { rows: match ? [match] : [], rowCount: match ? 1 : 0 };
    }
    if (s.startsWith('INSERT INTO business_setup_drafts')) {
      const [id, user_id, draft_json, created_at] = p;
      const row: FakeRow = { id, user_id, draft_json, created_at, updated_at: created_at };
      drafts.set(id, row);
      return { rows: [row], rowCount: 1 };
    }
    if (s.startsWith('UPDATE business_setup_drafts SET draft_json')) {
      const [draft_json, updated_at, id, user_id] = p;
      const row = drafts.get(id);
      if (row && row.user_id === user_id) {
        row.draft_json = draft_json;
        row.updated_at = updated_at;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (s.startsWith('DELETE FROM business_setup_drafts WHERE id = $1 AND user_id = $2')) {
      const row = drafts.get(p[0]);
      if (row && row.user_id === p[1]) {
        drafts.delete(p[0]);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (s.startsWith('DELETE FROM business_setup_drafts WHERE id = $1')) {
      const existed = drafts.delete(p[0]);
      return { rows: [], rowCount: existed ? 1 : 0 };
    }

    // ── businesses ────────────────────────────────────────────────────────
    if (s.startsWith('INSERT INTO businesses')) {
      const [id, user_id, name, industry, business_json, created_at] = p;
      businesses.set(id, {
        id,
        user_id,
        name,
        industry,
        business_json,
        created_at,
        updated_at: created_at,
      });
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('SELECT b.id, b.name, b.industry, bm.role')) {
      const userId = p[0];
      const rows = [...memberships.values()]
        .filter((m) => m.user_id === userId && m.accepted_at)
        .map((m) => {
          const b = businesses.get(m.business_id as string)!;
          return { id: b.id, name: b.name, industry: b.industry, role: m.role };
        });
      return { rows, rowCount: rows.length };
    }

    // ── business_memberships ─────────────────────────────────────────────
    if (s.startsWith('INSERT INTO business_memberships')) {
      if (s.includes('ON CONFLICT')) {
        const [id, business_id, user_id, role, invited_by_user_id, now] = p;
        const existing = [...memberships.values()].find(
          (m) => m.business_id === business_id && m.user_id === user_id,
        );
        if (existing) {
          if (existing.accepted_at) {
            // Mirrors the real WHERE guard: re-inviting an already-accepted
            // member is a no-op, not a silent reset back to pending.
            return { rows: [], rowCount: 0 };
          }
          existing.role = role;
          existing.invited_by_user_id = invited_by_user_id;
          existing.invited_at = now;
          existing.updated_at = now;
        } else {
          memberships.set(id, {
            id,
            business_id,
            user_id,
            role,
            invited_by_user_id,
            invited_at: now,
            accepted_at: null,
            created_at: now,
            updated_at: now,
          });
        }
      } else {
        const [id, business_id, user_id, accepted_at] = p;
        memberships.set(id, {
          id,
          business_id,
          user_id,
          role: 'owner',
          invited_by_user_id: null,
          invited_at: null,
          accepted_at,
          created_at: accepted_at,
          updated_at: accepted_at,
        });
      }
      return { rows: [], rowCount: 1 };
    }
    if (
      s.startsWith(
        'SELECT id, role FROM business_memberships WHERE business_id = $1 AND user_id = $2',
      )
    ) {
      const row = [...memberships.values()].find(
        (m) => m.business_id === p[0] && m.user_id === p[1] && m.accepted_at,
      );
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (s.includes('FROM business_memberships bm') && s.includes('INNER JOIN users u')) {
      const rows = [...memberships.values()]
        .filter((m) => m.business_id === p[0])
        .map((m) => ({ ...m, ...users.get(m.user_id as string) }));
      return { rows, rowCount: rows.length };
    }
    if (
      s.startsWith(
        'SELECT id, user_id, role FROM business_memberships WHERE id = $1 AND business_id = $2',
      )
    ) {
      const row = memberships.get(p[0]);
      const match = row && row.business_id === p[1] ? row : undefined;
      return { rows: match ? [match] : [], rowCount: match ? 1 : 0 };
    }
    if (
      s.startsWith(
        "SELECT COUNT(*)::text AS count FROM business_memberships WHERE business_id = $1 AND role = 'owner'",
      )
    ) {
      const count = [...memberships.values()].filter(
        (m) => m.business_id === p[0] && m.role === 'owner',
      ).length;
      return { rows: [{ count: String(count) }], rowCount: 1 };
    }
    if (s.startsWith('DELETE FROM business_memberships WHERE id = $1 AND business_id = $2')) {
      const existed = memberships.delete(p[0]);
      return { rows: [], rowCount: existed ? 1 : 0 };
    }
    if (s.startsWith('SELECT name FROM businesses WHERE id = $1')) {
      const b = businesses.get(p[0]);
      return { rows: b ? [{ name: b.name }] : [], rowCount: b ? 1 : 0 };
    }
    if (s.includes('FROM business_memberships bm') && s.includes('INNER JOIN businesses b')) {
      const rows = [...memberships.values()]
        .filter((m) => m.user_id === p[0] && !m.accepted_at)
        .map((m) => {
          const b = businesses.get(m.business_id as string);
          const inviter = m.invited_by_user_id ? users.get(m.invited_by_user_id as string) : undefined;
          return {
            id: m.id,
            business_id: m.business_id,
            business_name: b?.name ?? null,
            role: m.role,
            invited_at: m.invited_at,
            invited_by_email: inviter?.email ?? null,
            invited_by_first_name: inviter?.first_name ?? null,
            invited_by_last_name: inviter?.last_name ?? null,
          };
        });
      return { rows, rowCount: rows.length };
    }
    if (s.startsWith('UPDATE business_memberships SET accepted_at = $1, updated_at = $1')) {
      const [now, membershipId, userId] = p;
      const row = memberships.get(membershipId);
      if (!row || row.user_id !== userId || row.accepted_at) return { rows: [], rowCount: 0 };
      row.accepted_at = now;
      row.updated_at = now;
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('DELETE FROM business_memberships WHERE id = $1 AND user_id = $2 AND accepted_at IS NULL')) {
      const [membershipId, userId] = p;
      const row = memberships.get(membershipId);
      if (!row || row.user_id !== userId || row.accepted_at) return { rows: [], rowCount: 0 };
      memberships.delete(membershipId);
      return { rows: [], rowCount: 1 };
    }

    // ── mutation audit log ────────────────────────────────────────────────
    if (s.startsWith('INSERT INTO mutation_audit_log')) {
      const [
        id,
        user_id,
        user_email,
        action,
        entity_type,
        entity_id,
        before,
        after,
        ip_address,
        user_agent,
      ] = p;
      mutationAuditLog.push({
        id,
        user_id,
        user_email,
        action,
        entity_type,
        entity_id,
        before,
        after,
        ip_address,
        user_agent,
        created_at: nowIso(),
      });
      return { rows: [], rowCount: 1 };
    }

    // ── idempotency keys ─────────────────────────────────────────────────
    if (s.includes('FROM idempotency_keys WHERE key = $1')) {
      const row = idempotencyKeys.get(p[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (s.startsWith('INSERT INTO idempotency_keys')) {
      const [key, request_hash, response_status, response_body, expires_at] = p;
      idempotencyKeys.set(key, { key, request_hash, response_status, response_body, expires_at });
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('DELETE FROM idempotency_keys WHERE key = $1')) {
      idempotencyKeys.delete(p[0]);
      return { rows: [], rowCount: 1 };
    }

    // ── transaction control (setup.ts's completeDraftHandler) ─────────────
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [], rowCount: 0 };

    throw new Error(`fake-db: unhandled query: ${s}`);
  }

  const queryMock = vi.fn(query);

  const client = {
    query: queryMock,
    release: vi.fn(),
  };

  return {
    query: queryMock,
    connect: vi.fn(async () => client),
    end: vi.fn(),
    users,
    sessions,
    passwordResetTokens,
    emailConfirmationTokens,
    drafts,
    businesses,
    memberships,
    mutationAuditLog,
    idempotencyKeys,
  };
}
