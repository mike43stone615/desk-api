// Text helpers must stay fast on hostile input (a long run of one character used to make some regexes quadratic).
import { describe, it, expect } from 'vitest';
import { trimTrailingSlashes } from '../utils/strings';
import { htmlToText } from '../infrastructure/email/resend';

describe('regex safety', () => {
  it('trimTrailingSlashes trims only trailing slashes and is fast on 200k of them', () => {
    expect(trimTrailingSlashes('http://a/b//')).toBe('http://a/b');
    expect(trimTrailingSlashes('/')).toBe('');
    expect(trimTrailingSlashes('a/b')).toBe('a/b');
    const t0 = performance.now();
    trimTrailingSlashes('a' + '/'.repeat(200_000) + 'x/' + '/'.repeat(200_000));
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it('htmlToText still converts links and tags, and is fast on hostile input', () => {
    expect(htmlToText('<p>Hi <b>there</b></p><a href="https://x.co/a?b=1">Go <i>now</i></a>')).toBe('Hi there\nGo now: https://x.co/a?b=1');
    for (const hostile of ['<'.repeat(50_000), '<a'.repeat(25_000), ' '.repeat(50_000) + 'x', '<p>' + '\t\n '.repeat(20_000)]) {
      const t0 = performance.now();
      htmlToText(hostile);
      expect(performance.now() - t0).toBeLessThan(500);
    }
  });
});
