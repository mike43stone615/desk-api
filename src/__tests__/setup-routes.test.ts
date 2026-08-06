import { describe, it, expect, beforeEach } from "vitest";
import { setupRouter } from "../api/routes/setup.js";
import { Hono } from "hono";
import { handleError } from "../api/middleware/errors.js";
import type { DeskAuthService } from "../infrastructure/auth/auth-service.js";
import type { User } from "../interfaces/database.js";

type DraftRecord = {
  id: string;
  user_id: string;
  draft_json: string;
  created_at: string;
  updated_at: string;
};

type BusinessRecord = {
  id: string;
  user_id: string;
  name: string;
  industry: string | null;
  business_json: string;
  created_at: string;
  updated_at: string;
};

type BusinessMembershipRecord = {
  id: string;
  business_id: string;
  user_id: string;
  role: "owner" | "admin" | "member" | "accountant";
  invited_by_user_id: string | null;
  invited_at: string | null;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
};

let nextId = 0;

/** Minimal D1-shaped test double covering only the query shapes setup.ts issues. */
class FakeD1 {
  drafts: DraftRecord[] = [];
  businesses: BusinessRecord[] = [];
  memberships: BusinessMembershipRecord[] = [];
  users: User[] = [makeUser()];

  prepare(sql: string) {
    return new FakeStatement(sql, this);
  }
}

class FakeStatement {
  private args: unknown[] = [];
  constructor(
    private sql: string,
    private db: FakeD1,
  ) {}

  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    const sql = this.sql;
    if (sql.includes("COUNT(*) AS count FROM business_setup_drafts")) {
      const userId = this.args[0] as string;
      return {
        count: this.db.drafts.filter((d) => d.user_id === userId).length,
      } as T;
    }
    if (
      sql.includes(
        "SELECT id, draft_json, created_at, updated_at FROM business_setup_drafts WHERE id",
      )
    ) {
      const [id, userId] = this.args as [string, string];
      const row = this.db.drafts.find(
        (d) => d.id === id && d.user_id === userId,
      );
      return (row as T) ?? null;
    }
    if (sql.includes("SELECT updated_at FROM business_setup_drafts WHERE id")) {
      const [id, userId] = this.args as [string, string];
      const row = this.db.drafts.find(
        (d) => d.id === id && d.user_id === userId,
      );
      return row ? ({ updated_at: row.updated_at } as T) : null;
    }
    if (
      sql.includes("SELECT id, draft_json FROM business_setup_drafts WHERE id")
    ) {
      const [id, userId] = this.args as [string, string];
      const row = this.db.drafts.find(
        (d) => d.id === id && d.user_id === userId,
      );
      return row ? ({ id: row.id, draft_json: row.draft_json } as T) : null;
    }
    if (sql.includes("SELECT id FROM users WHERE email = ?")) {
      const [email] = this.args as [string];
      const row = this.db.users.find((u) => u.email === email);
      return row ? ({ id: row.id } as T) : null;
    }
    if (
      sql.includes(
        "SELECT id, role FROM business_memberships WHERE business_id",
      )
    ) {
      const [businessId, userId] = this.args as [string, string];
      const row = this.db.memberships.find(
        (m) =>
          m.business_id === businessId &&
          m.user_id === userId &&
          m.accepted_at !== null,
      );
      return row ? ({ id: row.id, role: row.role } as T) : null;
    }
    if (sql.includes("SELECT id, user_id, role FROM business_memberships")) {
      const [membershipId, businessId] = this.args as [string, string];
      const row = this.db.memberships.find(
        (m) => m.id === membershipId && m.business_id === businessId,
      );
      return row
        ? ({ id: row.id, user_id: row.user_id, role: row.role } as T)
        : null;
    }
    if (sql.includes("COUNT(*) AS count FROM business_memberships")) {
      const [businessId] = this.args as [string];
      return {
        count: this.db.memberships.filter(
          (m) => m.business_id === businessId && m.role === "owner",
        ).length,
      } as T;
    }
    return null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    const sql = this.sql;
    if (sql.includes("FROM business_setup_drafts WHERE user_id")) {
      const userId = this.args[0] as string;
      const rows = this.db.drafts
        .filter((d) => d.user_id === userId)
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
      return { results: rows as T[] };
    }
    if (sql.includes("FROM businesses b")) {
      const userId = this.args[0] as string;
      const rows = this.db.memberships
        .filter((m) => m.user_id === userId && m.accepted_at !== null)
        .map((m) => {
          const business = this.db.businesses.find(
            (b) => b.id === m.business_id,
          );
          return business ? { ...business, role: m.role } : null;
        })
        .filter(
          (
            row,
          ): row is BusinessRecord & {
            role: BusinessMembershipRecord["role"];
          } => row !== null,
        )
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
      return { results: rows as T[] };
    }
    if (sql.includes("FROM business_memberships bm")) {
      const [businessId] = this.args as [string];
      const rows = this.db.memberships
        .filter((m) => m.business_id === businessId)
        .map((m) => {
          const user = this.db.users.find((u) => u.id === m.user_id);
          return {
            ...m,
            email: user?.email ?? "",
            first_name: user?.firstName ?? "",
            last_name: user?.lastName ?? "",
          };
        });
      return { results: rows as T[] };
    }
    return { results: [] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const sql = this.sql;
    const now = new Date().toISOString();
    if (sql.startsWith("INSERT INTO business_setup_drafts")) {
      const [id, userId, draftJson] = this.args as [string, string, string];
      this.db.drafts.push({
        id,
        user_id: userId,
        draft_json: draftJson,
        created_at: now,
        updated_at: now,
      });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("UPDATE business_setup_drafts")) {
      const [draftJson, id, userId] = this.args as [string, string, string];
      const row = this.db.drafts.find(
        (d) => d.id === id && d.user_id === userId,
      );
      if (!row) return { meta: { changes: 0 } };
      row.draft_json = draftJson;
      row.updated_at = new Date(Date.now() + ++nextId).toISOString();
      return { meta: { changes: 1 } };
    }
    if (
      sql.startsWith(
        "DELETE FROM business_setup_drafts WHERE id = ? AND user_id",
      )
    ) {
      const [id, userId] = this.args as [string, string];
      const before = this.db.drafts.length;
      this.db.drafts = this.db.drafts.filter(
        (d) => !(d.id === id && d.user_id === userId),
      );
      return { meta: { changes: before - this.db.drafts.length } };
    }
    if (sql.startsWith("DELETE FROM business_setup_drafts WHERE id = ?")) {
      const [id] = this.args as [string];
      const before = this.db.drafts.length;
      this.db.drafts = this.db.drafts.filter((d) => d.id !== id);
      return { meta: { changes: before - this.db.drafts.length } };
    }
    if (sql.startsWith("INSERT INTO businesses")) {
      const [id, userId, name, industry, businessJson] = this.args as [
        string,
        string,
        string,
        string | null,
        string,
      ];
      this.db.businesses.push({
        id,
        user_id: userId,
        name,
        industry,
        business_json: businessJson,
        created_at: now,
        updated_at: now,
      });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("INSERT INTO business_memberships")) {
      const [id, businessId, userId, role, invitedByUserId] = this.args as [
        string,
        string,
        string,
        BusinessMembershipRecord["role"] | undefined,
        string | undefined,
      ];
      const existing = this.db.memberships.find(
        (m) => m.business_id === businessId && m.user_id === userId,
      );
      if (existing) {
        existing.role = role ?? "owner";
        existing.invited_by_user_id = invitedByUserId ?? null;
        existing.invited_at = now;
        existing.accepted_at = now;
        existing.updated_at = now;
      } else {
        this.db.memberships.push({
          id,
          business_id: businessId,
          user_id: userId,
          role: role ?? "owner",
          invited_by_user_id: invitedByUserId ?? null,
          invited_at: invitedByUserId ? now : null,
          accepted_at: now,
          created_at: now,
          updated_at: now,
        });
      }
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith("DELETE FROM business_memberships")) {
      const [membershipId, businessId] = this.args as [string, string];
      const before = this.db.memberships.length;
      this.db.memberships = this.db.memberships.filter(
        (m) => !(m.id === membershipId && m.business_id === businessId),
      );
      return { meta: { changes: before - this.db.memberships.length } };
    }
    return { meta: { changes: 0 } };
  }
}

function makeApp(user: User) {
  const app = new Hono<{
    Bindings: { DB: FakeD1 };
    Variables: { authService: DeskAuthService; currentUser: User };
  }>();
  app.use("*", async (c, next) => {
    c.set("authService", {
      verifySession: async () => user,
    } as unknown as DeskAuthService);
    await next();
  });
  app.route("/setup", setupRouter);
  app.onError((err, c) => handleError(err, c));
  return app;
}

function makeUser(): User {
  return {
    id: "user-1",
    email: "owner@example.com",
    passwordHash: "",
    firstName: "Owner",
    lastName: "User",
    emailConfirmedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const authHeaders = {
  authorization: "Bearer test-token",
  "content-type": "application/json",
};

describe("setup drafts routes", () => {
  let db: FakeD1;
  let app: ReturnType<typeof makeApp>;
  const user = makeUser();

  beforeEach(() => {
    db = new FakeD1();
    app = makeApp(user);
  });

  it("creates a new empty draft", async () => {
    const res = await app.request(
      "/setup/drafts",
      {
        method: "POST",
        headers: authHeaders,
      },
      { DB: db },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.id).toBeTruthy();
    expect(db.drafts).toHaveLength(1);
    expect(db.drafts[0].user_id).toBe("user-1");
  });

  it("rejects creating a 6th draft with 409", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await app.request(
        "/setup/drafts",
        { method: "POST", headers: authHeaders },
        { DB: db },
      );
      expect(res.status).toBe(200);
    }
    const res = await app.request(
      "/setup/drafts",
      { method: "POST", headers: authHeaders },
      { DB: db },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error).toMatch(/too many incomplete/i);
  });

  it("lists drafts newest first with a businessName summary", async () => {
    db.drafts.push(
      {
        id: "d1",
        user_id: "user-1",
        draft_json: JSON.stringify({
          businessName: "Acme Bakery",
          currentStep: 2,
        }),
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      {
        id: "d2",
        user_id: "user-1",
        draft_json: JSON.stringify({ currentStep: 0 }),
        created_at: "2026-01-02T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
      },
    );
    const res = await app.request(
      "/setup/drafts",
      { headers: authHeaders },
      { DB: db },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.drafts).toHaveLength(2);
    expect(body.drafts[0].id).toBe("d2");
    expect(body.drafts[0].businessName).toBeNull();
    expect(body.drafts[1].businessName).toBe("Acme Bakery");
  });

  it("does not return another user's draft", async () => {
    db.drafts.push({
      id: "other-draft",
      user_id: "someone-else",
      draft_json: "{}",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });
    const res = await app.request(
      "/setup/drafts/other-draft",
      { headers: authHeaders },
      { DB: db },
    );
    expect(res.status).toBe(404);
  });

  it("saves a draft via PATCH and rejects an oversized payload", async () => {
    db.drafts.push({
      id: "d1",
      user_id: "user-1",
      draft_json: "{}",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });
    const ok = await app.request(
      "/setup/drafts/d1",
      {
        method: "PATCH",
        headers: authHeaders,
        body: JSON.stringify({ draft: { businessName: "New Name" } }),
      },
      { DB: db },
    );
    expect(ok.status).toBe(200);
    expect(db.drafts[0].draft_json).toContain("New Name");

    const tooBig = await app.request(
      "/setup/drafts/d1",
      {
        method: "PATCH",
        headers: authHeaders,
        body: JSON.stringify({ draft: { blob: "x".repeat(300_000) } }),
      },
      { DB: db },
    );
    expect(tooBig.status).toBe(413);
  });

  it("deletes a draft", async () => {
    db.drafts.push({
      id: "d1",
      user_id: "user-1",
      draft_json: "{}",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });
    const res = await app.request(
      "/setup/drafts/d1",
      { method: "DELETE", headers: authHeaders },
      { DB: db },
    );
    expect(res.status).toBe(200);
    expect(db.drafts).toHaveLength(0);
  });

  it("requires a business name before completing a draft", async () => {
    db.drafts.push({
      id: "d1",
      user_id: "user-1",
      draft_json: JSON.stringify({ businessName: "  " }),
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });
    const res = await app.request(
      "/setup/drafts/d1/complete",
      { method: "POST", headers: authHeaders },
      { DB: db },
    );
    expect(res.status).toBe(400);
  });

  it("completes a draft into a business and removes the draft", async () => {
    db.drafts.push({
      id: "d1",
      user_id: "user-1",
      draft_json: JSON.stringify({
        businessName: "Acme Bakery",
        industry: "Bakery",
      }),
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });
    const res = await app.request(
      "/setup/drafts/d1/complete",
      { method: "POST", headers: authHeaders },
      { DB: db },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.business.name).toBe("Acme Bakery");
    expect(body.business.isSetupComplete).toBe(true);
    expect(db.drafts).toHaveLength(0);
    expect(db.businesses).toHaveLength(1);
    expect(db.memberships).toHaveLength(1);
    expect(db.memberships[0]).toMatchObject({
      business_id: db.businesses[0].id,
      user_id: "user-1",
      role: "owner",
    });
  });

  it("lists completed businesses", async () => {
    db.businesses.push({
      id: "b1",
      user_id: "user-1",
      name: "Acme Bakery",
      industry: "Bakery",
      business_json: "{}",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });
    db.memberships.push({
      id: "bm1",
      business_id: "b1",
      user_id: "user-1",
      role: "owner",
      invited_by_user_id: null,
      invited_at: null,
      accepted_at: "2026-01-01T00:00:00Z",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });
    const res = await app.request(
      "/setup/businesses",
      { headers: authHeaders },
      { DB: db },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.businesses).toEqual([
      {
        id: "b1",
        name: "Acme Bakery",
        industry: "Bakery",
        role: "Owner",
        isSetupComplete: true,
      },
    ]);
  });

  it("lists businesses shared through memberships", async () => {
    db.businesses.push({
      id: "b1",
      user_id: "user-1",
      name: "Shared Bakery",
      industry: "Bakery",
      business_json: "{}",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });
    db.memberships.push({
      id: "bm1",
      business_id: "b1",
      user_id: "user-2",
      role: "admin",
      invited_by_user_id: "user-1",
      invited_at: "2026-01-01T00:00:00Z",
      accepted_at: "2026-01-01T00:00:00Z",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });
    app = makeApp({
      ...user,
      id: "user-2",
      email: "admin@example.com",
    });

    const res = await app.request(
      "/setup/businesses",
      { headers: authHeaders },
      { DB: db },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.businesses).toEqual([
      {
        id: "b1",
        name: "Shared Bakery",
        industry: "Bakery",
        role: "Admin",
        isSetupComplete: true,
      },
    ]);
  });

  it("lets an owner add another existing user to a business", async () => {
    db.users.push({
      ...user,
      id: "user-2",
      email: "partner@example.com",
      firstName: "Partner",
    });
    db.businesses.push({
      id: "b1",
      user_id: "user-1",
      name: "Acme Bakery",
      industry: "Bakery",
      business_json: "{}",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });
    db.memberships.push({
      id: "bm1",
      business_id: "b1",
      user_id: "user-1",
      role: "owner",
      invited_by_user_id: null,
      invited_at: null,
      accepted_at: "2026-01-01T00:00:00Z",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });

    const res = await app.request(
      "/setup/businesses/b1/members",
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ email: "partner@example.com", role: "admin" }),
      },
      { DB: db },
    );

    expect(res.status).toBe(200);
    expect(db.memberships).toHaveLength(2);
    expect(db.memberships[1]).toMatchObject({
      business_id: "b1",
      user_id: "user-2",
      role: "admin",
      invited_by_user_id: "user-1",
    });
  });
});
