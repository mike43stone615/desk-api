// The changelog as data: CHANGELOG.md (newest first, one "## date: title" heading per release) read into entries, so it can be
// served as JSON and as an Atom feed instead of only living in the repository. The build copies the file next to the code.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ChangelogEntry {
  id: string;
  title: string;
  /** YYYY-MM-DD of the release (the day it started, for a range such as 2026-09-20/21), or null when the heading has none. */
  date: string | null;
  items: string[];
}

export function parseChangelog(markdown: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let current: ChangelogEntry | null = null;
  let item: string[] | null = null;
  const flush = () => {
    if (current && item) current.items.push(item.join(' ').replace(/\s+/g, ' ').replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').trim());
    item = null;
  };
  for (const raw of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const heading = /^##\s+(.+)$/.exec(raw);
    if (heading) {
      flush();
      const text = heading[1].trim();
      const date = /^(\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ?? null;
      const title = text.replace(/^\d{4}-\d{2}-\d{2}(?:\/\d{1,2})?\s*:?\s*/, '').trim() || text;
      current = { id: text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), title, date, items: [] };
      entries.push(current);
    } else if (current) {
      const bullet = /^-\s+(.*)$/.exec(raw);
      if (bullet) { flush(); item = [bullet[1]]; }
      else if (item && /^\s+\S/.test(raw)) item.push(raw.trim());
      else if (raw.trim() === '') flush();
    }
  }
  flush();
  return entries;
}

let cache: { at: number; entries: ChangelogEntry[] } | null = null;

/** The entries, newest first. Cached for a minute; an unreadable file gives an empty list (never an error). */
export function loadChangelog(): ChangelogEntry[] {
  if (cache && Date.now() - cache.at < 60_000) return cache.entries;
  const candidates = [join(__dirname, '..', '..', 'CHANGELOG.md'), join(__dirname, '..', '..', '..', 'CHANGELOG.md')];
  const file = candidates.find((f) => existsSync(f));
  let entries: ChangelogEntry[] = [];
  try { if (file) entries = parseChangelog(readFileSync(file, 'utf8')); } catch { /* keep empty */ }
  cache = { at: Date.now(), entries };
  return entries;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] as string);

/** An Atom feed (RFC 4287) of the changelog. */
export function changelogAtom(entries: ChangelogEntry[], selfUrl: string): string {
  const updated = (e: ChangelogEntry) => `${e.date ?? '1970-01-01'}T00:00:00Z`;
  const newest = entries[0] ? updated(entries[0]) : '1970-01-01T00:00:00Z';
  const body = entries.slice(0, 30).map((e) => `  <entry>
    <id>tag:deskbusiness.co,${e.date ?? '1970-01-01'}:${esc(e.id)}</id>
    <title>${esc(e.title)}</title>
    <updated>${updated(e)}</updated>
    <content type="html">${esc(`<ul>${e.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`)}</content>
  </entry>`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${esc(selfUrl)}</id>
  <title>Desk API: what changed</title>
  <updated>${newest}</updated>
  <link rel="self" href="${esc(selfUrl)}"/>
${body}
</feed>
`;
}
