// Apps: register an app that signs people in with Desk (OAuth 2.0), and see/revoke the apps you yourself have let into your
// account. Backed by /oauth/clients and /oauth/authorizations (src/routes/oauth.ts). A client secret is shown once.
import {
  registerRoute, api, esc, icon, spinnerBtn, statusMsg, friendlyError, toast, reportHandledException, currentEpoch, submitOnEnter, navigate,
} from '../app.js';
import { tabsHtml } from '../tabs.js';
import { SCOPE_LABELS, parseLines } from '../format.js';

const SCOPES = ['profile', 'drafts', 'businesses', 'teams'];
const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

registerRoute('/developer/apps', async (app) => {
  const myEpoch = currentEpoch();
  const s = {
    isLoading: true, loadError: null, clients: [], authorizations: [],
    name: '', redirects: '', chosen: new Set(['profile']), confidential: true,
    isCreating: false, formError: null, revealed: null, // { client, secret }
    confirm: null, isBusy: false, _lastFormError: null,
  };
  const isCurrent = () => currentEpoch() === myEpoch;

  async function loadAll() {
    const [c, a] = await Promise.all([api('/oauth/clients'), api('/oauth/authorizations')]);
    s.clients = c.clients || [];
    s.authorizations = a.authorizations || [];
  }
  async function load() {
    s.isLoading = true; s.loadError = null; render();
    try { await loadAll(); } catch (err) { reportHandledException(err, 'loadApps'); s.loadError = friendlyError(err, 'We could not load your apps.'); }
    finally { if (isCurrent()) { s.isLoading = false; render(); } }
  }

  async function createClient(e) {
    e.preventDefault();
    const uris = parseLines(s.redirects);
    if (!s.name.trim()) { s.formError = 'Give the app a name people will recognize.'; render(); return; }
    if (uris.length === 0) { s.formError = 'Add at least one redirect address.'; render(); return; }
    if (s.chosen.size === 0) { s.formError = 'Choose at least one thing the app may read.'; render(); return; }
    s.isCreating = true; s.formError = null; render();
    try {
      const res = await api('/oauth/clients', { method: 'POST', body: { name: s.name.trim(), redirectUris: uris, scopes: SCOPES.filter((x) => s.chosen.has(x)), confidential: s.confidential } });
      s.revealed = { client: res.client, secret: res.clientSecret };
      s.name = ''; s.redirects = ''; s.chosen = new Set(['profile']); s.confidential = true;
      await loadAll();
    } catch (err) {
      reportHandledException(err, 'createOAuthClient');
      s.formError = friendlyError(err, 'We could not register that app. Please try again.');
    } finally { s.isCreating = false; if (isCurrent()) render(); }
  }

  async function guarded(what, fn, failText) {
    if (s.isBusy) return;
    s.isBusy = true; render();
    try { await fn(); } catch (err) { reportHandledException(err, what); toast(friendlyError(err, failText), true); }
    finally { s.confirm = null; s.isBusy = false; if (isCurrent()) render(); }
  }
  const removeClient = (id) => guarded('deleteOAuthClient', async () => {
    await api(`/oauth/clients/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (s.revealed && s.revealed.client.id === id) s.revealed = null;
    await loadAll();
    toast('App removed. Every token it held stopped working.');
  }, 'Could not remove that app.');
  const revokeAccess = (id) => guarded('revokeAuthorization', async () => {
    await api(`/oauth/authorizations/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await loadAll();
    toast('Access removed.');
  }, 'Could not remove that access.');

  async function copyValue(id, value, label) {
    const input = document.getElementById(id);
    try { await navigator.clipboard.writeText(value); toast(`${label} copied.`); } catch { if (input) input.select(); toast('Press Ctrl+C to copy the selected text.'); }
  }
  const onKeydown = (e) => {
    if (!isCurrent()) { document.removeEventListener('keydown', onKeydown); return; }
    if (e.key === 'Escape' && s.confirm && !s.isBusy) { s.confirm = null; render(); }
  };
  document.addEventListener('keydown', onKeydown);

  const clientHtml = (c) => `
    <div class="state-card key-card">
      <div class="biz-icon neutral">${icon('category_outlined')}</div>
      <div class="biz-body">
        <div class="biz-title">${esc(c.name)}</div>
        <div class="biz-sub">Client id <code>${esc(c.id)}</code> · ${c.confidential ? 'has a client secret' : 'public app (PKCE only)'} · added ${esc(when(c.createdAt))}</div>
        <div class="biz-sub">Sends people back to: ${c.redirectUris.map((u) => `<code>${esc(u)}</code>`).join(', ')}</div>
        <div class="biz-chips">${c.scopes.map((x) => `<span class="meta-chip">${esc(SCOPE_LABELS[x] || x)}</span>`).join('')}</div>
      </div>
      <button type="button" class="btn btn-sm" data-remove-client="${esc(c.id)}" data-name="${esc(c.name)}" aria-label="Remove app ${esc(c.name)}">Remove</button>
    </div>`;
  const authHtml = (a) => `
    <div class="state-card key-card">
      <div class="biz-icon neutral">${icon('check_circle_outline')}</div>
      <div class="biz-body">
        <div class="biz-title">${esc(a.name)}</div>
        <div class="biz-sub">Allowed ${esc(when(a.authorizedAt))}${a.lastUsedAt ? ` · last used ${esc(when(a.lastUsedAt))}` : ' · never used'}</div>
        <div class="biz-chips">${a.scopes.map((x) => `<span class="meta-chip">${esc(SCOPE_LABELS[x] || x)}</span>`).join('')}</div>
      </div>
      <button type="button" class="btn btn-sm" data-revoke-access="${esc(a.clientId)}" data-name="${esc(a.name)}" aria-label="Take away access from ${esc(a.name)}">Take away access</button>
    </div>`;

  function render() {
    let body;
    if (s.isLoading) body = `<div class="empty-state">${spinnerBtn(true, '', { dark: true })}<div style="margin-top:var(--sp-md);">Loading your apps…</div></div>`;
    else if (s.loadError) body = `<div class="empty-state">${icon('error_outline')}<div style="margin-top:var(--sp-md);">Apps could not load</div><div class="hint">${esc(s.loadError)}</div><button type="button" class="btn" id="retry-btn" style="margin-top:var(--sp-lg);">${icon('refresh')} Try again</button></div>`;
    else {
      const animate = s.formError !== s._lastFormError; s._lastFormError = s.formError;
      body = `
        ${s.revealed ? `
          <div class="card" style="margin-bottom:var(--sp-lg);">
            <h2 class="biz-section-title">${esc(s.revealed.client.name)} is registered</h2>
            <p class="biz-sub" style="margin-bottom:var(--sp-md);">${s.revealed.secret ? 'Copy the client secret now: it is only shown this once.' : 'This is a public app: it has no secret and must use PKCE.'}</p>
            <div class="field-header"><label for="app-id">Client id</label></div>
            <div class="reveal-key"><input id="app-id" readonly value="${esc(s.revealed.client.id)}" /><button type="button" class="btn" id="copy-id">${icon('content_copy')} Copy</button></div>
            ${s.revealed.secret ? `<div class="field-header" style="margin-top:var(--sp-md);"><label for="app-secret">Client secret</label></div><div class="reveal-key"><input id="app-secret" readonly value="${esc(s.revealed.secret)}" /><button type="button" class="btn btn-primary" id="copy-secret">${icon('content_copy')} Copy</button></div>` : ''}
            <button type="button" class="btn" id="dismiss" style="margin-top:var(--sp-lg);">I've saved it</button>
          </div>` : ''}
        <div class="card" style="margin-bottom:var(--sp-lg);">
          <h2 class="biz-section-title">Register an app</h2>
          <p class="biz-sub" style="margin-bottom:var(--sp-lg);">For an app that lets people sign in with Desk and read part of their account, with their approval. It can only read; it can never change anything. Every app must use PKCE.</p>
          <form id="app-form" novalidate>
            <div class="field-float has-icon"><span class="field-icon">${icon('category_outlined')}</span><label>App name</label><input name="name" placeholder=" " maxlength="64" value="${esc(s.name)}" autocomplete="off" /></div>
            <div class="field-header"><label for="redirects">Redirect addresses (one per line)</label></div>
            <textarea id="redirects" name="redirects" rows="3" class="team-select" style="width:100%;" placeholder="https://yourapp.example.com/callback" maxlength="1500">${esc(s.redirects)}</textarea>
            <p class="biz-sub">https addresses only (http is allowed for localhost while you build). The app can only send people back to these exact addresses.</p>
            <div class="field-header"><label>What the app may read</label></div>
            <div class="library-list">${SCOPES.map((x) => `<label class="library-row"><input type="checkbox" name="scope" value="${x}" ${s.chosen.has(x) ? 'checked' : ''} /><span class="library-body"><span class="name">${esc(SCOPE_LABELS[x])}</span></span></label>`).join('')}</div>
            <label class="library-row" style="margin-top:var(--sp-md);"><input type="checkbox" name="confidential" ${s.confidential ? 'checked' : ''} /><span class="library-body"><span class="name">The app has a server that can keep a secret</span><span class="biz-sub">Untick for a mobile or single-page app: it then gets no secret and relies on PKCE alone.</span></span></label>
            ${s.formError ? statusMsg('error', s.formError, animate) : ''}
            <button type="submit" class="btn btn-primary" style="margin-top:var(--sp-lg);" ${s.isCreating ? 'disabled' : ''}>${s.isCreating ? spinnerBtn(true, '') : icon('category_outlined')}${s.isCreating ? '' : ' Register app'}</button>
          </form>
        </div>
        <h2 class="biz-section-title">Apps you registered</h2>
        ${s.clients.length ? s.clients.map(clientHtml).join('') : `<div class="state-card"><div class="biz-icon neutral">${icon('category_outlined')}</div><div class="biz-body"><div class="biz-title">No apps yet</div><div class="biz-sub">Register one above.</div></div></div>`}
        <h2 class="biz-section-title" style="margin-top:var(--sp-xl);">Apps you have let into your account</h2>
        ${s.authorizations.length ? s.authorizations.map(authHtml).join('') : `<div class="state-card"><div class="biz-icon neutral">${icon('check_circle_outline')}</div><div class="biz-body"><div class="biz-title">No apps have access</div><div class="biz-sub">When you approve an app on its sign-in screen it appears here, and you can take its access away.</div></div></div>`}`;
    }
    const c = s.confirm;
    app.innerHTML = `
      <div class="page">
        <div class="page-head-row"><div class="head-text"><h1>API Library</h1><p>Sign in with Desk for your own apps, and control which apps can see your account.</p></div></div>
        ${tabsHtml('/developer/apps')}
        ${body}
      </div>
      ${c ? `<div class="modal-backdrop" id="app-backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="app-modal-title"><h2 id="app-modal-title">${c.kind === 'client' ? 'Remove app' : 'Take away access'}</h2><p>${c.kind === 'client' ? `Remove ${esc(c.name)}? People can no longer sign in with it, and every token it holds stops working immediately.` : `Take away ${esc(c.name)}'s access to your account? It stops working immediately.`}</p><div style="display:flex;justify-content:flex-end;gap:var(--sp-sm);margin-top:var(--sp-xl);"><button type="button" class="btn" id="app-cancel" ${s.isBusy ? 'disabled' : ''}>Cancel</button><button type="button" class="btn btn-danger" id="app-confirm" ${s.isBusy ? 'disabled' : ''}>${s.isBusy ? spinnerBtn(true, '') : (c.kind === 'client' ? 'Remove' : 'Take away')}</button></div></div></div>` : ''}`;
    wire();
  }

  function wire() {
    const $ = (id) => document.getElementById(id);
    app.querySelectorAll('[data-nav]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); navigate(a.dataset.nav); }));
    const retry = $('retry-btn'); if (retry) retry.addEventListener('click', load);
    const form = $('app-form');
    if (form) {
      form.addEventListener('submit', createClient); submitOnEnter(form);
      form.querySelector('input[name="name"]').addEventListener('input', (e) => { s.name = e.target.value; });
      form.querySelector('textarea[name="redirects"]').addEventListener('input', (e) => { s.redirects = e.target.value; });
      form.querySelectorAll('input[name="scope"]').forEach((box) => box.addEventListener('change', () => { if (box.checked) s.chosen.add(box.value); else s.chosen.delete(box.value); }));
      form.querySelector('input[name="confidential"]').addEventListener('change', (e) => { s.confidential = e.target.checked; });
    }
    if (s.revealed) {
      const ci = $('copy-id'); if (ci) ci.addEventListener('click', () => copyValue('app-id', s.revealed.client.id, 'Client id'));
      const cs = $('copy-secret'); if (cs) cs.addEventListener('click', () => copyValue('app-secret', s.revealed.secret, 'Client secret'));
    }
    const dismiss = $('dismiss'); if (dismiss) dismiss.addEventListener('click', () => { s.revealed = null; render(); });
    app.querySelectorAll('[data-remove-client]').forEach((b) => b.addEventListener('click', () => { s.confirm = { kind: 'client', id: b.dataset.removeClient, name: b.dataset.name }; render(); }));
    app.querySelectorAll('[data-revoke-access]').forEach((b) => b.addEventListener('click', () => { s.confirm = { kind: 'access', id: b.dataset.revokeAccess, name: b.dataset.name }; render(); }));
    const cancel = $('app-cancel'); if (cancel) { cancel.addEventListener('click', () => { s.confirm = null; render(); }); cancel.focus(); }
    const ok = $('app-confirm'); if (ok) ok.addEventListener('click', () => { const c = s.confirm; if (c.kind === 'client') removeClient(c.id); else revokeAccess(c.id); });
    const backdrop = $('app-backdrop'); if (backdrop) backdrop.addEventListener('click', (e) => { if (e.target === backdrop && !s.isBusy) { s.confirm = null; render(); } });
  }

  await load();
});
