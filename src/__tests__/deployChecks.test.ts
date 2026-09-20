// The checks a deploy makes before swapping versions, and that machine-level files kept in git carry no secrets.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REQUIRED_IN_PRODUCTION, validateProductionEnv } from '../deploy/validate-env';

const GOOD: Record<string, string> = {
  DATABASE_URL: 'postgresql://desk_api_app:pw@localhost:5432/desk_api',
  GATEWAY_KEY_ENCRYPTION_SECRET: 'ab'.repeat(32),
  REGISTRY_API_URL: 'http://localhost:3456',
  REGISTRY_API_ADMIN_KEY: 'r',
  MARKET_API_URL: 'http://localhost:3457',
  MARKET_API_ADMIN_KEY: 'm',
  RESEND_API_KEY: 're_x',
  ADMIN_EMAILS: 'a@example.com',
  METRICS_DOCS_API_KEY: 'k',
  APP_BASE_URL: 'https://app.deskbusiness.co',
};
const names = (env: Record<string, string | undefined>) => validateProductionEnv(env).map((p) => p.name);

describe('validateProductionEnv', () => {
  it('accepts a complete production configuration', () => {
    expect(validateProductionEnv(GOOD)).toEqual([]);
  });

  it('names every required setting that is missing or blank, and only those', () => {
    for (const key of REQUIRED_IN_PRODUCTION) {
      expect(names({ ...GOOD, [key]: undefined }), key).toContain(key);
      expect(names({ ...GOOD, [key]: '   ' }), key).toContain(key);
    }
    expect(names({})).toEqual(expect.arrayContaining([...REQUIRED_IN_PRODUCTION]));
  });

  it('refuses a development or test database', () => {
    const problems = validateProductionEnv({ ...GOOD, DATABASE_URL: 'postgresql://u:p@127.0.0.1:5433/desk_api_dev' });
    expect(problems).toEqual([{ name: 'DATABASE_URL', problem: expect.stringContaining('development/test database') }]);
    expect(names({ ...GOOD, DATABASE_URL: 'postgresql://u:p@h/desk_api_test' })).toContain('DATABASE_URL');
  });

  it('refuses malformed values the service itself would reject at boot', () => {
    expect(names({ ...GOOD, GATEWAY_KEY_ENCRYPTION_SECRET: 'not-hex' })).toContain('GATEWAY_KEY_ENCRYPTION_SECRET');
    expect(names({ ...GOOD, PORT: 'abc' })).toContain('PORT');
    expect(names({ ...GOOD, REGISTRY_API_URL: 'localhost:3456' })).toContain('REGISTRY_API_URL');
    expect(names({ ...GOOD, APP_BASE_URL: 'http://app.example.com' })).toContain('APP_BASE_URL');
    expect(names({ ...GOOD, DATABASE_URL: 'not a url' })).toContain('DATABASE_URL');
  });

  it('checks a secret rotation is set up sensibly', () => {
    expect(names({ ...GOOD, GATEWAY_KEY_ENCRYPTION_SECRET_PREVIOUS: 'cd'.repeat(32) })).toEqual([]);
    expect(names({ ...GOOD, GATEWAY_KEY_ENCRYPTION_SECRET_PREVIOUS: GOOD.GATEWAY_KEY_ENCRYPTION_SECRET })).toContain('GATEWAY_KEY_ENCRYPTION_SECRET_PREVIOUS');
    expect(names({ ...GOOD, GATEWAY_KEY_ENCRYPTION_SECRET: undefined, GATEWAY_KEY_ENCRYPTION_SECRET_PREVIOUS: 'cd'.repeat(32) })).toContain('GATEWAY_KEY_ENCRYPTION_SECRET_PREVIOUS');
  });

  it('never puts a value in what it reports', () => {
    const secret = 'super-secret-value-123';
    const text = JSON.stringify(validateProductionEnv({ ...GOOD, GATEWAY_KEY_ENCRYPTION_SECRET: secret, DATABASE_URL: `postgresql://u:${secret}@h/desk_api_dev` }));
    expect(text).not.toContain(secret);
  });
});

describe('ops/machine (machine-level scripts kept in git)', () => {
  const dir = join(__dirname, '..', '..', 'ops', 'machine');
  const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : [join(d, e.name)]));
  const all = files(dir);

  it('contains the scripts and the task definitions', () => {
    const rel = all.map((f) => f.slice(dir.length + 1).replace(/\\/g, '/'));
    for (const f of ['watchdog-desk-local-services.ps1', 'boot-recovery-trigger-deploys.ps1', 'run-tunnel.cmd', 'install.ps1', 'README.md', 'tunnel-ingress-config.json']) expect(rel).toContain(f);
    expect(rel.filter((f) => f.startsWith('tasks/') && f.endsWith('.xml')).length).toBeGreaterThanOrEqual(9);
  });

  it('holds no secrets: no long token-like strings, no known key prefixes, no account or machine identities', () => {
    const suspicious: string[] = [];
    for (const file of all) {
      const text = readFileSync(file, 'utf8');
      const name = file.slice(dir.length + 1);
      if (/\b(ghp_|github_pat_|sk-[A-Za-z0-9]|re_[A-Za-z0-9]{10,}|xox[bp]-)/.test(text)) suspicious.push(`${name}: known key prefix`);
      if (/eyJ[A-Za-z0-9_-]{20,}/.test(text)) suspicious.push(`${name}: token-like (JWT)`);
      // A secret has letters AND digits and no separators; a run of repo names joined with slashes is not one.
      if (/\b(?=[A-Za-z0-9_=-]*[0-9])(?=[A-Za-z0-9_=-]*[A-Za-z])[A-Za-z0-9_=-]{48,}\b/.test(text.replace(/https?:\/\/\S+/g, '').replace(/"_comment"[^\n]*/g, ''))) suspicious.push(`${name}: long token-like string`);
      if (/S-1-5-21-\d+/.test(text)) suspicious.push(`${name}: a Windows account id`);
      if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(text) && name.endsWith('.json')) suspicious.push(`${name}: a Cloudflare account/tunnel id`);
    }
    expect(suspicious).toEqual([]);
  });

  it('the scheduled tasks are portable: the user is a placeholder, not this machine\'s account', () => {
    for (const f of all.filter((x) => x.endsWith('.xml'))) {
      const xml = readFileSync(f, 'utf8');
      expect(xml, f).toContain('@@CURRENT_USER@@');
      expect(xml, f).not.toMatch(/DESKTOP-/);
      expect(xml, f).toMatch(/<URI>.+<\/URI>/);
    }
  });

  it('every script the installer copies exists in the folder', () => {
    const installer = readFileSync(join(dir, 'install.ps1'), 'utf8');
    const listed = [...installer.matchAll(/'([A-Za-z0-9.-]+\.(?:ps1|cmd))'/g)].map((m) => m[1]);
    expect(listed.length).toBeGreaterThanOrEqual(4);
    for (const f of listed) expect(readdirSync(dir)).toContain(f);
  });
});
