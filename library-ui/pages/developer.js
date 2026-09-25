// API Library — create developer API keys and choose which APIs each one can
// call. Backed by desk-api's /gateway/* routes (desk-api src/routes/gateway.ts).
// Key management only works from a signed-in session; the plaintext key is
// shown exactly once, right after creation (or a rotation), and never again.
// Options when creating: live or sandbox, which APIs a key may call, and an expiry. For a key that exists: its usage
// and limits, switching it off and on, rotating its secret, adding or removing an API, and revoking it.
import {
  registerRoute, api, esc, icon, spinnerBtn, statusMsg, friendlyError, toast,
  reportHandledException, currentEpoch, submitOnEnter, navigate,
} from '../app.js';
import { tabsHtml } from '../tabs.js';

const MAX_LABEL_LENGTH = 64;

/** Plain-word labels for a key's DESK_SCOPES, used only to describe an already-restricted key (see keys.ts):
    a new key always gets full access now — there is nothing left in the Desk API worth gating by scope. */
const DESK_SCOPE_LABELS = { profile: 'Your name and email address', drafts: 'Unfinished business setups', businesses: 'Businesses and their members' };
const DESK_SCOPE_COUNT = Object.keys(DESK_SCOPE_LABELS).length;
/** Expiry choices: days (0 = never expires). The server accepts 1 to 730. */
const EXPIRY_CHOICES = [[0, 'Never'], [30, 'In 30 days'], [90, 'In 90 days'], [365, 'In a year'], [730, 'In two years']];

// Sent with a create (or a rotate) so a retry of the same request can never act twice.
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
    revealed: null, // { ...key summary, key, rotated }
    sandbox: false,
    expiresInDays: 0,
    detailFor: null, // the id of the key whose usage/settings popup is open, or null
    details: {}, // key id -> { loading, error, usage }
    busyKeys: new Set(), // key ids with a change in flight
    confirmRevoke: null,
    isRevoking: false,
    confirmRotate: null,
    isRotating: false,
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
      s.revealed = { ...summary, key, rotated: false };
      s.label = '';
      s.selected = new Set();
      s.sandbox = false;
      s.expiresInDays = 0;
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
      if (s.detailFor === target.id) s.detailFor = null;
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

  // ── a key that exists: usage, switch off/on, rotate, add or remove an API ─────────────────────────────────────
  const replaceKey = (updated) => { s.keys = s.keys.map((k) => (k.id === updated.id ? { ...k, ...updated } : k)); };

  async function rotateKey() {
    const target = s.confirmRotate;
    if (!target) return;
    s.isRotating = true;
    render();
    try {
      const res = await api(`/gateway/api-keys/${encodeURIComponent(target.id)}/rotate`, { method: 'POST', body: {} });
      const { key, ...summary } = res.apiKey;
      replaceKey(summary);
      s.revealed = { ...summary, key, rotated: true };
    } catch (err) {
      reportHandledException(err, 'rotateApiKey');
      toast(friendlyError(err, 'Could not rotate that key. Please try again.'), true);
    } finally {
      s.confirmRotate = null;
      s.isRotating = false;
      if (isCurrent()) render();
    }
  }

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

  function openDetails(id) {
    s.detailFor = id;
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
    if (e.key !== 'Escape') return;
    if (s.confirmRevoke && !s.isRevoking) { s.confirmRevoke = null; render(); return; }
    if (s.confirmRotate && !s.isRotating) { s.confirmRotate = null; render(); return; }
    if (s.detailFor) { s.detailFor = null; render(); return; }
    if (s.revealed) { s.revealed = null; render(); return; }
  };
  document.addEventListener('keydown', onKeydown);

  function serviceRowHtml(svc) {
    const disabled = !svc.available || (s.sandbox && svc.service === 'desk_api');
    const checked = s.selected.has(svc.service);
    const sandboxable = svc.service !== 'desk_api';
    const details = [];
    if (checked && svc.limitNote) details.push(svc.limitNote);
    if (checked && svc.idleExpiryDays) details.push(`A key that is not used for ${svc.idleExpiryDays} days is revoked automatically.`);
    return `
      <div class="library-row">
        <label class="library-row-main" for="svc-${esc(svc.service)}">
          <input type="checkbox" id="svc-${esc(svc.service)}" name="service" value="${esc(svc.service)}" aria-describedby="svc-desc-${esc(svc.service)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
          <span class="library-icon">${icon(SERVICE_ICONS[svc.service] || 'category_outlined')}</span>
          <span class="library-body">
            <span class="library-row-head">
              <span class="name">${esc(svc.name)}</span>
            </span>
            <span class="biz-sub" id="svc-desc-${esc(svc.service)}">${esc(svc.description)}</span>
            ${!svc.available ? `<span class="biz-sub">${esc(svc.unavailableReason || 'Not available right now.')}</span>` : disabled ? `<span class="biz-sub">Not available on a sandbox key.</span>` : ''}
            ${details.length ? `<span class="biz-sub" style="margin-top:var(--sp-2xs);">${details.map(esc).join('<br>')}</span>` : ''}
          </span>
        </label>
        ${sandboxable && checked ? `
          <label class="sandbox-inline" for="sandbox-for-${esc(svc.service)}">
            <input type="checkbox" id="sandbox-for-${esc(svc.service)}" name="sandboxFor" value="${esc(svc.service)}" ${s.sandbox ? 'checked' : ''} />
            Sandbox Key
          </label>` : ''}
      </div>
    `;
  }

  function revealModalHtml() {
    const r = s.revealed;
    return `
      <div class="modal-backdrop" id="reveal-modal-backdrop">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="reveal-title">
          <h2 id="reveal-title">${r.rotated ? 'Copy your new secret' : 'Copy your new key'}</h2>
          <p class="biz-sub" style="margin-bottom:var(--sp-md);">This is the only time the full key is shown. Store it somewhere safe — if you lose it, ${r.rotated ? 'rotate it again' : 'revoke it and create a new one'}.</p>
          <div class="reveal-key">
            <input id="reveal-input" readonly value="${esc(r.key)}" aria-label="Your new API key" />
            <button type="button" class="btn btn-primary" id="copy-key-btn">${icon('content_copy')} Copy</button>
          </div>
          <div style="display:flex;justify-content:flex-end;margin-top:var(--sp-lg);">
            <button type="button" class="btn" id="dismiss-reveal-btn">I've saved my key</button>
          </div>
        </div>
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
    if (!d || d.loading) return `<div class="empty-state">${spinnerBtn(true, '', { dark: true })}</div>`;
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

  function detailModalHtml(k) {
    return `
      <div class="modal-backdrop" id="detail-modal-backdrop">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="detail-title">
          <h2 id="detail-title">${esc(k.label)}</h2>
          ${usageHtml(k)}
          <div style="margin-top:var(--sp-lg);">${apisHtml(k)}</div>
          <div style="display:flex;justify-content:flex-end;margin-top:var(--sp-xl);">
            <button type="button" class="btn" id="close-detail-btn">Close</button>
          </div>
        </div>
      </div>
    `;
  }

  function keyCardHtml(k) {
    const busy = s.busyKeys.has(k.id);
    const scopes = (k.services || []).includes('desk_api') && Array.isArray(k.deskScopes) && k.deskScopes.length < DESK_SCOPE_COUNT
      ? `<span class="meta-chip" title="What this key may read from the Desk API">Reads: ${esc(k.deskScopes.map((id) => DESK_SCOPE_LABELS[id] || id).join(', '))}</span>` : '';
    const exp = expiryText(k);
    const subParts = [`${k.keyPrefix}…`, `Created ${formatDate(k.createdAt)}`];
    if (k.lastUsedAt) subParts.push(`Last used ${formatDate(k.lastUsedAt)}`);
    if (exp) subParts.push(exp);
    return `
      <div class="state-card key-card">
        <div class="biz-icon neutral">${icon('key')}</div>
        <div class="biz-body">
          <div class="biz-title">${esc(k.label)}</div>
          <div class="biz-sub">${subParts.map((p) => esc(p)).join(' · ')}</div>
          <div class="biz-chips">
            ${k.suspended ? '<span class="meta-chip warn">Switched off</span>' : ''}
            ${k.sandbox ? '<span class="meta-chip" title="Fixed sample answers; nothing real is called, counted or billed">Sandbox</span>' : ''}
            ${(k.services || []).map((id) => `<span class="meta-chip">${esc(serviceName(id))}</span>`).join('')}
            ${scopes}
          </div>
        </div>
        <div class="key-actions">
          <button type="button" class="btn btn-sm" data-details="${esc(k.id)}" aria-label="Show usage and settings for ${esc(k.label)}">Details</button>
          <button type="button" class="btn btn-sm" data-suspend="${esc(k.id)}" data-off="${k.suspended ? '0' : '1'}" ${busy ? 'disabled' : ''} aria-label="${k.suspended ? 'Switch on' : 'Switch off'} key ${esc(k.label)}">${k.suspended ? 'Switch on' : 'Switch off'}</button>
          <button type="button" class="btn btn-sm" data-rotate="${esc(k.id)}" ${busy ? 'disabled' : ''} aria-label="Rotate key ${esc(k.label)}">Rotate</button>
          <button type="button" class="btn btn-sm" data-revoke="${esc(k.id)}" aria-label="Revoke key ${esc(k.label)}">Revoke</button>
        </div>
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
        <div class="developer-split">
          <div class="card">
            <h2 class="biz-section-title">Create a key</h2>
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
              <div style="display:flex;align-items:center;gap:var(--sp-sm);margin:var(--sp-lg) 0 var(--sp-md);">
                <label for="key-expiry" style="font-weight:700;">Expires</label>
                <select id="key-expiry" class="team-select" style="width:auto;">${EXPIRY_CHOICES.map(([d, label]) => `<option value="${d}" ${s.expiresInDays === d ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>
              </div>
              ${s.formError ? statusMsg('error', s.formError, animateError) : ''}
              <div class="wizard-actions">
                <div></div>
                <div>
                  <button type="submit" class="btn btn-primary" ${s.isCreating ? 'disabled' : ''}>
                    ${s.isCreating ? spinnerBtn(true, '') : icon('key')}
                    ${s.isCreating ? '' : ' Create key'}
                  </button>
                </div>
              </div>
            </form>
          </div>
          <div>
            <h2 class="biz-section-title">Your keys</h2>
            ${s.keys.length
              ? s.keys.map(keyCardHtml).join('')
              : `<div class="state-card"><div class="biz-icon neutral">${icon('key')}</div><div class="biz-body"><div class="biz-title">No API keys yet</div></div></div>`}
          </div>
        </div>
      `;
    }

    app.innerHTML = `
      <div class="page">
        <div class="page-head-row">
          <div class="head-text">
            <h1>API Library</h1>
            <p>Create keys and choose which APIs each one can call.</p>
          </div>
        </div>
        ${tabsHtml('/developer')}
        ${body}
      </div>
      ${s.revealed ? revealModalHtml() : ''}
      ${s.detailFor && s.keys.find((k) => k.id === s.detailFor) ? detailModalHtml(s.keys.find((k) => k.id === s.detailFor)) : ''}
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
      ${s.confirmRotate ? `
        <div class="modal-backdrop" id="rotate-modal-backdrop">
          <div class="modal" role="dialog" aria-modal="true" aria-labelledby="rotate-title">
            <h2 id="rotate-title">Rotate key</h2>
            <p>Rotate "${esc(s.confirmRotate.label)}"? Its current secret stops working immediately and a new one is shown once. Anything still using the old secret will need the new one.</p>
            <div style="display:flex;justify-content:flex-end;gap:var(--sp-sm);margin-top:var(--sp-xl);">
              <button type="button" class="btn" id="cancel-rotate-btn" ${s.isRotating ? 'disabled' : ''}>Cancel</button>
              <button type="button" class="btn btn-primary" id="confirm-rotate-btn" ${s.isRotating ? 'disabled' : ''}>${s.isRotating ? spinnerBtn(true, '') : 'Rotate'}</button>
            </div>
          </div>
        </div>
      ` : ''}
    `;

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
          render(); // a service's limit note / sandbox toggle comes and goes with its own checkbox
        });
      });
      form.querySelectorAll('input[name="sandboxFor"]').forEach((box) => {
        box.addEventListener('change', () => {
          s.sandbox = box.checked;
          if (s.sandbox) s.selected.delete('desk_api'); // a sandbox key has no Desk API
          render();
        });
      });
      const expiry = document.getElementById('key-expiry'); if (expiry) expiry.addEventListener('change', () => { s.expiresInDays = Number(expiry.value); });
    }

    app.querySelectorAll('[data-details]').forEach((b) => b.addEventListener('click', () => openDetails(b.dataset.details)));
    app.querySelectorAll('[data-retry-usage]').forEach((b) => b.addEventListener('click', () => loadUsage(b.dataset.retryUsage)));
    app.querySelectorAll('[data-suspend]').forEach((b) => b.addEventListener('click', () => { const k = s.keys.find((x) => x.id === b.dataset.suspend); if (k) setSuspended(k, b.dataset.off === '1'); }));
    app.querySelectorAll('[data-rotate]').forEach((b) => b.addEventListener('click', () => { s.confirmRotate = s.keys.find((x) => x.id === b.dataset.rotate) || null; render(); }));
    app.querySelectorAll('[data-add-api]').forEach((b) => b.addEventListener('click', () => { const [id, svc] = b.dataset.addApi.split('::'); const k = s.keys.find((x) => x.id === id); if (k) addService(k, svc); }));
    app.querySelectorAll('[data-remove-api]').forEach((b) => b.addEventListener('click', () => { const [id, svc] = b.dataset.removeApi.split('::'); const k = s.keys.find((x) => x.id === id); if (k) removeService(k, svc); }));

    const copy = document.getElementById('copy-key-btn');
    if (copy) copy.addEventListener('click', copyRevealedKey);
    const dismiss = document.getElementById('dismiss-reveal-btn');
    if (dismiss) dismiss.addEventListener('click', () => { s.revealed = null; render(); });
    const revealBackdrop = document.getElementById('reveal-modal-backdrop');
    if (revealBackdrop) revealBackdrop.addEventListener('click', (e) => { if (e.target === revealBackdrop) { s.revealed = null; render(); } });

    const closeDetail = document.getElementById('close-detail-btn');
    if (closeDetail) { closeDetail.addEventListener('click', () => { s.detailFor = null; render(); }); closeDetail.focus(); }
    const detailBackdrop = document.getElementById('detail-modal-backdrop');
    if (detailBackdrop) detailBackdrop.addEventListener('click', (e) => { if (e.target === detailBackdrop) { s.detailFor = null; render(); } });

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

    const cancelRotate = document.getElementById('cancel-rotate-btn');
    if (cancelRotate) { cancelRotate.addEventListener('click', () => { s.confirmRotate = null; render(); }); cancelRotate.focus(); }
    const confirmRotateBtn = document.getElementById('confirm-rotate-btn');
    if (confirmRotateBtn) confirmRotateBtn.addEventListener('click', rotateKey);
    const rotateBackdrop = document.getElementById('rotate-modal-backdrop');
    if (rotateBackdrop) rotateBackdrop.addEventListener('click', (e) => { if (e.target === rotateBackdrop && !s.isRotating) { s.confirmRotate = null; render(); } });
  }

  await load();
});
