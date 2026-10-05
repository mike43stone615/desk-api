// Apps: register an app that signs people in with Desk (OAuth 2.0), and see/revoke the apps you yourself have let into your
// account. Backed by /oauth/clients and /oauth/authorizations (src/routes/oauth.ts). A client secret is shown once.
// Laid out like the API keys page (pages/developer.js): the form on the left, the cards on the right, details in "i" badges,
// and the same pop-ups (Details, Rotate, Remove, the one-time secret).
import {
  registerRoute, api, esc, icon, spinnerBtn, statusMsg, friendlyError, toast, reportHandledException, currentEpoch, submitOnEnter, navigate,
} from '../app.js';
import { tabsHtml } from '../tabs.js';
import { SCOPE_GROUPS, SCOPE_LABELS } from '../format.js';

const MAX_REDIRECTS = 50; // the server's limit (MAX_REDIRECT_URIS in src/domain/oauth/oauth.ts)
const ALL_SCOPES = SCOPE_GROUPS.flatMap((g) => g.scopes.map(([id]) => id));
const REDIRECT_HELP = 'One address per field. Addresses must start with https:// (http is allowed for localhost while you build). The app can only send people back to these exact addresses.';
const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};
/** Hoverable (not clickable) "i" badge: a small themed tooltip instead of the native title attribute. Matches pages/developer.js.
    `openRight`: the tooltip opens to the right, for a badge near the left edge where opening left would be cut off. */
function infoIcon(text, openRight = false) {
  if (!text) return '';
  return `<span class="info-icon${openRight ? ' open-right' : ''}" tabindex="0">${icon('info_outline')}<span class="info-tooltip" role="tooltip">${esc(text)}</span></span>`;
}
/** Same rule as the server (validRedirectUri in src/domain/oauth/oauth.ts): https, or http on localhost; no fragment. */
function redirectProblem(uri) {
  try {
    const u = new URL(uri);
    if (u.hash || u.username || u.password) return 'Remove the #fragment or user name from this address.';
    if (u.protocol === 'https:') return null;
    if (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return null;
    return 'Addresses must start with https:// (http is only allowed for localhost).';
  } catch {
    return 'Enter a full address, like https://yourapp.example.com/callback.';
  }
}

/** One redirect-address field, styled like the webhook address field; every field after the first can be removed. */
function redirectFieldHtml(value, index, list, error) {
  return `
    <div class="field-float has-icon redirect-field">
      <span class="field-icon">${icon('link')}</span>
      <label>Redirect address${index > 0 ? ` ${index + 1}` : ''}</label>
      <input data-redirect="${list}" data-index="${index}" type="url" placeholder=" " maxlength="500" value="${esc(value)}" autocomplete="off" class="${error ? 'invalid' : ''}" />
      ${index > 0 ? `<button type="button" class="field-remove" data-remove-redirect="${list}" data-index="${index}" aria-label="Remove redirect address ${index + 1}">${icon('close')}</button>` : ''}
    </div>
    ${error ? `<div class="error-text">${esc(error)}</div>` : ''}`;
}

function redirectListHtml(values, list, errors = {}) {
  return `
    ${values.map((v, i) => redirectFieldHtml(v, i, list, errors[i])).join('')}
    ${values.length < MAX_REDIRECTS ? `<button type="button" class="btn btn-sm add-field-btn" data-add-redirect="${list}">+ Add</button>` : ''}`;
}

function redirectErrors(values) {
  const errors = {};
  values.forEach((v, i) => {
    if (!v.trim()) { errors[i] = i === 0 && values.length === 1 ? 'Add at least one redirect address.' : 'Enter an address, or remove this field.'; return; }
    const p = redirectProblem(v.trim());
    if (p) errors[i] = p;
  });
  return errors;
}

registerRoute('/developer/apps', async (app) => {
  const myEpoch = currentEpoch();
  const s = {
    isLoading: true, loadError: null, clients: [], authorizations: [],
    name: '', redirects: [''], chosen: new Set(['profile:name']), confidential: true,
    isCreating: false, formError: null, fieldErrors: {}, redirectErrors: {},
    revealed: null, // { client, secret, rotated }
    detailFor: null, detailRedirects: [], detailErrors: {}, savingRedirects: false,
    confirm: null, // { kind: 'client' | 'access' | 'rotate', id, name }
    isBusy: false, _lastFormError: null,
  };
  const isCurrent = () => currentEpoch() === myEpoch;
  const findClient = (id) => s.clients.find((c) => c.id === id) || null;

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

  function validate() {
    const errors = {};
    if (!s.name.trim()) errors.name = 'Give the app a name people will recognize.';
    if (s.chosen.size === 0) errors.scopes = 'Choose at least one thing the app may read.';
    return errors;
  }

  async function createClient(e) {
    e.preventDefault();
    s.fieldErrors = validate();
    s.redirectErrors = redirectErrors(s.redirects);
    if (Object.keys(s.fieldErrors).length || Object.keys(s.redirectErrors).length) { render(); return; }
    const uris = [...new Set(s.redirects.map((v) => v.trim()).filter(Boolean))];
    s.isCreating = true; s.formError = null; render();
    try {
      const res = await api('/oauth/clients', { method: 'POST', body: { name: s.name.trim(), redirectUris: uris, scopes: ALL_SCOPES.filter((x) => s.chosen.has(x)), confidential: s.confidential } });
      s.revealed = { client: res.client, secret: res.clientSecret, rotated: false };
      s.name = ''; s.redirects = ['']; s.chosen = new Set(['profile:name']); s.confidential = true;
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
    if (s.detailFor === id) s.detailFor = null;
    await loadAll();
    toast('App removed. Every token it held stopped working.');
  }, 'Could not remove that app.');
  const revokeAccess = (id) => guarded('revokeAuthorization', async () => {
    await api(`/oauth/authorizations/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await loadAll();
    toast('Access removed.');
  }, 'Could not remove that access.');
  const rotateSecret = (id) => guarded('rotateOAuthClientSecret', async () => {
    const res = await api(`/oauth/clients/${encodeURIComponent(id)}/rotate-secret`, { method: 'POST', body: {} });
    const client = findClient(id);
    if (client) s.revealed = { client, secret: res.clientSecret, rotated: true };
  }, 'Could not rotate that secret.');

  function openDetails(id) {
    const c = findClient(id);
    if (!c) return;
    s.detailFor = id; s.detailRedirects = [...c.redirectUris]; s.detailErrors = {};
    render();
  }
  async function saveRedirects() {
    const id = s.detailFor;
    s.detailErrors = redirectErrors(s.detailRedirects);
    if (Object.keys(s.detailErrors).length) { render(); return; }
    const uris = [...new Set(s.detailRedirects.map((v) => v.trim()).filter(Boolean))];
    s.savingRedirects = true; render();
    try {
      const res = await api(`/oauth/clients/${encodeURIComponent(id)}/redirect-uris`, { method: 'PUT', body: { redirectUris: uris } });
      s.clients = s.clients.map((c) => (c.id === id ? res.client : c));
      s.detailRedirects = [...res.client.redirectUris];
      toast('Redirect addresses saved.');
    } catch (err) {
      reportHandledException(err, 'updateOAuthRedirects');
      toast(friendlyError(err, 'Could not save those addresses.'), true);
    } finally { s.savingRedirects = false; if (isCurrent()) render(); }
  }

  async function copyValue(id, value, label) {
    const input = document.getElementById(id);
    try { await navigator.clipboard.writeText(value); toast(`${label} copied.`); } catch { if (input) input.select(); toast('Press Ctrl+C to copy the selected text.'); }
  }
  const onKeydown = (e) => {
    if (!isCurrent()) { document.removeEventListener('keydown', onKeydown); return; }
    if (e.key !== 'Escape') return;
    if (s.confirm && !s.isBusy) { s.confirm = null; render(); return; }
    if (s.revealed) { s.revealed = null; render(); return; }
    if (s.detailFor && !s.savingRedirects) { s.detailFor = null; render(); }
  };
  document.addEventListener('keydown', onKeydown);

  const scopeChips = (scopes) => scopes.map((x) => `<span class="meta-chip">${esc(SCOPE_LABELS[x] || x)}</span>`).join('');

  const clientHtml = (c) => `
    <div class="state-card key-card">
      <div class="biz-icon neutral">${icon('category_outlined')}</div>
      <div class="biz-body">
        <div class="biz-title-row"><div class="biz-title">${esc(c.name)}</div>${infoIcon(`Client ID ${c.id} · Created ${when(c.createdAt)} · ${c.confidential ? 'Has a client secret' : 'Public app (PKCE only)'}`)}</div>
        <div class="biz-chips">${scopeChips(c.scopes)}</div>
      </div>
      <div class="key-actions">
        <button type="button" class="btn btn-sm" data-details="${esc(c.id)}" aria-label="Show details for ${esc(c.name)}">Details</button>
        ${c.confidential ? `<button type="button" class="btn btn-sm" data-rotate="${esc(c.id)}" aria-label="Rotate the client secret for ${esc(c.name)}">Rotate</button>` : ''}
        <button type="button" class="btn btn-sm" data-remove-client="${esc(c.id)}" aria-label="Remove app ${esc(c.name)}">Remove</button>
      </div>
    </div>`;
  const authHtml = (a) => `
    <div class="state-card key-card">
      <div class="biz-icon neutral">${icon('check_circle_outline')}</div>
      <div class="biz-body">
        <div class="biz-title-row"><div class="biz-title">${esc(a.name)}</div>${infoIcon(`Allowed ${when(a.authorizedAt)} · ${a.lastUsedAt ? `Last used ${when(a.lastUsedAt)}` : 'Never used'}`)}</div>
        <div class="biz-chips">${scopeChips(a.scopes)}</div>
      </div>
      <div class="key-actions">
        <button type="button" class="btn btn-sm" data-revoke-access="${esc(a.clientId)}" aria-label="Take away access from ${esc(a.name)}">Take away access</button>
      </div>
    </div>`;

  /** A labelled value with a Copy button — the same row the API keys page uses for a new key. */
  const copyRow = (id, label, value) => `
    <span class="reveal-label">${esc(label)}</span>
    <div class="reveal-key"><input id="${id}" readonly value="${esc(value)}" aria-label="${esc(label)}" /><button type="button" class="btn btn-primary" data-copy="${id}" data-copy-label="${esc(label)}">${icon('content_copy')} Copy</button></div>`;

  function revealModalHtml() {
    const r = s.revealed;
    const title = r.rotated ? 'Copy your new client secret' : r.secret ? 'Copy your app credentials' : 'Your app is registered';
    const text = r.rotated
      ? 'This is the only time the new client secret is shown. The old secret has stopped working, so update your server now.'
      : r.secret ? 'This is the only time the client secret is shown. Store it somewhere safe — if you lose it, rotate it to get a new one.'
        : 'This is a public app: it has no client secret and must use PKCE. The client ID is not secret and stays visible under Details.';
    return `
      <div class="modal-backdrop" id="app-reveal-backdrop">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="app-reveal-title">
          <h2 id="app-reveal-title">${title}</h2>
          <p class="modal-text">${esc(text)}</p>
          ${r.rotated ? '' : copyRow('app-id', 'Client ID', r.client.id)}
          ${r.secret ? copyRow('app-secret', 'Client secret', r.secret) : ''}
          <div class="modal-actions">
            <button type="button" class="btn" id="dismiss">I've saved it</button>
          </div>
        </div>
      </div>`;
  }

  function detailModalHtml(c) {
    return `
      <div class="modal-backdrop" id="app-detail-backdrop">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="app-detail-title">
          <h2 id="app-detail-title">${esc(c.name)}</h2>
          <p class="modal-text">Created ${esc(when(c.createdAt))} · ${c.confidential ? 'Has a client secret' : 'Public app (PKCE only)'}</p>
          ${copyRow('detail-client-id', 'Client ID', c.id)}
          <div class="field-header field-header-row"><label>Redirect addresses</label>${infoIcon(REDIRECT_HELP, true)}</div>
          ${redirectListHtml(s.detailRedirects, 'detail', s.detailErrors)}
          <div class="field-header"><label>What the app may read</label></div>
          <div class="biz-chips">${scopeChips(c.scopes)}</div>
          <div class="modal-actions">
            <button type="button" class="btn" id="close-detail-btn" ${s.savingRedirects ? 'disabled' : ''}>Close</button>
            <button type="button" class="btn btn-primary" id="save-redirects-btn" ${s.savingRedirects ? 'disabled' : ''}>${s.savingRedirects ? spinnerBtn(true, '') : 'Save addresses'}</button>
          </div>
        </div>
      </div>`;
  }

  function confirmModalHtml(c) {
    const [title, text, action, style] = {
      client: ['Remove app', `Remove "${esc(c.name)}"? People can no longer sign in with it, and every token it holds stops working immediately. This cannot be undone.`, 'Remove', 'btn-danger'],
      access: ['Take away access', `Take away "${esc(c.name)}"'s access to your account? It stops working immediately.`, 'Take away', 'btn-danger'],
      rotate: ['Rotate secret', `Rotate the client secret for "${esc(c.name)}"? The current secret stops working immediately and a new one is shown once. Your server will need the new one.`, 'Rotate', 'btn-primary'],
    }[c.kind];
    return `
      <div class="modal-backdrop" id="app-backdrop">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="app-modal-title">
          <h2 id="app-modal-title">${title}</h2>
          <p class="modal-text">${text}</p>
          <div class="modal-actions">
            <button type="button" class="btn" id="app-cancel" ${s.isBusy ? 'disabled' : ''}>Cancel</button>
            <button type="button" class="btn ${style}" id="app-confirm" ${s.isBusy ? 'disabled' : ''}>${s.isBusy ? spinnerBtn(true, '') : action}</button>
          </div>
        </div>
      </div>`;
  }

  function scopeListHtml() {
    return SCOPE_GROUPS.map((g) => `
      <div class="scope-group-title">${esc(g.title)}</div>
      <div class="library-list">${g.scopes.map(([id, name, desc]) => `
        <label class="library-row"><input type="checkbox" name="scope" value="${esc(id)}" ${s.chosen.has(id) ? 'checked' : ''} /><span class="library-body"><span class="name">${esc(name)}</span><span class="biz-sub">${esc(desc)}</span></span></label>`).join('')}
      </div>`).join('');
  }

  function render() {
    let body;
    if (s.isLoading) body = `<div class="empty-state">${spinnerBtn(true, '', { dark: true })}</div>`;
    else if (s.loadError) body = `<div class="empty-state">${icon('error_outline')}<div style="margin-top:var(--sp-md);">Apps could not load</div><div class="hint">${esc(s.loadError)}</div><button type="button" class="btn" id="retry-btn" style="margin-top:var(--sp-lg);">${icon('refresh')} Try again</button></div>`;
    else {
      const animate = s.formError !== s._lastFormError; s._lastFormError = s.formError;
      const errText = (name) => (s.fieldErrors[name] ? `<div class="error-text">${esc(s.fieldErrors[name])}</div>` : '');
      body = `
        <div class="developer-split">
          <div class="card">
            <div class="biz-title-row section-title-row"><h2 class="biz-section-title">Register an app</h2>${infoIcon('Apps can only read; they can never change anything. Apps must use PKCE to be compatible with Desk OAuth.', true)}</div>
            <form id="app-form" novalidate>
              <div class="field-float has-icon"><span class="field-icon">${icon('category_outlined')}</span><label>App name</label><input name="name" placeholder=" " maxlength="64" value="${esc(s.name)}" autocomplete="off" class="${s.fieldErrors.name ? 'invalid' : ''}" /></div>
              ${errText('name')}
              <div class="field-header field-header-row"><label>Redirect addresses</label>${infoIcon(REDIRECT_HELP, true)}</div>
              ${redirectListHtml(s.redirects, 'form', s.redirectErrors)}
              <label class="library-row" id="confidential-row"><input type="checkbox" name="confidential" ${s.confidential ? 'checked' : ''} /><span class="library-body"><span class="name">The app has a server that can keep a secret</span><span class="biz-sub">Untick for a mobile or single-page app: it then gets no secret and relies on PKCE alone.</span></span></label>
              <div class="field-header"><label>What the app may read</label></div>
              ${scopeListHtml()}
              ${errText('scopes')}
              ${s.formError ? statusMsg('error', s.formError, animate) : ''}
              <div class="wizard-actions">
                <div></div>
                <div><button type="submit" class="btn btn-primary" ${s.isCreating ? 'disabled' : ''}>${s.isCreating ? spinnerBtn(true, '') : icon('category_outlined')}${s.isCreating ? '' : ' Register app'}</button></div>
              </div>
            </form>
          </div>
          <div>
            <h2 class="biz-section-title">Your apps</h2>
            ${s.clients.length ? s.clients.map(clientHtml).join('') : `<div class="state-card"><div class="biz-icon neutral">${icon('category_outlined')}</div><div class="biz-body"><div class="biz-title">No apps yet</div><div class="biz-sub">Register one to get started.</div></div></div>`}
            ${s.authorizations.length ? `
              <h2 class="biz-section-title" style="margin-top:var(--sp-xl);">Apps you have let into your account</h2>
              ${s.authorizations.map(authHtml).join('')}` : ''}
          </div>
        </div>`;
    }
    const detail = s.detailFor ? findClient(s.detailFor) : null;
    app.innerHTML = `
      <div class="page">
        <div class="page-head-row"><div class="head-text"><h1>API Library</h1><p>Sign in with Desk for your own apps, and control which apps can see your account.</p></div></div>
        ${tabsHtml('/developer/apps')}
        ${body}
      </div>
      ${detail ? detailModalHtml(detail) : ''}
      ${s.revealed ? revealModalHtml() : ''}
      ${s.confirm ? confirmModalHtml(s.confirm) : ''}`;
    wire();
  }

  function wire() {
    const $ = (id) => document.getElementById(id);
    const onBackdrop = (id, close) => { const el = $(id); if (el) el.addEventListener('click', (e) => { if (e.target === el) close(); }); };
    app.querySelectorAll('[data-nav]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); navigate(a.dataset.nav); }));
    const retry = $('retry-btn'); if (retry) retry.addEventListener('click', load);

    // Redirect-address fields, in the form ('form') and in the Details pop-up ('detail').
    const listOf = (which) => (which === 'form' ? s.redirects : s.detailRedirects);
    app.querySelectorAll('[data-redirect]').forEach((input) => input.addEventListener('input', () => { listOf(input.dataset.redirect)[Number(input.dataset.index)] = input.value; }));
    app.querySelectorAll('[data-add-redirect]').forEach((b) => b.addEventListener('click', () => {
      const which = b.dataset.addRedirect;
      listOf(which).push('');
      render();
      const fields = app.querySelectorAll(`[data-redirect="${which}"]`);
      if (fields.length) fields[fields.length - 1].focus();
    }));
    app.querySelectorAll('[data-remove-redirect]').forEach((b) => b.addEventListener('click', () => {
      const which = b.dataset.removeRedirect;
      listOf(which).splice(Number(b.dataset.index), 1);
      if (which === 'form') s.redirectErrors = {}; else s.detailErrors = {};
      render();
    }));

    const form = $('app-form');
    if (form) {
      form.addEventListener('submit', createClient); submitOnEnter(form);
      form.querySelector('input[name="name"]').addEventListener('input', (e) => { s.name = e.target.value; });
      form.querySelectorAll('input[name="scope"]').forEach((box) => box.addEventListener('change', () => { if (box.checked) s.chosen.add(box.value); else s.chosen.delete(box.value); }));
      form.querySelector('input[name="confidential"]').addEventListener('change', (e) => { s.confidential = e.target.checked; });
    }

    app.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => { const input = $(b.dataset.copy); if (input) copyValue(b.dataset.copy, input.value, b.dataset.copyLabel); }));
    const dismissReveal = () => { s.revealed = null; render(); };
    const dismiss = $('dismiss'); if (dismiss) dismiss.addEventListener('click', dismissReveal);
    onBackdrop('app-reveal-backdrop', dismissReveal);

    app.querySelectorAll('[data-details]').forEach((b) => b.addEventListener('click', () => openDetails(b.dataset.details)));
    const closeDetail = () => { if (!s.savingRedirects) { s.detailFor = null; render(); } };
    const closeBtn = $('close-detail-btn'); if (closeBtn) { closeBtn.addEventListener('click', closeDetail); if (!s.confirm && !s.revealed && !document.activeElement?.dataset?.redirect) closeBtn.focus(); }
    const saveBtn = $('save-redirects-btn'); if (saveBtn) saveBtn.addEventListener('click', saveRedirects);
    onBackdrop('app-detail-backdrop', closeDetail);

    const confirmFor = (kind, id) => {
      const c = kind === 'access' ? s.authorizations.find((a) => a.clientId === id) : findClient(id);
      if (c) { s.confirm = { kind, id, name: c.name }; render(); }
    };
    app.querySelectorAll('[data-remove-client]').forEach((b) => b.addEventListener('click', () => confirmFor('client', b.dataset.removeClient)));
    app.querySelectorAll('[data-revoke-access]').forEach((b) => b.addEventListener('click', () => confirmFor('access', b.dataset.revokeAccess)));
    app.querySelectorAll('[data-rotate]').forEach((b) => b.addEventListener('click', () => confirmFor('rotate', b.dataset.rotate)));
    const cancel = $('app-cancel'); if (cancel) { cancel.addEventListener('click', () => { s.confirm = null; render(); }); cancel.focus(); }
    const ok = $('app-confirm');
    if (ok) ok.addEventListener('click', () => {
      const c = s.confirm;
      if (c.kind === 'client') removeClient(c.id); else if (c.kind === 'access') revokeAccess(c.id); else rotateSecret(c.id);
    });
    onBackdrop('app-backdrop', () => { if (!s.isBusy) { s.confirm = null; render(); } });
  }

  await load();
});
