// The public status page: is Desk working right now? Only "operational / degraded / down" per part, no detail that
// could help an attacker and nothing about any person. Built from the same checks the readiness probe uses.
import type { DependencyState } from './dependencies';

export type PartStatus = 'operational' | 'degraded' | 'down';
export interface StatusView {
  status: PartStatus;
  asOf: string;
  components: Array<{ name: string; status: PartStatus }>;
  support: string;
  changelog: string;
}

const LABELS: Record<string, string> = {
  registry_api: 'Registry API (name availability, business structures)',
  market_validation_api: 'Market Validation API (idea scoring)',
  compliance_os: 'Compliance data',
};

export function buildStatus(database: 'ok' | 'error', dependencies: Record<string, DependencyState>, support: string, now = new Date()): StatusView {
  const components: StatusView['components'] = [
    { name: 'Desk API and sign-in', status: database === 'ok' ? 'operational' : 'down' },
    { name: 'Database', status: database === 'ok' ? 'operational' : 'down' },
    ...Object.entries(dependencies)
      .filter(([, s]) => s !== 'not_configured')
      .map(([name, s]): StatusView['components'][number] => ({ name: LABELS[name] ?? name, status: s === 'ok' ? 'operational' : 'degraded' })),
  ];
  const status: PartStatus = components.some((c) => c.status === 'down') ? 'down' : components.some((c) => c.status === 'degraded') ? 'degraded' : 'operational';
  return { status, asOf: now.toISOString(), components, support, changelog: 'https://github.com/mike43stone615/desk-api/blob/main/CHANGELOG.md' };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const WORD: Record<PartStatus, string> = { operational: 'Operational', degraded: 'Degraded', down: 'Down' };
const COLOR: Record<PartStatus, string> = { operational: '#14703a', degraded: '#8a5a05', down: '#a5281f' };

/** A small self-contained page (no scripts, no outside requests). */
export function statusHtml(view: StatusView): string {
  const rows = view.components.map((c) => `<tr><td>${esc(c.name)}</td><td style="color:${COLOR[c.status]};font-weight:600">${WORD[c.status]}</td></tr>`).join('');
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
  a { color: #2058d6; }
  @media (prefers-color-scheme: dark) { body { background: #080e1c; color: #eef3fa; } main { background: #0f1829; } td { border-color: #21304a; } p { color: #b7c3d6; } a { color: #6ea3ff; } }
</style>
</head>
<body>
<main>
  <h1>Desk status</h1>
  <div class="overall" style="color:${COLOR[view.status]}">${view.status === 'operational' ? 'Everything is working' : view.status === 'degraded' ? 'Some features are having problems' : 'Desk is down'}</div>
  <table>${rows}</table>
  <p>Checked ${esc(view.asOf)}. This page refreshes every minute.</p>
  <p>Something wrong that is not shown here? <a href="${esc(view.support)}">Tell us</a>. What changed recently: <a href="${esc(view.changelog)}">changelog</a>.</p>
</main>
</body>
</html>`;
}
