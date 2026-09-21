// Dedicated, low-limit throttle for POST /auth/signup, on top of the general per-IP rate limiter in api-protection.ts
// (which is generous, meant for normal API traffic, and does not meaningfully slow down mass fake-account creation).
//   - per address: 5 sign-ups an hour;
//   - per e-mail domain: a brake on one domain being used to make many accounts (10 an hour for an ordinary domain; the
//     big public mail providers get a much higher ceiling, since thousands of real people share them).
// Both counters go through the shared per-route counter (route-limits.ts), so every copy of the service agrees when
// Redis is configured, instead of each process keeping its own count.
import { hit, type Limit } from './route-limits';

const HOUR = 60 * 60 * 1000;
const PER_ADDRESS: Limit = { name: 'signup-ip', max: 5, windowMs: HOUR, what: 'sign-up attempts' };
const PER_DOMAIN: Limit = { name: 'signup-domain', max: 10, windowMs: HOUR, what: 'sign-ups from this e-mail domain' };
const PER_PUBLIC_DOMAIN: Limit = { name: 'signup-public-domain', max: 300, windowMs: HOUR, what: 'sign-ups from this e-mail domain' };

/** Mail providers used by very many unrelated people. */
const PUBLIC_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com', 'icloud.com', 'me.com',
  'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com', 'zoho.com', 'fastmail.com', 'comcast.net', 'att.net', 'verizon.net',
]);

// Test suites sign up far more than 5 times per run against a shared fake IP: keep them hermetic.
const off = () => process.env.NODE_ENV === 'test';

export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  return at > 0 && at < email.length - 1 ? email.slice(at + 1).trim().toLowerCase() : null;
}

/** Counts one sign-up attempt from this address. False means "too many". */
export async function checkSignupRateLimit(ip: string): Promise<boolean> {
  if (off()) return true;
  return (await hit(PER_ADDRESS, ip)) === 0;
}

/** Counts one sign-up with this e-mail address against its domain. False means "too many". */
export async function checkSignupDomainLimit(email: string): Promise<boolean> {
  if (off()) return true;
  const domain = emailDomain(email);
  if (!domain) return true;
  return (await hit(PUBLIC_MAIL_DOMAINS.has(domain) ? PER_PUBLIC_DOMAIN : PER_DOMAIN, domain)) === 0;
}
