// Session, password-reset and email-confirmation tokens are random 256-bit values, so a fast unsalted hash is enough
// to store them safely: the database holds only "sha256:<hex>", never a token that could be used as-is, so a leaked
// or copied database does not hand out working sessions or reset links. The plain token exists only in the cookie,
// the bearer header, or the email link.
import { createHash } from 'crypto';

export const TOKEN_HASH_PREFIX = 'sha256:';

export function hashToken(token: string): string {
  return TOKEN_HASH_PREFIX + createHash('sha256').update(token, 'utf8').digest('hex');
}
