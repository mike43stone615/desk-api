# Future Self-Hosted Migration Guide

When you are ready to move off Cloudflare and onto your own Linux server, this
guide describes the target architecture and the exact steps required.

## Target architecture

```
Internet
   |
   v
Caddy or Nginx (TLS termination + reverse proxy)
   |
   +--> desk-api container (Node.js / Fastify or Hono + @hono/node-server)
   |       |
   |       +--> PostgreSQL container
   |       +--> MinIO container (S3-compatible storage)
   |
   +--> desk-frontend container (nginx serving Flutter web build)
   |
   +--> compliance-os container (existing — no changes needed)
   |       |
   |       +--> PostgreSQL (shared or separate)
   |       +--> Redis
   |
   +--> registry-api container (existing — no changes needed)
           |
           +--> PostgreSQL (shared or separate)
           +--> Redis
```

---

## Step 1 — Add a Node.js server entry point to desk-api

Hono supports Node.js via `@hono/node-server`. Add this file:

```typescript
// src/server.ts
import { serve } from '@hono/node-server';
import app from './index.js';

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8787) }, (info) => {
  console.log(`desk-api listening on http://localhost:${info.port}`);
});
```

No changes to the application logic or routes.

---

## Step 2 — Replace the D1 adapter with a PostgreSQL adapter

Create `src/infrastructure/database/postgres/adapter.ts` implementing `DatabaseRepository`
using `pg` (node-postgres) or `postgres.js`. Every method signature is identical to
the D1 adapter — only the SQL dialect and query execution change.

Key differences:
- Replace `strftime('%Y-%m-%dT%H:%M:%SZ', 'now')` → `NOW()::text`
- Replace D1's `.prepare().bind().first<T>()` → parameterized `pool.query<T>(...)`
- UUID generation: use `uuid` package or `gen_random_uuid()`

See `docs/POSTGRES-ADAPTER-PLAN.md` for the full plan.

---

## Step 3 — Replace the R2 adapter with a MinIO adapter

Create `src/infrastructure/storage/minio/adapter.ts` implementing `ObjectStorage`
using the AWS SDK v3 S3 client (MinIO is S3-compatible).

```typescript
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export class MinioStorageAdapter implements ObjectStorage {
  private readonly s3: S3Client;
  constructor(private readonly bucket: string, endpoint: string, accessKey: string, secretKey: string) {
    this.s3 = new S3Client({ endpoint, region: 'us-east-1', credentials: { accessKeyId: accessKey, secretAccessKey: secretKey }, forcePathStyle: true });
  }
  // ... implement put, get, delete, head, createSignedUrl
}
```

---

## Step 4 — Change configuration

New environment variables for self-hosted:

```env
DATABASE_PROVIDER=postgres
DATABASE_URL=postgresql://user:pass@localhost:5432/desk
OBJECT_STORAGE_PROVIDER=minio
OBJECT_STORAGE_ENDPOINT=http://minio:9000
OBJECT_STORAGE_BUCKET=desk-storage
OBJECT_STORAGE_ACCESS_KEY=minioadmin
OBJECT_STORAGE_SECRET_KEY=minioadmin
```

The composition root in `src/index.ts` (or `src/server.ts`) selects the adapter
based on `DATABASE_PROVIDER` and `OBJECT_STORAGE_PROVIDER`.

---

## Step 5 — Migrate data from D1 to PostgreSQL

1. Export all D1 tables via `wrangler d1 export desk-api-db --output dump.sql`
2. Convert SQLite syntax to PostgreSQL (timestamps, booleans)
3. Apply PostgreSQL schema: `psql $DATABASE_URL -f migrations/001_postgres.sql`
4. Import data: `psql $DATABASE_URL -f dump-converted.sql`
5. Verify row counts and referential integrity

---

## Step 6 — Migrate files from R2 to MinIO

```bash
# Use rclone to sync R2 → MinIO
rclone sync r2:desk-api-storage minio:desk-storage
```

---

## Docker Compose (future)

```yaml
# compose.yaml
services:
  desk-api:
    build: ./desk-api
    environment:
      DATABASE_PROVIDER: postgres
      DATABASE_URL: postgresql://desk:desk@postgres:5432/desk
      OBJECT_STORAGE_PROVIDER: minio
      # ...
    depends_on: [postgres, minio]

  postgres:
    image: postgres:17
    volumes: [postgres-data:/var/lib/postgresql/data]

  minio:
    image: minio/minio
    command: server /data
    volumes: [minio-data:/data]

  desk-frontend:
    image: nginx:alpine
    volumes: [./desk_business/build/web:/usr/share/nginx/html:ro]

volumes:
  postgres-data:
  minio-data:
```

---

## What will NOT need to change

- All Flutter client code (`desk_business`)
- All API route handlers and business logic
- All compliance-os code
- All registry-api code
- API contracts and response shapes
- Authentication logic (password hashing algorithm is portable)
- Session token format

---

## What WILL need to change

- `src/infrastructure/database/d1/adapter.ts` → add PostgreSQL adapter
- `src/infrastructure/storage/r2/adapter.ts` → add MinIO adapter
- `src/index.ts` → select adapter from config
- `wrangler.toml` → replace with environment variables + Docker
- DNS → point to new server
- TLS → use Caddy (automatic) or certbot
