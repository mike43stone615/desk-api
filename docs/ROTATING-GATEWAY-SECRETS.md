# Rotating the API Library's secrets

The API Library holds three kinds of secret. Each rotates differently.

| Secret | Where it lives | What it protects |
| --- | --- | --- |
| `GATEWAY_KEY_ENCRYPTION_SECRET` | `DOTENV_CONTENT` (GitHub secret) → the service's `.env` | The real registry/market keys stored (encrypted) for each developer's grants |
| `REGISTRY_API_ADMIN_KEY`, `MARKET_API_ADMIN_KEY` | same | desk-api's power to mint/revoke backend keys |
| Developers' `deskgw_…` keys | Only a SHA-256 hash is stored | Nothing to rotate here; a developer revokes and creates a new one |

Production config is the `DOTENV_CONTENT` GitHub secret, written to the service's `.env` on every deploy. The deployed
file is `C:\actions-runners\desk-api\_work\live\.env`. **Never paste a secret into a chat, a ticket or a
commit.** Every command below prints counts only.

## 1. `GATEWAY_KEY_ENCRYPTION_SECRET` (rotate without breaking anyone)

Each stored value records a short fingerprint of the key it was encrypted with, so old and new can coexist while the
values are re-encrypted. Nothing is signed out and no developer has to do anything.

1. Make a new secret: `openssl rand -hex 32`.
2. Edit `DOTENV_CONTENT`:
   - `GATEWAY_KEY_ENCRYPTION_SECRET` = the **new** secret
   - `GATEWAY_KEY_ENCRYPTION_SECRET_PREVIOUS` = the **old** secret (comma-separate more than one if you have skipped a rotation)
3. Deploy (Actions → Deploy → Run workflow). From now on new keys use the new secret and old keys still work.
4. Check what will change (from the repo folder, using the deployed settings):
   ```bash
   npx tsx --env-file="C:/actions-runners/desk-api/_work/live/.env" scripts/rotate-gateway-secret.ts --dry-run
   ```
   It prints `{"total":…,"alreadyUnderCurrentKey":…,"wouldRotate":…,"unreadable":0,…}`. `unreadable` must be `0`; if not,
   a previous secret is missing from step 2.
5. Re-encrypt everything under the new secret (safe to re-run, safe while the service is live):
   ```bash
   npx tsx --env-file="C:/actions-runners/desk-api/_work/live/.env" scripts/rotate-gateway-secret.ts
   ```
6. Run the dry run again: `wouldRotate` must be `0` and `alreadyUnderCurrentKey` must equal `total`.
7. Remove `GATEWAY_KEY_ENCRYPTION_SECRET_PREVIOUS` from `DOTENV_CONTENT` and deploy again. The old secret can now be
   destroyed.

**If you skip steps 2–6** and simply swap the secret, every brokered key stops working (the service answers 503 for
registry/market calls; Desk-API-only keys are unaffected). Undo by putting the old secret back.

**If the old secret is lost** before step 5, those grants cannot be read again. The affected developers must create a new
key. Their old backend keys are then removed by the hourly reconcile job (orphans are revoked automatically).

## 2. The backend admin keys

`REGISTRY_API_ADMIN_KEY` and `MARKET_API_ADMIN_KEY` are the `ADMIN_API_KEY` of registry-api and market-validation-api.
Rotating one means changing it in **both** places, so do it in this order to avoid a gap:

1. Change the backend's `ADMIN_API_KEY` in its own `DOTENV_CONTENT` and redeploy it. Until step 2 finishes, desk-api
   cannot mint or revoke keys on that backend (developers' existing keys keep working).
2. Change the matching `…_ADMIN_KEY` in desk-api's `DOTENV_CONTENT` and redeploy desk-api.
3. Within the hour the reconcile job runs. Any revocation that failed in between is retried by the sweeper every five
   minutes, so nothing is lost.

If the two get out of step, `GET /metrics` shows `desk_backend_key_sweep_total{outcome="failed"}` rising and the
service logs `backend key sweep failed`.
