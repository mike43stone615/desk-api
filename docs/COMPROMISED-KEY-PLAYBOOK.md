# A key (or an account) may be compromised: what to do

Speed first, understanding second. Every step below can be undone except revoking.

## If you are the key's owner
1. **Switch it off now**: `POST /v1/gateway/api-keys/{id}/suspend` (or Suspend on the API Library page when that button
   exists). The key is refused immediately (`403 api_key_suspended`); nothing is deleted.
2. **Look at what it did**: `GET /v1/gateway/api-keys/{id}/usage` shows calls and errors per day, and
   `GET /v1/auth/activity` shows account events. A sudden jump in calls is the sign.
3. **Replace it**: make a new key, update your servers, then **revoke** the old one (`DELETE /v1/gateway/api-keys/{id}`).
   Revoking is permanent and also revokes its backend keys.
4. If your **password** may be known as well: change it (`POST /auth/password`, needs the current one) which ends every
   other session, and check `GET /auth/sessions` for devices you do not recognise.

## If you are the operator
1. **Find it**: `GET /admin/gateway-keys` (owner, services, last use, suspended?). To find the calls, search the logs for
   the key id: `node scripts/search-logs.mjs <keyId>` (every line of a keyed request carries `keyId`, never the key).
   The request id is forwarded to the Registry and Market services, so their logs join on it.
2. **Contain it**: `POST /admin/gateway-keys/{id}/suspend` for one key, or `POST /admin/users/{id}/suspend` for the whole
   account (its sessions end at once, sign-in and all its keys are refused). Both are recorded in the admin history.
3. **Check the backends agree**: `POST /admin/gateway-keys/reconcile` compares our keys with the backends' and reports
   (and revokes) any backend key we do not know about.
4. **Notify**: tell the owner (their address is in the admin list). They already get an email when a key is created and
   when their password changes or resets.
5. **Close it**: once the owner has a new key, revoke the old one, or unsuspend the account. Note what happened.

## If the *static admin key* leaked
Rotate it (docs/SECRET-ROTATION.md): change `ADMIN_API_KEY` in desk-api's settings and deploy. Every use of the old one is
in the admin history (`admin_api_key_used`, with the address) and in the logs (`admin_api_key_used`). Set
`ADMIN_API_KEY_ALLOWED_IPS` so the key only works from your own address in future.
