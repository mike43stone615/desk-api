// The public front door at https://api.deskbusiness.co/ : what the API Library
// is, which APIs it offers, how a key is used, and where to sign in and create
// one. Key creation itself lives in the web app (/developer), because that is
// where sign-in and the session cookie live. Static and public: nothing here
// depends on who is asking, and no secret or per-user data appears.
// Colors/type are the same tokens as the web app's style.css.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config';
import { getServiceCatalog } from '../domain/gateway/services';

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const QUICK_START = `curl https://api.deskbusiness.co/v1/setup/businesses \\
  -H "x-api-key: YOUR_API_KEY"`;

export function renderLandingPage(): string {
  const appUrl = config.appBaseUrl.replace(/\/+$/, '');
  const keysUrl = `${appUrl}/developer`;
  // /docs is only linked when it is actually public (see requireMetricsDocsKey).
  const docsLink = config.metricsDocsApiKey ? '' : '<a class="btn" href="/docs">API reference</a>';
  const cards = getServiceCatalog()
    .map(
      (s) => `
      <div class="card">
        <h3>${esc(s.name)}</h3>
        <p>${esc(s.description)}</p>
        <div class="path">${esc(s.basePath)}</div>
      </div>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Desk API Library</title>
  <meta name="description" content="Create API keys and choose which Desk APIs each one can call." />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
  <style>
    :root { --bg:#070d1a; --surface:#0e1626; --input:#111b2d; --line:#22304a; --line-strong:#2c3d5e;
      --accent:#3b82f6; --accent-hover:#60a5fa; --ink:#fff; --ink-soft:#cbd5e1; --ink-faint:#94a3b8; }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; font-size:15px; line-height:1.5; }
    header { background:var(--surface); border-bottom:1px solid var(--line); padding:12px 24px; display:flex; align-items:center; gap:12px; }
    header img { width:32px; height:32px; display:block; }
    header span { font-weight:700; font-size:1.25rem; }
    main { max-width:960px; margin:0 auto; padding:40px 24px 80px; }
    h1 { font-size:1.75rem; font-weight:700; margin:0 0 4px; }
    .lead { color:var(--ink-soft); font-size:1rem; font-weight:500; margin:0 0 24px; }
    .actions { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:40px; }
    .btn { display:inline-flex; align-items:center; padding:10px 18px; border-radius:12px; border:1px solid var(--line); background:var(--surface); color:var(--ink); font-weight:700; font-size:.88rem; text-decoration:none; }
    .btn:hover { background:#162033; }
    .btn.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
    .btn.primary:hover { background:var(--accent-hover); }
    .btn:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
    h2 { font-size:1.25rem; font-weight:700; margin:0 0 12px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:12px; margin-bottom:40px; }
    .card { background:var(--surface); border:1px solid var(--line); border-radius:18px; padding:20px; }
    .card h3 { margin:0 0 8px; font-size:1.05rem; }
    .card p { margin:0 0 12px; color:var(--ink-soft); font-size:.88rem; font-weight:500; }
    .path { color:var(--ink-faint); font-size:.78rem; }
    pre { margin:0 0 12px; padding:12px; overflow-x:auto; background:var(--input); border:1px solid var(--line); border-radius:12px; color:var(--ink-soft);
      font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:.8rem; line-height:1.5; }
    .note { color:var(--ink-faint); font-size:.85rem; }
  </style>
</head>
<body>
  <header>
    <img src="${esc(appUrl)}/desk_logo.png" alt="" width="32" height="32" />
    <span>Desk</span>
  </header>
  <main>
    <h1>API Library</h1>
    <p class="lead">Create API keys and choose which Desk APIs each one can call.</p>
    <div class="actions">
      <a class="btn primary" href="${esc(keysUrl)}">Sign in to create a key</a>
      ${docsLink}
    </div>

    <h2>Available APIs</h2>
    <div class="grid">${cards}
    </div>

    <h2>Using a key</h2>
    <p class="note">Send your key in the <b>x-api-key</b> header. It is shown once, when you create it, and you can revoke it at any time.</p>
    <pre>${esc(QUICK_START)}</pre>
    <p class="note">A key can only ever see data your own account can see.</p>
  </main>
</body>
</html>`;
}

export async function landingPageHandler(_request: FastifyRequest, reply: FastifyReply) {
  reply.header('Content-Type', 'text/html; charset=utf-8');
  return reply.send(renderLandingPage());
}
