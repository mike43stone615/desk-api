// API Library — create developer API keys and choose which APIs each one can
// call. Backed by desk-api's /gateway/* routes (desk-api src/routes/gateway.ts).
// Key management only works from a signed-in session; the plaintext key is
// shown exactly once, right after creation, and never again.
import {
  registerRoute, api, esc, icon, spinnerBtn, statusMsg, friendlyError, toast,
  reportHandledException, currentEpoch, submitOnEnter,
} from '../app.js';

const MAX_LABEL_LENGTH = 64;

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
    fieldErrors: {},
    formError: null,
    revealed: null,
    animateReveal: false,
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
      const res = await api('/gateway/api-keys', { method: 'POST', body: { label: s.label.trim(), services } });
      const { key, ...summary } = res.apiKey;
      s.keys = [summary, ...s.keys];
      s.revealed = { ...summary, key };
      s.animateReveal = true;
      s.label = '';
      s.selected = new Set();
    } catch (err) {
      reportHandledException(err, 'createApiKey');
      s.formError = friendlyError(err, 'We could not create that key. Please try again.');
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
    const disabled = !svc.available;
    return `
      <label class="library-row">
        <input type="checkbox" name="service" value="${esc(svc.service)}" aria-labelledby="svc-name-${esc(svc.service)}" aria-describedby="svc-desc-${esc(svc.service)}" ${s.selected.has(svc.service) ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
        <span class="library-icon">${icon(SERVICE_ICONS[svc.service] || 'category_outlined')}</span>
        <span class="library-body">
          <span class="name" id="svc-name-${esc(svc.service)}">${esc(svc.name)}</span>
          <span class="desc" id="svc-desc-${esc(svc.service)}">${esc(svc.description)}</span>
          <span class="hint">${disabled ? esc(svc.unavailableReason || 'Not available right now.') : `Endpoints under <b>${esc(svc.basePath)}</b>`}</span>
        </span>
      </label>
    `;
  }

  function revealHtml() {
    const r = s.revealed;
    return `
      <div class="card fold-in${s.animateReveal ? ' fold-in-animate' : ''}" id="reveal-card" style="max-height:1600px;margin-bottom:var(--sp-lg);">
        <h2 class="biz-section-title">Copy your new key</h2>
        <p class="hint" style="margin-bottom:var(--sp-md);">This is the only time the full key is shown. Store it somewhere safe — if you lose it, revoke it and create a new one.</p>
        <div class="reveal-key">
          <input id="reveal-input" readonly value="${esc(r.key)}" aria-label="Your new API key" />
          <button type="button" class="btn btn-primary" id="copy-key-btn">${icon('content_copy')} Copy</button>
        </div>
        <button type="button" class="btn" id="dismiss-reveal-btn" style="margin-top:var(--sp-lg);">I've saved my key</button>
      </div>
    `;
  }

  function keyCardHtml(k) {
    const used = k.lastUsedAt ? `Last used ${formatDate(k.lastUsedAt)}` : 'Never used';
    return `
      <div class="state-card key-card">
        <div class="biz-icon neutral">${icon('key')}</div>
        <div class="biz-body">
          <div class="biz-title">${esc(k.label)}</div>
          <div class="biz-sub">${esc(k.keyPrefix)}… · Created ${esc(formatDate(k.createdAt))} · ${esc(used)}</div>
          <div class="biz-chips">${(k.services || []).map((id) => `<span class="meta-chip">${esc(serviceName(id))}</span>`).join('')}</div>
        </div>
        <button type="button" class="btn btn-sm" data-revoke="${esc(k.id)}" aria-label="Revoke key ${esc(k.label)}">Revoke</button>
      </div>
    `;
  }

  function render() {
    let body;
    if (s.isLoading) {
      body = `<div class="empty-state">${spinnerBtn(true, '', { dark: true })}<div style="margin-top:var(--sp-md);">Loading your API keys…</div></div>`;
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
          <p class="hint" style="margin-bottom:var(--sp-lg);">Choose which APIs the key can call. A key's APIs are fixed once it's created — to change them, create a new key.</p>
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
        });
      });
    }

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
