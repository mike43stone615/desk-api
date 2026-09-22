// The public status page: is Desk working right now? Only "operational / degraded / down" per part, no detail that
// could help an attacker and nothing about any person. Built from the same checks the readiness probe uses.
import type { DependencyState } from './dependencies';
import type { Incident } from '../status/incidents';

export type PartStatus = 'operational' | 'degraded' | 'down';
export interface StatusView {
  status: PartStatus;
  asOf: string;
  components: Array<{ name: string; status: PartStatus }>;
  support: string;
  changelog: string;
  /** Open incidents, and resolved ones from the last 30 days. */
  incidents: { active: Incident[]; recent: Incident[] };
}

const LABELS: Record<string, string> = {
  registry_api: 'Registry API (name availability, business structures)',
  market_validation_api: 'Market Validation API (idea scoring)',
  compliance_os: 'Compliance data',
};

export function buildStatus(database: 'ok' | 'error', dependencies: Record<string, DependencyState>, support: string, now = new Date(), incidents: StatusView['incidents'] = { active: [], recent: [] }): StatusView {
  const components: StatusView['components'] = [
    { name: 'Desk API and sign-in', status: database === 'ok' ? 'operational' : 'down' },
    { name: 'Database', status: database === 'ok' ? 'operational' : 'down' },
    ...Object.entries(dependencies)
      .filter(([, s]) => s !== 'not_configured')
      .map(([name, s]): StatusView['components'][number] => ({ name: LABELS[name] ?? name, status: s === 'ok' ? 'operational' : 'degraded' })),
  ];
  // An open major or critical incident means the page cannot say "everything is working", whatever the automatic checks show.
  const incidentFloor: PartStatus = incidents.active.some((i) => i.severity !== 'minor') ? 'degraded' : 'operational';
  const fromChecks: PartStatus = components.some((c) => c.status === 'down') ? 'down' : components.some((c) => c.status === 'degraded') ? 'degraded' : 'operational';
  const status: PartStatus = fromChecks === 'operational' ? incidentFloor : fromChecks;
  return { status, asOf: now.toISOString(), components, support, changelog: '/v1/changelog', incidents };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const WORD: Record<PartStatus, string> = { operational: 'Operational', degraded: 'Degraded', down: 'Down' };
const COLOR: Record<PartStatus, string> = { operational: '#14703a', degraded: '#8a5a05', down: '#a5281f' };

/** A small self-contained page (no scripts, no outside requests). `banner`, when given, is one of the outcomes the
 * subscribe/confirm/unsubscribe redirects land back on this page with. */
export function statusHtml(view: StatusView, banner?: 'subscribed' | 'confirmed' | 'unsubscribed' | 'subscribe_error'): string {
  const BANNER_TEXT: Record<string, string> = {
    subscribed: 'Check your inbox: click the link we just sent to start getting status updates.',
    confirmed: "You're subscribed. You'll get an e-mail when something changes.",
    unsubscribed: 'Unsubscribed. You will not get any more status e-mails.',
    subscribe_error: 'That link is wrong or has expired.',
  };
  const bannerHtml = banner ? `<p class="banner">${esc(BANNER_TEXT[banner] ?? '')}</p>` : '';
  const rows = view.components.map((c) => `<tr><td>${esc(c.name)}</td><td style="color:${COLOR[c.status]};font-weight:600">${WORD[c.status]}</td></tr>`).join('');
  const when = (iso: string) => esc(iso.slice(0, 16).replace('T', ' ') + ' UTC');
  const incident = (i: StatusView['incidents']['active'][number]) => `<div class="incident"><strong>${esc(i.title)}</strong> <span class="sev">${esc(i.severity)} · ${esc(i.status)}</span>${i.updates.map((u) => `<div class="upd"><span>${when(u.at)}</span> <b>${esc(u.status)}</b>: ${esc(u.message)}</div>`).join('')}</div>`;
  const incidentsHtml = view.incidents.active.length + view.incidents.recent.length === 0
    ? '<p>No incidents in the last 30 days.</p>'
    : `${view.incidents.active.length ? `<h2>Happening now</h2>${view.incidents.active.map(incident).join('')}` : ''}${view.incidents.recent.length ? `<h2>Past 30 days</h2>${view.incidents.recent.map(incident).join('')}` : ''}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>Desk status</title>
<style>
  body { font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 32px 16px; color: #0e1726; background: #f2f5f9; }
  main { max-width: 640px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  h1 { font-size: 1.5rem; margin: 0 0 4px; }
  .overall { font-size: 1.15rem; font-weight: 600; margin: 8px 0 20px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 10px 0; border-top: 1px solid #d6dee9; }
  td:last-child { text-align: right; }
  p { color: #3e4d64; font-size: .9rem; }
  h2 { font-size: 1rem; margin: 24px 0 8px; }
  .incident { border-top: 1px solid #d6dee9; padding: 10px 0; font-size: .92rem; }
  .sev { color: #8a5a05; font-size: .8rem; }
  .upd { color: #3e4d64; margin-top: 4px; }
  .upd span { color: #6b7a90; }
  a { color: #2058d6; }
  .banner { background: #e6f2ea; color: #14703a; border-radius: 8px; padding: 10px 14px; font-size: .92rem; }
  .subscribe { margin-top: 24px; border-top: 1px solid #d6dee9; padding-top: 16px; }
  .subscribe label { display: block; font-size: .85rem; color: #3e4d64; margin-bottom: 6px; }
  .subscribe-row { display: flex; gap: 8px; }
  .subscribe-row input { flex: 1; min-width: 0; padding: 8px 10px; border: 1px solid #c3ceda; border-radius: 8px; font: inherit; }
  .subscribe-row button { padding: 8px 14px; border: none; border-radius: 8px; background: #2058d6; color: #fff; font: inherit; cursor: pointer; }
  @media (prefers-color-scheme: dark) { body { background: #080e1c; color: #eef3fa; } main { background: #0f1829; } td { border-color: #21304a; } p { color: #b7c3d6; } a { color: #6ea3ff; } .banner { background: #113322; color: #7fd9a0; } .subscribe { border-color: #21304a; } .subscribe label { color: #b7c3d6; } .subscribe-row input { background: #0a1220; border-color: #21304a; color: #eef3fa; } }
</style>
</head>
<body>
<main>
  <h1>Desk status</h1>
  ${bannerHtml}
  <div class="overall" style="color:${COLOR[view.status]}">${view.status === 'operational' ? 'Everything is working' : view.status === 'degraded' ? 'Some features are having problems' : 'Desk is down'}</div>
  <table>${rows}</table>
  ${incidentsHtml}
  <p>Checked ${esc(view.asOf)}. This page refreshes every minute.</p>
  <p>Something wrong that is not shown here? <a href="${esc(view.support)}">Tell us</a>. What changed recently: <a href="${esc(view.changelog)}">changelog</a>.</p>
  <form method="post" action="/status/subscribe" class="subscribe">
    <label for="subscribe-email">Get an e-mail when this changes</label>
    <div class="subscribe-row">
      <input id="subscribe-email" name="email" type="email" placeholder="you@example.com" required maxlength="254">
      <button type="submit">Subscribe</button>
    </div>
  </form>
</main>
</body>
</html>`;
}
