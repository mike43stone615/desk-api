// The small pure helpers behind the Webhooks, Apps and Plans & billing pages, and the shared tab row.
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain browser module without type declarations
import { formatMoney, periodText, usageShare, parseLines, statusChip, EVENT_LABELS, SCOPE_LABELS, SCOPE_GROUPS } from '../../library-ui/format.js';
import { ALL_OAUTH_SCOPES, APP_SCOPES } from '../domain/oauth/scopes';
// @ts-expect-error plain browser module without type declarations
import { TABS, tabsHtml, setAdminTab } from '../../library-ui/tabs.js';

describe('formatMoney', () => {
  it('shows whole dollars without cents and part dollars with two decimals', () => {
    expect(formatMoney(0)).toBe('$0');
    expect(formatMoney(4900)).toBe('$49');
    expect(formatMoney(12)).toBe('$0.12');
    expect(formatMoney(1999)).toBe('$19.99');
  });
  it('copes with junk and unknown currencies instead of throwing', () => {
    expect(formatMoney(undefined)).toBe('$0');
    expect(formatMoney('abc')).toBe('$0');
    expect(formatMoney(250, 'not-a-currency')).toBe('$2.50');
  });
});

describe('periodText', () => {
  it("shows a period's first and last day in UTC (the stored end is the next period's first moment)", () => {
    expect(periodText('2026-07-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z')).toBe('July 20, 2026 - August 19, 2026');
    expect(periodText('2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')).toBe('October 1, 2026 - October 31, 2026');
  });
  it('is blank for a bad date', () => expect(periodText('nope', 'nope')).toBe(''));
});

describe('usageShare', () => {
  it('is a whole percent of the included amount', () => {
    expect(usageShare(150, 300)).toEqual({ percent: 50, over: false, extra: 0 });
    expect(usageShare(0, 300)).toEqual({ percent: 0, over: false, extra: 0 });
  });
  it('caps the bar at 100 and reports how far over', () => {
    expect(usageShare(450, 300)).toEqual({ percent: 100, over: true, extra: 150 });
    expect(usageShare(300, 300)).toEqual({ percent: 100, over: false, extra: 0 });
  });
  it('handles a plan that includes nothing', () => {
    expect(usageShare(0, 0)).toEqual({ percent: 0, over: false, extra: 0 });
    expect(usageShare(5, 0)).toEqual({ percent: 100, over: true, extra: 5 });
  });
  it('treats negative and junk numbers as zero', () => {
    expect(usageShare(-4, 10).percent).toBe(0);
    expect(usageShare('x', 10).percent).toBe(0);
  });
});

describe('parseLines', () => {
  it('splits on lines and commas, trims, drops blanks and duplicates', () => {
    expect(parseLines(' https://a.example/cb \n\nhttps://b.example/cb,https://a.example/cb ')).toEqual(['https://a.example/cb', 'https://b.example/cb']);
  });
  it('is empty for nothing', () => {
    expect(parseLines('')).toEqual([]);
    expect(parseLines(null)).toEqual([]);
  });
});

describe('labels', () => {
  it('names every webhook event and scope in plain English', () => {
    expect(Object.keys(EVENT_LABELS)).toHaveLength(15);
    // Every scope the server accepts (granular + the four original ones) has a label, and nothing else does.
    expect(Object.keys(SCOPE_LABELS).sort()).toEqual([...ALL_OAUTH_SCOPES].sort());
    type Item = { id: string; children?: Item[] };
    const flat = (items: Item[]): string[] => items.flatMap((i) => [i.id, ...flat(i.children ?? [])]);
    // The registration form offers exactly the scopes an app may register — nothing internal.
    expect(flat((SCOPE_GROUPS as Array<{ scopes: Item[] }>).flatMap((g) => g.scopes)).sort()).toEqual([...APP_SCOPES].sort());
  });
  it('says what happened to a delivery', () => {
    expect(statusChip({ status: 'delivered' })).toBe('Delivered');
    expect(statusChip({ status: 'pending' })).toBe('Waiting to retry');
    expect(statusChip({ status: 'failed' })).toBe('Failed');
    expect(statusChip({ status: 'other' })).toBe('other');
  });
});

describe('tabsHtml', () => {
  it('lists every section, marking only the current one', () => {
    const html = tabsHtml('/developer/apps');
    for (const t of TABS) expect(html).toContain(`href="${t.path}"`);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/href="\/developer\/apps"[^>]*class="page-tab active"/);
  });
  it('marks nothing when the page is not a tab', () => {
    expect(tabsHtml('/elsewhere')).not.toContain('aria-current');
  });
});

describe('the Administration tab', () => {
  it('is not in the tab row until an administrator is confirmed, and goes away again', () => {
    setAdminTab(false);
    expect(tabsHtml('/developer')).not.toContain('/developer/admin');
    setAdminTab(true);
    const html = tabsHtml('/developer/admin');
    expect(html).toContain('href="/developer/admin"');
    expect(html).toContain('Administration');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    setAdminTab('yes'); // only a real true counts
    expect(tabsHtml('/developer')).not.toContain('/developer/admin');
    setAdminTab(false);
  });
});
