// Every code used in source is documented, and every status default is documented.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ERROR_CODES } from '../middleware/error-codes';
import { defaultCode } from '../middleware/http-error';

const src = join(__dirname, '..');
const files = (d: string): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === '__tests__' ? [] : files(join(d, e.name))) : e.name.endsWith('.ts') ? [join(d, e.name)] : []));

describe('error codes', () => {
  const text = files(src).map((f) => readFileSync(f, 'utf8')).join('\n');

  it('every code passed to HttpError / UpstreamError is listed in ERROR_CODES', () => {
    const used = new Set<string>();
    // The code is the last quoted word before the closing parenthesis of the call, on the same line.
    for (const line of text.split(/\r?\n/)) {
      if (!/new (?:HttpError|UpstreamError)\(/.test(line)) continue;
      const all = [...line.matchAll(/, '([a-z][a-z0-9_]+)'\)/g)];
      if (all.length > 0) used.add(all[all.length - 1][1]);
    }
    expect(used.size).toBeGreaterThan(30);
    const unlisted = [...used].filter((c) => !(c in ERROR_CODES));
    expect(unlisted).toEqual([]);
  });

  it('every status default is listed', () => {
    for (const status of [400, 401, 403, 404, 405, 409, 413, 415, 422, 429, 500, 502, 503, 504, 418, 599]) expect(defaultCode(status) in ERROR_CODES, String(status)).toBe(true);
  });

  it('the auth service codes are all listed', () => {
    const codes = [...readFileSync(join(src, 'infrastructure', 'auth', 'auth-service.ts'), 'utf8').matchAll(/AuthError\('([a-z_]+)'\)/g)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThan(5);
    for (const c of codes) expect(c in ERROR_CODES, c).toBe(true);
  });

  it('every code has a one-line meaning and is lower snake_case', () => {
    for (const [code, meaning] of Object.entries(ERROR_CODES)) {
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(meaning.length).toBeGreaterThan(8);
      expect(meaning).not.toContain('\n');
    }
  });
});
