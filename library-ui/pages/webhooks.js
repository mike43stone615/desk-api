// Webhooks: tell Desk where to send events (a key is made, a plan changes, ...). Backed by /gateway/webhooks (src/routes/webhooksOut.ts).
// The signing secret is shown once, when an endpoint is made or its secret rotated; the list never shows it.
import {
  registerRoute, api, esc, icon, spinnerBtn, statusMsg, friendlyError, toast, reportHandledException, currentEpoch, submitOnEnter, navigate,
} from '../app.js';
import { tabsHtml } from '../tabs.js';
import { EVENT_LABELS, statusChip } from '../format.js';

const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

registerRoute('/developer/webhooks', async (app) => {
  const myEpoch = currentEpoch();
  const s = {
    isLoading: true, loadError: null,
    teams: [], events: [], endpoints: [],
    scope: '', // '' = my own, else a team id
    url: '', chosen: new Set(),
    isCreating: false, formError: null,
    revealed: null, // { secret, what }
    deliveriesFor: null, deliveries: [], loadingDeliveries: false,
    confirm: null, // { kind: 'delete' | 'rotate', id, url }
    isBusy: false, _lastFormError: null,
  };
  const isCurrent = () => currentEpoch() === myEpoch;
  const query = () => (s.scope ? `?teamId=${encodeURIComponent(s.scope)}` : '');

  async function loadEndpoints() {
    const res = await api(`/gateway/webhooks${query()}`);
    s.endpoints = res.endpoints || [];
  }
  async function load() {
    s.isLoading = true; s.loadError = null; render();
    try {
      const [teams, events] = await Promise.all([api('/teams'), api('/gateway/webhook-events')]);
      // Only owners and admins may manage a team's webhooks.
      s.teams = (teams.teams || []).filter((t) => t.role === 'owner' || t.role === 'admin');
      s.events = events.events || [];
      await loadEndpoints();
    } catch (err) {
      reportHandledException(err, 'loadWebhooks');
      s.loadError = friendlyError(err, 'We could not load your webhooks.');
    } finally {
      if (isCurrent()) { s.isLoading = false; render(); }
    }
  }

  async function createEndpoint(e) {
    e.preventDefault();
    if (!s.url.trim()) { s.formError = 'Enter the address to send events to.'; render(); return; }
    if (s.chosen.size === 0) { s.formError = 'Choose at least one event.'; render(); return; }
    s.isCreating = true; s.formError = null; render();
    try {
      const body = { url: s.url.trim(), events: s.events.filter((x) => s.chosen.has(x)) };
      if (s.scope) body.teamId = s.scope;
      const res = await api('/gateway/webhooks', { method: 'POST', body });
      s.revealed = { secret: res.secret, what: 'endpoint' };
      s.url = ''; s.chosen = new Set();
      await loadEndpoints();
    } catch (err) {
      reportHandledException(err, 'createWebhook');
      s.formError = friendlyError(err, 'We could not add that endpoint. Please try again.');
    } finally {
      s.isCreating = false;
      if (isCurrent()) render();
    }
  }

  async function guarded(what, fn, failText) {
    if (s.isBusy) return;
    s.isBusy = true; render();
    try { await fn(); } catch (err) { reportHandledException(err, what); toast(friendlyError(err, failText), true); }
    finally { s.confirm = null; s.isBusy = false; if (isCurrent()) render(); }
  }
  const sendTest = (id) => guarded('testWebhook', async () => {
    await api(`/gateway/webhooks/${encodeURIComponent(id)}/test`, { method: 'POST', body: {} });
    toast('Test event queued. It arrives within a minute; see Deliveries for the result.');
  }, 'Could not queue a test event.');
  const removeEndpoint = (id) => guarded('deleteWebhook', async () => {
    await api(`/gateway/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (s.deliveriesFor === id) { s.deliveriesFor = null; s.deliveries = []; }
    await loadEndpoints();
    toast('Endpoint removed.');
  }, 'Could not remove that endpoint.');
  const rotate = (id) => guarded('rotateWebhookSecret', async () => {
    const res = await api(`/gateway/webhooks/${encodeURIComponent(id)}/rotate-secret`, { method: 'POST', body: {} });
    s.revealed = { secret: res.secret, what: 'new secret' };
    await loadEndpoints();
  }, 'Could not make a new secret.');

  async function showDeliveries(id) {
    if (s.deliveriesFor === id) { s.deliveriesFor = null; render(); return; }
    s.deliveriesFor = id; s.deliveries = []; s.loadingDeliveries = true; render();
    try {
      s.deliveries = (await api(`/gateway/webhooks/${encodeURIComponent(id)}/deliveries`)).deliveries || [];
    } catch (err) {
      toast(friendlyError(err, 'Could not load the deliveries.'), true);
      s.deliveriesFor = null;
    } finally {
      s.loadingDeliveries = false;
      if (isCurrent()) render();
    }
  }

  async function copySecret() {
    const input = document.getElementById('wh-secret');
    if (!input) return;
    try { await navigator.clipboard.writeText(s.revealed.secret); toast('Secret copied.'); } catch { input.select(); toast('Press Ctrl+C to copy the selected secret.'); }
  }
  const onKeydown = (e) => {
    if (!isCurrent()) { document.removeEventListener('keydown', onKeydown); return; }
    if (e.key === 'Escape' && s.confirm && !s.isBusy) { s.confirm = null; render(); }
  };
  document.addEventListener('keydown', onKeydown);

  function endpointHtml(ep) {
    const off = !ep.active;
    return `
      <div class="state-card key-card">
        <div class="biz-icon neutral">${icon('link')}</div>
        <div class="biz-body">
          <div class="biz-title">${esc(ep.url)}</div>
          <div class="biz-sub">${off ? `<b>Switched off.</b> ${esc(ep.disabledReason || '')}` : `Active · added ${esc(when(ep.createdAt))}`}${ep.consecutiveFailures ? ` · ${ep.consecutiveFailures} failed in a row` : ''}</div>
          <div class="biz-chips">${ep.events.map((x) => `<span class="meta-chip">${esc(EVENT_LABELS[x] || x)}</span>`).join('')}</div>
        </div>
        <button type="button" class="btn btn-sm" data-test="${esc(ep.id)}" ${off ? 'disabled' : ''}>Send test</button>
        <button type="button" class="btn btn-sm" data-deliveries="${esc(ep.id)}" aria-expanded="${s.deliveriesFor === ep.id}">Deliveries</button>
        <button type="button" class="btn btn-sm" data-rotate="${esc(ep.id)}" data-url="${esc(ep.url)}">${off ? 'Turn back on' : 'New secret'}</button>
        <button type="button" class="btn btn-sm" data-delete="${esc(ep.id)}" data-url="${esc(ep.url)}" aria-label="Remove ${esc(ep.url)}">Remove</button>
      </div>
      ${s.deliveriesFor === ep.id ? `<div class="card" style="margin:calc(var(--sp-sm) * -1) 0 var(--sp-md);">${
        s.loadingDeliveries ? `<div class="biz-sub">Loading…</div>`
        : s.deliveries.length === 0 ? `<div class="biz-sub">Nothing has been sent to this endpoint yet.</div>`
        : `<table class="plain-table"><thead><tr><th>When</th><th>Event</th><th>Result</th><th>Tries</th></tr></thead><tbody>${s.deliveries.map((d) => `<tr><td>${esc(when(d.createdAt))}</td><td>${esc(EVENT_LABELS[d.eventType] || d.eventType)}</td><td>${esc(statusChip(d))}${d.lastStatus ? ` (${d.lastStatus})` : ''}${d.lastError ? `<div class="biz-sub">${esc(d.lastError)}</div>` : ''}</td><td>${d.attempts}</td></tr>`).join('')}</tbody></table>`}</div>` : ''}`;
  }

  function render() {
    let body;
    if (s.isLoading) body = `<div class="empty-state">${spinnerBtn(true, '', { dark: true })}<div style="margin-top:var(--sp-md);">Loading your webhooks…</div></div>`;
    else if (s.loadError) body = `<div class="empty-state">${icon('error_outline')}<div style="margin-top:var(--sp-md);">Webhooks could not load</div><div class="hint">${esc(s.loadError)}</div><button type="button" class="btn" id="retry-btn" style="margin-top:var(--sp-lg);">${icon('refresh')} Try again</button></div>`;
    else {
      const animate = s.formError !== s._lastFormError; s._lastFormError = s.formError;
      body = `
        ${s.revealed ? `
          <div class="card" style="margin-bottom:var(--sp-lg);">
            <h2 class="biz-section-title">Copy your ${s.revealed.what === 'endpoint' ? 'signing secret' : 'new signing secret'}</h2>
            <p class="biz-sub" style="margin-bottom:var(--sp-md);">This is the only time it is shown. Your server uses it to check that a request really came from Desk.</p>
            <div class="reveal-key"><input id="wh-secret" readonly value="${esc(s.revealed.secret)}" aria-label="Signing secret" /><button type="button" class="btn btn-primary" id="wh-copy">${icon('content_copy')} Copy</button></div>
            <button type="button" class="btn" id="wh-dismiss" style="margin-top:var(--sp-lg);">I've saved it</button>
          </div>` : ''}
        <div class="card" style="margin-bottom:var(--sp-lg);">
          <h2 class="biz-section-title">Add an endpoint</h2>
          <p class="biz-sub" style="margin-bottom:var(--sp-lg);">Desk sends a signed message to this address when the events you choose happen. It must start with https:// and be reachable from the internet. Failed deliveries are retried for about nine hours; an endpoint that fails ten times in a row is switched off.</p>
          <form id="wh-form" novalidate>
            ${s.teams.length ? `<div class="field-header"><label for="wh-scope">For</label></div><select id="wh-scope" class="team-select" style="margin-bottom:var(--sp-md);"><option value="">Me</option>${s.teams.map((t) => `<option value="${esc(t.id)}" ${s.scope === t.id ? 'selected' : ''}>Team: ${esc(t.name)}</option>`).join('')}</select>` : ''}
            <div class="field-float has-icon"><span class="field-icon">${icon('link')}</span><label>Address (https://…)</label><input name="url" type="url" placeholder=" " maxlength="500" value="${esc(s.url)}" autocomplete="off" /></div>
            <div class="field-header"><label>Events</label></div>
            <div class="library-list">${s.events.map((x) => `<label class="library-row"><input type="checkbox" name="event" value="${esc(x)}" ${s.chosen.has(x) ? 'checked' : ''} /><span class="library-body"><span class="name">${esc(EVENT_LABELS[x] || x)}</span><span class="biz-sub">${esc(x)}</span></span></label>`).join('')}</div>
            ${s.formError ? statusMsg('error', s.formError, animate) : ''}
            <button type="submit" class="btn btn-primary" style="margin-top:var(--sp-lg);" ${s.isCreating ? 'disabled' : ''}>${s.isCreating ? spinnerBtn(true, '') : icon('link')}${s.isCreating ? '' : ' Add endpoint'}</button>
          </form>
        </div>
        <h2 class="biz-section-title">${s.scope ? 'Team endpoints' : 'Your endpoints'}</h2>
        ${s.endpoints.length ? s.endpoints.map(endpointHtml).join('') : `<div class="state-card"><div class="biz-icon neutral">${icon('link')}</div><div class="biz-body"><div class="biz-title">No endpoints yet</div><div class="biz-sub">Add one above to start receiving events.</div></div></div>`}`;
    }
    const c = s.confirm;
    app.innerHTML = `
      <div class="page">
        <div class="page-head-row"><div class="head-text"><h1>API Library</h1><p>Get a signed message on your server when something happens.</p></div></div>
        ${tabsHtml('/developer/webhooks')}
        ${body}
      </div>
      ${c ? `<div class="modal-backdrop" id="wh-backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="wh-modal-title"><h2 id="wh-modal-title">${c.kind === 'delete' ? 'Remove endpoint' : 'Make a new secret'}</h2><p>${c.kind === 'delete' ? `Remove ${esc(c.url)}? Nothing more is sent to it.` : `Make a new signing secret for ${esc(c.url)}? The old secret stops working at once, so update your server. If the endpoint was switched off, it is switched back on.`}</p><div style="display:flex;justify-content:flex-end;gap:var(--sp-sm);margin-top:var(--sp-xl);"><button type="button" class="btn" id="wh-cancel" ${s.isBusy ? 'disabled' : ''}>Cancel</button><button type="button" class="btn ${c.kind === 'delete' ? 'btn-danger' : 'btn-primary'}" id="wh-confirm" ${s.isBusy ? 'disabled' : ''}>${s.isBusy ? spinnerBtn(true, '') : (c.kind === 'delete' ? 'Remove' : 'Make new secret')}</button></div></div></div>` : ''}`;
    wire();
  }

  function wire() {
    const $ = (id) => document.getElementById(id);
    app.querySelectorAll('[data-nav]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); navigate(a.dataset.nav); }));
    const retry = $('retry-btn'); if (retry) retry.addEventListener('click', load);
    const scope = $('wh-scope');
    if (scope) scope.addEventListener('change', async () => { s.scope = scope.value; s.deliveriesFor = null; s.isLoading = true; render(); try { await loadEndpoints(); } catch (err) { toast(friendlyError(err, 'Could not load that list.'), true); } finally { s.isLoading = false; if (isCurrent()) render(); } });
    const form = $('wh-form');
    if (form) {
      form.addEventListener('submit', createEndpoint); submitOnEnter(form);
      form.querySelector('input[name="url"]').addEventListener('input', (e) => { s.url = e.target.value; });
      form.querySelectorAll('input[name="event"]').forEach((box) => box.addEventListener('change', () => { if (box.checked) s.chosen.add(box.value); else s.chosen.delete(box.value); }));
    }
    const copy = $('wh-copy'); if (copy) copy.addEventListener('click', copySecret);
    const dismiss = $('wh-dismiss'); if (dismiss) dismiss.addEventListener('click', () => { s.revealed = null; render(); });
    app.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', () => sendTest(b.dataset.test)));
    app.querySelectorAll('[data-deliveries]').forEach((b) => b.addEventListener('click', () => showDeliveries(b.dataset.deliveries)));
    app.querySelectorAll('[data-rotate]').forEach((b) => b.addEventListener('click', () => { s.confirm = { kind: 'rotate', id: b.dataset.rotate, url: b.dataset.url }; render(); }));
    app.querySelectorAll('[data-delete]').forEach((b) => b.addEventListener('click', () => { s.confirm = { kind: 'delete', id: b.dataset.delete, url: b.dataset.url }; render(); }));
    const cancel = $('wh-cancel'); if (cancel) { cancel.addEventListener('click', () => { s.confirm = null; render(); }); cancel.focus(); }
    const ok = $('wh-confirm'); if (ok) ok.addEventListener('click', () => { const c = s.confirm; if (c.kind === 'delete') removeEndpoint(c.id); else rotate(c.id); });
    const backdrop = $('wh-backdrop'); if (backdrop) backdrop.addEventListener('click', (e) => { if (e.target === backdrop && !s.isBusy) { s.confirm = null; render(); } });
  }

  await load();
});
