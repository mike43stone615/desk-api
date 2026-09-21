# Running in more than one region

**Status: designed and prepared in the code; no second region exists.** Everything runs on one machine behind one Cloudflare
Tunnel. A second region needs somewhere else to run (another machine, or a cloud server) and a copy of the database that follows
the first; neither has been bought or set up. What the code already does is listed first, then what remains.

## What the code supports today

- **`REGION`** names the copy (`primary` by default). Every answer carries `x-region`, and `/health` says `region` and `readOnly`.
- **`READ_ONLY=true`** makes a copy a **read-only standby**: it answers reads (and GraphQL, which only reads), refuses every change
  with `503 region_read_only` and `Retry-After: 30`, and starts none of the background jobs (clean-up, mail and webhook delivery,
  invoices), which the writing copy runs. A read-only copy can therefore sit on a database replica safely.
- The services are stateless apart from the database and Redis, migrations are applied by hand and idempotent, background jobs take a
  Redis lock so two copies never do the same job twice, and the backups are encrypted and restorable (proved by the restore drill).

## The plan (active / standby)

1. **Database:** Postgres streaming replication from the primary to a replica in the second place (a managed Postgres in the
   cloud, or a second machine). The replica is read-only by nature.
2. **Standby copy:** run desk-api, registry-api and market-validation-api there with `READ_ONLY=true`, `REGION=<name>`, pointing at
   the replica, plus its own Redis and its own Cloudflare Tunnel connector for the same hostnames.
3. **Traffic:** add the standby's tunnel as a second connector of the same tunnel (Cloudflare then spreads or fails over traffic);
   or, to keep writes in one place, point the hostnames at the standby only during a failover.
4. **Failover** (the primary is gone): promote the replica (`pg_ctl promote`, or the cloud button), set `READ_ONLY=false` on the
   standby copies and restart them, then check `/health` (`readOnly:false`) and the uptime watch. Rebuild the old primary as the new
   replica when it returns. The cold-standby recipe (COLD-STANDBY.md) is the same steps for a copy that is not running yet.
5. **Rehearse it** once with the restore drill's throwaway server before relying on it.

## What it costs and what it does not fix

- A small always-on server or managed database, roughly the price of one small cloud instance a month per service group.
- Cloudflare is still one provider, and the domain registrar and DNS are still single points; those are outside this.
- Writes still happen in one region at a time (active/standby). True multi-writer would need a different database design.
