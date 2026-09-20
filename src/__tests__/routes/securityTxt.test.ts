// /.well-known/security.txt: 404 until a contact is chosen, then a well-formed RFC 9116 file.
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { buildSecurityTxt, normalizeSecurityContact, registerSecurityTxt, SECURITY_TXT_PATH } from '../../routes/securityTxt';
import { validateProductionEnv } from '../../deploy/validate-env';

describe('security.txt', () => {
  it('turns an email into mailto:, keeps https and mailto, refuses anything else', () => {
    expect(normalizeSecurityContact('sec@example.com')).toBe('mailto:sec@example.com');
    expect(normalizeSecurityContact(' mailto:sec@example.com ')).toBe('mailto:sec@example.com');
    expect(normalizeSecurityContact('https://example.com/security')).toBe('https://example.com/security');
    for (const bad of ['', 'http://example.com', 'javascript:alert(1)', 'two words@example.com', 'sec@', 'x\nExpires: 2099']) {
      expect(normalizeSecurityContact(bad), bad).toBeNull();
    }
  });

  it('has the fields RFC 9116 requires, with Expires always in the future and no stray lines', () => {
    const now = new Date('2026-09-20T12:00:00Z');
    const txt = buildSecurityTxt('mailto:sec@example.com', 'https://api.example.com', now);
    expect(txt).toBe(['Contact: mailto:sec@example.com', 'Expires: 2027-03-19T12:00:00Z', 'Preferred-Languages: en', 'Canonical: https://api.example.com/.well-known/security.txt', ''].join('\n'));
  });

  it('is a 404 while no contact is chosen (or the choice is unusable)', async () => {
    for (const raw of [undefined, '', 'not a contact']) {
      const app = Fastify();
      registerSecurityTxt(app, raw);
      const res = await app.inject({ method: 'GET', url: SECURITY_TXT_PATH });
      expect(res.statusCode, String(raw)).toBe(404);
    }
  });

  it('is served as plain text once a contact is chosen', async () => {
    const app = Fastify();
    registerSecurityTxt(app, 'sec@example.com', 'https://api.example.com');
    const res = await app.inject({ method: 'GET', url: SECURITY_TXT_PATH });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.body).toContain('Contact: mailto:sec@example.com');
    expect(res.body).toMatch(/Expires: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ/);
  });

  it('a bad SECURITY_CONTACT stops a production deploy', () => {
    const problems = validateProductionEnv({ SECURITY_CONTACT: 'nonsense' });
    expect(problems.find((p) => p.name === 'SECURITY_CONTACT')).toBeTruthy();
    expect(validateProductionEnv({ SECURITY_CONTACT: 'sec@example.com' }).find((p) => p.name === 'SECURITY_CONTACT')).toBeUndefined();
  });
});
