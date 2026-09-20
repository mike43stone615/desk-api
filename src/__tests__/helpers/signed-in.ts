// A confirmed user with a live session, for route tests that only need "someone signed in".
import type { createFakeDb } from './fake-db';

export function seedSignedIn(db: ReturnType<typeof createFakeDb>, tag = 'signed-in'): Record<string, string> {
  const now = new Date().toISOString();
  const id = `user-${tag}`;
  db.users.set(id, {
    id, email: `${tag}@example.com`, password_hash: 'x', first_name: 'S', last_name: 'I',
    email_confirmed_at: now, created_at: now, updated_at: now,
  });
  const token = `token-${tag}`;
  db.seedSession(token, { id: `session-${tag}`, user_id: id, token, expires_at: new Date(Date.now() + 3_600_000).toISOString(), created_at: now });
  return { authorization: `Bearer ${token}` };
}
