// The small pure helpers behind the Webhooks, Apps and Plans & billing pages, and the shared tab row.
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain browser module without type declarations
import { formatMoney, monthLabel, usageShare, parseLines, statusChip, EVENT_LABELS, SCOPE_LABELS } from '../../library-ui/format.js';
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

describe('monthLabel', () => {
  it('names the month in UTC so it never shifts with the reader\'s time zone', () => {
    expect(monthLabel('2026-09-01T00:00:00.000Z')).toBe('September 2026');
    expect(monthLabel('2026-01-01T00:00:00.000Z')).toBe('January 2026');
  });
  it('is blank for a bad date', () => expect(monthLabel('nope')).toBe(''));
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
    expect(Object.keys(EVENT_LABELS)).toHaveLength(9);
    expect(Object.keys(SCOPE_LABELS).sort()).toEqual(['businesses', 'drafts', 'profile', 'teams']);
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
