// API Library — create developer API keys and choose which APIs each one can
// call. Backed by desk-api's /gateway/* routes (desk-api src/routes/gateway.ts).
// Key management only works from a signed-in session; the plaintext key is
// shown exactly once, right after creation, and never again.
// Options when creating: live or sandbox, which parts of the Desk API a key may read, and an expiry. For a key that exists: its usage
// and limits, switching it off and on, adding or removing an API, and revoking it.
import {
  registerRoute, api, esc, icon, spinnerBtn, statusMsg, friendlyError, toast,
  reportHandledException, currentEpoch, submitOnEnter, navigate,
} from '../app.js';
import { tabsHtml } from '../tabs.js';

const MAX_LABEL_LENGTH = 64;

/** The parts of the Desk API a key may be limited to (the server's DESK_SCOPES), in plain words. */
const KEY_SCOPES = [
  ['profile', 'Your name and email address'],
  ['drafts', 'Unfinished business setups'],
  ['businesses', 'Businesses and their members'],
];
/** Expiry choices: days (0 = never expires). The server accepts 1 to 730. */
const EXPIRY_CHOICES = [[0, 'Never'], [30, 'In 30 days'], [90, 'In 90 days'], [365, 'In a year'], [730, 'In two years']];

// Sent with a create so a retry of the same request can never make a second key.
function newIdempotencyKey() {
  const c = globalThis.crypto;
  return c && typeof c.randomUUID === 'function' ? c.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const SERVICE_ICONS = {
  desk_api: 'business_outlined',
  registry_api: 'search',
  market_validation_api: 'table_chart_outlined',
};

function formatDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

registerRoute('/developer', async (app) => {
  const myEpoch = currentEpoch();
  const s = {
    isLoading: true,
    loadError: null,
    services: [],
    keys: [],
    label: '',
    selected: new Set(),
    isCreating: false,
    createAttempt: null,
    fieldErrors: {},
    formError: null,
    revealed: null,
    animateReveal: false,
    sandbox: false,
    scopes: new Set(KEY_SCOPES.map(([id]) => id)),
    expiresInDays: 0,
    expanded: new Set(), // key ids whose details are open
    details: {}, // key id -> { loading, error, usage }
    busyKeys: new Set(), // key ids with a change in flight
    confirmRevoke: null,
    isRevoking: false,
    _lastFormError: null,
  };

  const serviceName = (id) => (s.services.find((x) => x.service === id) || {}).name || id;

  function isCurrent() {
    return currentEpoch() === myEpoch;
  }

  async function load() {
    s.isLoading = true;
    s.loadError = null;
    render();
    try {
      const [catalog, list] = await Promise.all([api('/gateway/services'), api('/gateway/api-keys')]);
      s.services = catalog.services || [];
      s.keys = list.apiKeys || [];
    } catch (err) {
      reportHandledException(err, 'loadApiLibrary');
      s.loadError = friendlyError(err, 'We could not load your API keys.');
    } finally {
      if (isCurrent()) {
        s.isLoading = false;
        render();
      }
    }
  }

  function validate() {
    const errors = {};
    if (!s.label.trim()) errors.label = 'Give this key a name.';
    if (s.selected.size === 0) errors.services = 'Choose at least one API.';
    if (s.selected.has('desk_api') && !s.sandbox && KEY_SCOPES.every(([id]) => !s.scopes.has(id))) errors.scopes = 'Choose at least one thing the key may read.';
    return errors;
  }

  async function createKey(e) {
    e.preventDefault();
    s.fieldErrors = validate();
    if (Object.keys(s.fieldErrors).length > 0) { render(); return; }

    s.isCreating = true;
    s.formError = null;
    render();
    try {
      const services = s.services.map((x) => x.service).filter((id) => s.selected.has(id));
      const body = { label: s.label.trim(), services };
      if (s.sandbox) body.sandbox = true;
      if (services.includes('desk_api')) {
        const chosen = KEY_SCOPES.map(([id]) => id).filter((id) => s.scopes.has(id));
        if (chosen.length < KEY_SCOPES.length) body.deskScopes = chosen; // all of them is the default: leave it out
      }
      if (s.expiresInDays > 0) body.expiresInDays = s.expiresInDays;
      // The same form submitted again (after a dropped connection, say) reuses its
      // Idempotency-Key; a changed form gets a new one.
      const signature = JSON.stringify(body);
      if (!s.createAttempt || s.createAttempt.signature !== signature) {
        s.createAttempt = { signature, key: newIdempotencyKey() };
      }
      const res = await api('/gateway/api-keys', { method: 'POST', body, headers: { 'idempotency-key': s.createAttempt.key } });
      s.createAttempt = null;
      const { key, ...summary } = res.apiKey;
      s.keys = [summary, ...s.keys];
      s.revealed = { ...summary, key };
      s.animateReveal = true;
      s.label = '';
      s.selected = new Set();
      s.sandbox = false;
      s.expiresInDays = 0;
      s.scopes = new Set(KEY_SCOPES.map(([id]) => id));
    } catch (err) {
      reportHandledException(err, 'createApiKey');
      s.formError = friendlyError(err, 'We could not create that key. Please try again.');
      // 409 on a retry means the first attempt did create the key (its answer was lost).
      // Show the list as it really is so the orphan can be revoked.
      if (err && err.statusCode === 409 && s.createAttempt) {
        s.createAttempt = null;
        try {
          const list = await api('/gateway/api-keys');
          s.keys = list.apiKeys || [];
        } catch {
          /* the message above still tells the user what to do */
        }
      }
    } finally {
      s.isCreating = false;
      if (isCurrent()) render();
    }
  }

  async function revokeKey() {
    const target = s.confirmRevoke;
    if (!target) return;
    s.isRevoking = true;
    render();
    try {
      await api(`/gateway/api-keys/${encodeURIComponent(target.id)}`, { method: 'DELETE' });
      s.keys = s.keys.filter((k) => k.id !== target.id);
      if (s.revealed && s.revealed.id === target.id) s.revealed = null;
      toast('Key revoked.');
    } catch (err) {
      reportHandledException(err, 'revokeApiKey');
      toast(friendlyError(err, 'Could not revoke that key. Please try again.'), true);
    } finally {
      s.confirmRevoke = null;
      s.isRevoking = false;
      if (isCurrent()) render();
    }
  }

  // ── a key that exists: usage, switch off/on, add or remove an API ─────────────────────────────────────────────
  const replaceKey = (updated) => { s.keys = s.keys.map((k) => (k.id === updated.id ? { ...k, ...updated } : k)); };

  async function loadUsage(id) {
    s.details[id] = { loading: true, error: null, usage: null };
    render();
    try {
      s.details[id] = { loading: false, error: null, usage: await api(`/gateway/api-keys/${encodeURIComponent(id)}/usage?days=30`) };
    } catch (err) {
      reportHandledException(err, 'loadKeyUsage');
      s.details[id] = { loading: false, error: friendlyError(err, 'We could not load the usage.'), usage: null };
    }
    if (isCurrent()) render();
  }

  function toggleDetails(id) {
    if (s.expanded.has(id)) { s.expanded.delete(id); render(); return; }
    s.expanded.add(id);
    if (!s.details[id] || s.details[id].error) loadUsage(id); else render();
  }

  async function changeKey(id, what, fn, failText) {
    if (s.busyKeys.has(id)) return;
    s.busyKeys.add(id); render();
    try { await fn(); } catch (err) { reportHandledException(err, what); toast(friendlyError(err, failText), true); }
    finally { s.busyKeys.delete(id); if (isCurrent()) render(); }
  }

  const setSuspended = (k, off) => changeKey(k.id, off ? 'suspendKey' : 'resumeKey', async () => {
    await api(`/gateway/api-keys/${encodeURIComponent(k.id)}/${off ? 'suspend' : 'resume'}`, { method: 'POST', body: {} });
    replaceKey({ id: k.id, suspended: off });
    toast(off ? 'Key switched off. It is refused until you switch it back on.' : 'Key switched on.');
  }, off ? 'Could not switch that key off.' : 'Could not switch that key on.');

  const addService = (k, service) => changeKey(k.id, 'addKeyService', async () => {
    const res = await api(`/gateway/api-keys/${encodeURIComponent(k.id)}/services`, { method: 'POST', body: { service } });
    replaceKey(res.apiKey);
    toast(`${serviceName(service)} added to the key.`);
  }, 'Could not add that API.');

  const removeService = (k, service) => changeKey(k.id, 'removeKeyService', async () => {
    const res = await api(`/gateway/api-keys/${encodeURIComponent(k.id)}/services/${encodeURIComponent(service)}`, { method: 'DELETE' });
    if (res && res.apiKey) replaceKey(res.apiKey); else replaceKey({ id: k.id, services: (k.services || []).filter((x) => x !== service) });
    toast(`${serviceName(service)} removed from the key.`);
  }, 'Could not remove that API.');

  async function copyRevealedKey() {
    const input = document.getElementById('reveal-input');
    if (!input) return;
    try {
      await navigator.clipboard.writeText(s.revealed.key);
      toast('Key copied.');
    } catch {
      // Clipboard blocked (permissions, insecure context): select it so
      // the user can copy it by hand instead.
      input.select();
      toast('Press Ctrl+C to copy the selected key.');
    }
  }

  const onKeydown = (e) => {
    if (!isCurrent()) { document.removeEventListener('keydown', onKeydown); return; }
    if (e.key === 'Escape' && s.confirmRevoke && !s.isRevoking) { s.confirmRevoke = null; render(); }
  };
  document.addEventListener('keydown', onKeydown);

  function serviceRowHtml(svc) {
    const disabled = !svc.available || (s.sandbox && svc.service === 'desk_api');
    return `
      <label class="library-row">
        <input type="checkbox" name="service" value="${esc(svc.service)}" aria-labelledby="svc-name-${esc(svc.service)}" aria-describedby="svc-desc-${esc(svc.service)}" ${s.selected.has(svc.service) ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
        <span class="library-icon">${icon(SERVICE_ICONS[svc.service] || 'category_outlined')}</span>
        <span class="library-body">
          <span class="name" id="svc-name-${esc(svc.service)}">${esc(svc.name)}</span>
          <span class="biz-sub" id="svc-desc-${esc(svc.service)}">${esc(svc.description)}</span>
          <span class="biz-sub">${!svc.available ? esc(svc.unavailableReason || 'Not available right now.') : disabled ? 'Not available on a sandbox key.' : `Endpoints under <b>${esc(svc.basePath)}</b>`}</span>
        </span>
      </label>
    `;
  }

  function revealHtml() {
    const r = s.revealed;
    return `
      <div class="card fold-in${s.animateReveal ? ' fold-in-animate' : ''}" id="reveal-card" style="max-height:1600px;margin-bottom:var(--sp-lg);">
        <h2 class="biz-section-title">Copy your new key</h2>
        <p class="biz-sub" style="margin-bottom:var(--sp-md);">This is the only time the full key is shown. Store it somewhere safe — if you lose it, revoke it and create a new one.</p>
        <div class="reveal-key">
          <input id="reveal-input" readonly value="${esc(r.key)}" aria-label="Your new API key" />
          <button type="button" class="btn btn-primary" id="copy-key-btn">${icon('content_copy')} Copy</button>
        </div>
        <button type="button" class="btn" id="dismiss-reveal-btn" style="margin-top:var(--sp-lg);">I've saved my key</button>
      </div>
    `;
  }

  function expiryText(k) {
    if (!k.expiresAt) return '';
    const d = new Date(k.expiresAt);
    if (Number.isNaN(d.getTime())) return '';
    return d.getTime() < Date.now() ? `Expired ${formatDate(k.expiresAt)}` : `Expires ${formatDate(k.expiresAt)}`;
  }

  function usageHtml(k) {
    const d = s.details[k.id];
    if (!d || d.loading) return `<div class="biz-sub">Loading usage…</div>`;
    if (d.error) return `<div class="biz-sub">${esc(d.error)} <button type="button" class="btn-link" data-retry-usage="${esc(k.id)}">Try again</button></div>`;
    const u = d.usage;
    const max = Math.max(1, ...u.daily.map((x) => x.calls));
    return `
      <div class="biz-sub"><b>${Number(u.totals.calls).toLocaleString('en-US')}</b> ${u.totals.calls === 1 ? 'call' : 'calls'} and <b>${Number(u.totals.errors).toLocaleString('en-US')}</b> ${u.totals.errors === 1 ? 'error' : 'errors'} in the last ${esc(u.days)} days${u.sharedWithTeam ? ' (shared with the team)' : ''}.</div>
      ${u.daily.length ? `<div class="key-usage-days" aria-label="Calls per day">${u.daily.slice(0, 14).map((x) => `<div class="usage-row"><span>${esc(x.day)}</span><span>${Number(x.calls).toLocaleString('en-US')}${x.errors ? ` · ${Number(x.errors).toLocaleString('en-US')} ${x.errors === 1 ? 'error' : 'errors'}` : ''}</span></div><div class="usage-bar" aria-hidden="true"><div class="usage-fill" style="width:${Math.max(2, Math.round((x.calls / max) * 100))}%"></div></div>`).join('')}</div>` : `<div class="biz-sub">No calls yet.</div>`}
      <div class="biz-sub" style="margin-top:var(--sp-sm);">${(u.limits || []).filter((l) => (k.services || []).includes(l.service)).map((l) => esc(l.note)).join('<br>')}</div>
      ${u.idleExpiryDays ? `<div class="biz-sub">A key that is not used for ${esc(u.idleExpiryDays)} days is revoked automatically.</div>` : ''}`;
  }

  function apisHtml(k) {
    const have = k.services || [];
    const busy = s.busyKeys.has(k.id);
    const canAdd = s.services.filter((x) => x.available && !have.includes(x.service) && !(k.sandbox && x.service === 'desk_api'));
    return `
      <div class="field-header"><label>APIs on this key</label></div>
      <div class="biz-chips">${have.map((id) => `<span class="meta-chip">${esc(serviceName(id))}${have.length > 1 ? ` <button type="button" class="chip-x" data-remove-api="${esc(k.id)}::${esc(id)}" aria-label="Remove ${esc(serviceName(id))} from ${esc(k.label)}" ${busy ? 'disabled' : ''}>✕</button>` : ''}</span>`).join('')}</div>
      ${canAdd.length ? `<div class="biz-sub" style="margin-top:var(--sp-sm);">Add: ${canAdd.map((x) => `<button type="button" class="btn btn-sm" data-add-api="${esc(k.id)}::${esc(x.service)}" ${busy ? 'disabled' : ''}>${esc(x.name)}</button>`).join(' ')}</div>` : ''}
      ${have.length === 1 ? `<div class="biz-sub">A key keeps at least one API.</div>` : ''}`;
  }

  function keyCardHtml(k) {
    const used = k.lastUsedAt ? `Last used ${formatDate(k.lastUsedAt)}` : 'Never used';
    const open = s.expanded.has(k.id);
    const busy = s.busyKeys.has(k.id);
    const scopes = (k.services || []).includes('desk_api') && Array.isArray(k.deskScopes) && k.deskScopes.length < KEY_SCOPES.length
      ? `<span class="meta-chip" title="What this key may read from the Desk API">Reads: ${esc(k.deskScopes.map((id) => (KEY_SCOPES.find(([x]) => x === id) || [id, id])[1]).join(', '))}</span>` : '';
    const exp = expiryText(k);
    return `
      <div class="key-block">
        <div class="state-card key-card">
          <div class="biz-icon neutral">${icon('key')}</div>
          <div class="biz-body">
            <div class="biz-title">${esc(k.label)}</div>
            <div class="biz-sub">${esc(k.keyPrefix)}… · Created ${esc(formatDate(k.createdAt))} · ${esc(used)}${exp ? ` · ${esc(exp)}` : ''}</div>
            <div class="biz-chips">
              ${k.suspended ? '<span class="meta-chip warn">Switched off</span>' : ''}
              ${k.sandbox ? '<span class="meta-chip" title="Fixed sample answers; nothing real is called, counted or billed">Sandbox</span>' : ''}
              ${(k.services || []).map((id) => `<span class="meta-chip">${esc(serviceName(id))}</span>`).join('')}
              ${scopes}
            </div>
          </div>
          <div class="key-actions">
            <button type="button" class="btn btn-sm" data-details="${esc(k.id)}" aria-expanded="${open}" aria-label="${open ? 'Hide' : 'Show'} usage and settings for ${esc(k.label)}">${open ? 'Hide details' : 'Details'}</button>
            <button type="button" class="btn btn-sm" data-suspend="${esc(k.id)}" data-off="${k.suspended ? '0' : '1'}" ${busy ? 'disabled' : ''} aria-label="${k.suspended ? 'Switch on' : 'Switch off'} key ${esc(k.label)}">${k.suspended ? 'Switch on' : 'Switch off'}</button>
            <button type="button" class="btn btn-sm" data-revoke="${esc(k.id)}" aria-label="Revoke key ${esc(k.label)}">Revoke</button>
          </div>
        </div>
        ${open ? `<div class="card key-detail">${usageHtml(k)}<div style="margin-top:var(--sp-lg);">${apisHtml(k)}</div></div>` : ''}
      </div>
    `;
  }

  function render() {
    let body;
    if (s.isLoading) {
      body = `<div class="empty-state">${spinnerBtn(true, '', { dark: true })}</div>`;
    } else if (s.loadError) {
      body = `<div class="empty-state">${icon('error_outline')}<div style="margin-top:var(--sp-md);">API Library could not load</div><div class="hint">${esc(s.loadError)}</div><button type="button" class="btn" id="retry-load-btn" style="margin-top:var(--sp-lg);">${icon('refresh')} Try again</button></div>`;
    } else {
      const animateError = s.formError !== s._lastFormError;
      s._lastFormError = s.formError;
      const errText = (name) => (s.fieldErrors[name] ? `<div class="error-text">${esc(s.fieldErrors[name])}</div>` : '');
      body = `
        ${s.revealed ? revealHtml() : ''}
        <div class="card" style="margin-bottom:var(--sp-lg);">
          <h2 class="biz-section-title">Create a key</h2>
          <p class="biz-sub" style="margin-bottom:var(--sp-lg);">Choose which APIs the key can call. You can add or remove APIs later from the key's details.</p>
          <form id="create-form" novalidate>
            <div class="field-float has-icon">
              <span class="field-icon">${icon('key')}</span>
              <label>Key name</label>
              <input name="label" placeholder=" " maxlength="${MAX_LABEL_LENGTH}" value="${esc(s.label)}" autocomplete="off" class="${s.fieldErrors.label ? 'invalid' : ''}" />
            </div>
            ${errText('label')}
            <div class="field-header"><label>APIs this key can call</label></div>
            <div class="library-list" id="service-list">${s.services.map(serviceRowHtml).join('')}</div>
            ${errText('services')}
            ${s.selected.has('desk_api') && !s.sandbox ? `
              <div class="field-header"><label>What the key may read from the Desk API</label></div>
              <div class="library-list" id="scope-list">${KEY_SCOPES.map(([id, label]) => `<label class="library-row"><input type="checkbox" name="scope" value="${id}" ${s.scopes.has(id) ? 'checked' : ''} /><span class="library-body"><span class="name">${esc(label)}</span></span></label>`).join('')}</div>
              ${errText('scopes')}` : ''}
            <div class="field-header"><label for="key-expiry">Expires</label></div>
            <select id="key-expiry" class="team-select" style="margin-bottom:var(--sp-md);">${EXPIRY_CHOICES.map(([d, label]) => `<option value="${d}" ${s.expiresInDays === d ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>
            <label class="library-row" id="sandbox-row"><input type="checkbox" name="sandbox" ${s.sandbox ? 'checked' : ''} /><span class="library-body"><span class="name">Sandbox key</span><span class="biz-sub">For trying things out: fixed sample answers, nothing real is called or counted against your plan. Registry and Market APIs only.</span></span></label>
            ${s.formError ? statusMsg('error', s.formError, animateError) : ''}
            <button type="submit" class="btn btn-primary" style="margin-top:var(--sp-lg);" ${s.isCreating ? 'disabled' : ''}>
              ${s.isCreating ? spinnerBtn(true, '') : icon('key')}
              ${s.isCreating ? '' : 'Create key'}
            </button>
          </form>
        </div>
        <h2 class="biz-section-title" style="margin-top:var(--sp-xl);">Your keys</h2>
        ${s.keys.length
          ? s.keys.map(keyCardHtml).join('')
          : `<div class="state-card"><div class="biz-icon neutral">${icon('key')}</div><div class="biz-body"><div class="biz-title">No API keys yet</div><div class="biz-sub">Create your first key above to start calling the APIs.</div></div></div>`}
      `;
    }

    app.innerHTML = `
      <div class="page">
        <div class="page-head-row">
          <div class="head-text">
            <h1>API Library</h1>
            <p>Create keys and choose which Desk APIs each one can call.</p>
          </div>
        </div>
        ${tabsHtml('/developer')}
        ${body}
      </div>
      ${s.confirmRevoke ? `
        <div class="modal-backdrop" id="revoke-modal-backdrop">
          <div class="modal" role="dialog" aria-modal="true" aria-labelledby="revoke-title">
            <h2 id="revoke-title">Revoke key</h2>
            <p>Revoke "${esc(s.confirmRevoke.label)}"? Anything using it will stop working immediately. This cannot be undone.</p>
            <div style="display:flex;justify-content:flex-end;gap:var(--sp-sm);margin-top:var(--sp-xl);">
              <button type="button" class="btn" id="cancel-revoke-btn" ${s.isRevoking ? 'disabled' : ''}>Cancel</button>
              <button type="button" class="btn btn-danger" id="confirm-revoke-btn" ${s.isRevoking ? 'disabled' : ''}>${s.isRevoking ? spinnerBtn(true, '') : 'Revoke'}</button>
            </div>
          </div>
        </div>
      ` : ''}
    `;
    s.animateReveal = false;

    app.querySelectorAll('[data-nav]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); navigate(a.dataset.nav); }));

    const retry = document.getElementById('retry-load-btn');
    if (retry) retry.addEventListener('click', load);

    const form = document.getElementById('create-form');
    if (form) {
      form.addEventListener('submit', createKey);
      submitOnEnter(form);
      form.querySelector('input[name="label"]').addEventListener('input', (e) => { s.label = e.target.value; });
      form.querySelectorAll('input[name="service"]').forEach((box) => {
        box.addEventListener('change', () => {
          if (box.checked) s.selected.add(box.value); else s.selected.delete(box.value);
          if (box.value === 'desk_api') render(); // the "what may it read" choices come and go with the Desk API
        });
      });
      form.querySelectorAll('input[name="scope"]').forEach((box) => box.addEventListener('change', () => { if (box.checked) s.scopes.add(box.value); else s.scopes.delete(box.value); }));
      const expiry = document.getElementById('key-expiry'); if (expiry) expiry.addEventListener('change', () => { s.expiresInDays = Number(expiry.value); });
      const sb = form.querySelector('input[name="sandbox"]');
      if (sb) sb.addEventListener('change', () => { s.sandbox = sb.checked; if (s.sandbox) s.selected.delete('desk_api'); render(); }); // a sandbox key has no Desk API
    }

    app.querySelectorAll('[data-details]').forEach((b) => b.addEventListener('click', () => toggleDetails(b.dataset.details)));
    app.querySelectorAll('[data-retry-usage]').forEach((b) => b.addEventListener('click', () => loadUsage(b.dataset.retryUsage)));
    app.querySelectorAll('[data-suspend]').forEach((b) => b.addEventListener('click', () => { const k = s.keys.find((x) => x.id === b.dataset.suspend); if (k) setSuspended(k, b.dataset.off === '1'); }));
    app.querySelectorAll('[data-add-api]').forEach((b) => b.addEventListener('click', () => { const [id, svc] = b.dataset.addApi.split('::'); const k = s.keys.find((x) => x.id === id); if (k) addService(k, svc); }));
    app.querySelectorAll('[data-remove-api]').forEach((b) => b.addEventListener('click', () => { const [id, svc] = b.dataset.removeApi.split('::'); const k = s.keys.find((x) => x.id === id); if (k) removeService(k, svc); }));

    const copy = document.getElementById('copy-key-btn');
    if (copy) copy.addEventListener('click', copyRevealedKey);
    const dismiss = document.getElementById('dismiss-reveal-btn');
    if (dismiss) dismiss.addEventListener('click', () => { s.revealed = null; render(); });

    app.querySelectorAll('[data-revoke]').forEach((btn) => {
      btn.addEventListener('click', () => {
        s.confirmRevoke = s.keys.find((k) => k.id === btn.dataset.revoke) || null;
        render();
      });
    });
    const cancel = document.getElementById('cancel-revoke-btn');
    if (cancel) { cancel.addEventListener('click', () => { s.confirmRevoke = null; render(); }); cancel.focus(); }
    const confirm = document.getElementById('confirm-revoke-btn');
    if (confirm) confirm.addEventListener('click', revokeKey);
    const backdrop = document.getElementById('revoke-modal-backdrop');
    if (backdrop) backdrop.addEventListener('click', (e) => { if (e.target === backdrop && !s.isRevoking) { s.confirmRevoke = null; render(); } });
  }

  await load();
});
