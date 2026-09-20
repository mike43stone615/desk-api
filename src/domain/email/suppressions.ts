// Addresses we have stopped emailing (permanent bounce or spam complaint), see migration 0018.
import { pool } from '../../db';

export async function isSuppressed(email: string): Promise<boolean> {
  try {
    const { rows } = await pool.query(`SELECT 1 FROM email_suppressions WHERE email = $1`, [email.trim().toLowerCase()]);
    return rows.length > 0;
  } catch {
    return false; // never block sending because the list could not be read
  }
}
