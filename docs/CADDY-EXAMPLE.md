# Caddy Reverse Proxy Configuration (Self-Hosted)

This is the recommended reverse proxy configuration for the self-hosted stack
described in `compose.yaml`. Caddy handles TLS automatically via Let's Encrypt.

---

## Caddyfile

```caddyfile
# /etc/caddy/Caddyfile

deskbusiness.co, www.deskbusiness.co {
    # Redirect www → apex
    @www host www.deskbusiness.co
    redir @www https://deskbusiness.co{uri} permanent

    # API routes → desk-api Node.js container
    handle /auth/* {
        reverse_proxy desk-api:8787
    }
    handle /functions/v1/* {
        reverse_proxy desk-api:8787
    }
    handle /integrations/* {
        reverse_proxy desk-api:8787
    }
    handle /health {
        reverse_proxy desk-api:8787
    }
    handle /readiness {
        reverse_proxy desk-api:8787
    }

    # Everything else → Flutter SPA (nginx container)
    handle {
        reverse_proxy desk-frontend:80
    }
}

app.deskbusiness.co {
    # Same routing as apex for app subdomain
    handle /auth/* {
        reverse_proxy desk-api:8787
    }
    handle /functions/v1/* {
        reverse_proxy desk-api:8787
    }
    handle /integrations/* {
        reverse_proxy desk-api:8787
    }
    handle /health {
        reverse_proxy desk-api:8787
    }
    handle {
        reverse_proxy desk-frontend:80
    }
}
```

---

## TLS and DNS migration from Cloudflare

When moving from Cloudflare to self-hosted:

1. **Provision the server** — ensure desk-api, Postgres, MinIO, and Caddy are running
   and healthy on the new server before changing DNS.

2. **Test on the new server directly** — before DNS cutover, test by adding a
   temporary `/etc/hosts` entry pointing `deskbusiness.co` to the new server IP.

3. **Export data** — follow `docs/BACKUP-RESTORE.md` "Pre-migration export" steps
   to move D1 → PostgreSQL and R2 → MinIO before the cutover.

4. **Lower TTL** — 24 hours before cutover, lower the DNS A record TTL to 60 seconds
   in the Cloudflare dashboard so propagation is fast after the change.

5. **DNS cutover** — update the A records in Cloudflare (or move DNS entirely):
   ```
   A  deskbusiness.co      → <new-server-ip>
   A  www.deskbusiness.co  → <new-server-ip>
   A  app.deskbusiness.co  → <new-server-ip>
   ```

6. **Verify TLS** — Caddy will obtain Let's Encrypt certificates automatically on
   first request. Confirm with:
   ```bash
   curl -I https://deskbusiness.co/health
   ```

7. **Remove Cloudflare proxying** — once stable, you can disable the Cloudflare
   orange-cloud (proxy) on those records or transfer the domain out entirely.
   Keep Cloudflare DNS-only mode (`grey cloud`) initially as a safe fallback.

8. **Restore TTL** — after confirming the new server is stable, restore TTL to 3600.

---

## Nginx alternative

If you prefer Nginx over Caddy, the equivalent `nginx.conf` snippet:

```nginx
upstream desk_api {
    server desk-api:8787;
}

upstream desk_frontend {
    server desk-frontend:80;
}

server {
    listen 443 ssl;
    server_name deskbusiness.co app.deskbusiness.co;

    # TLS — use certbot or copy certs from Caddy's storage
    ssl_certificate /etc/letsencrypt/live/deskbusiness.co/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/deskbusiness.co/privkey.pem;

    location ~ ^/(auth|functions/v1|integrations|health|readiness)(/|$) {
        proxy_pass http://desk_api;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        proxy_pass http://desk_frontend;
        proxy_set_header Host $host;
    }
}
```
