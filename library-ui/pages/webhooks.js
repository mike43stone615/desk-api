// Webhooks: tell Desk where to send events (a key is made, a plan changes, ...). Backed by /gateway/webhooks (src/routes/webhooksOut.ts).
// The signing secret is shown once, when an endpoint is made or its secret rotated; the list never shows it.
// Each endpoint card mirrors an API key card (pages/developer.js): its details sit in a hoverable "i" badge, and its
// actions (Deliveries, Events, Send test, Switch off/on, Rotate, Revoke) open the same style of pop-up.
import {
  registerRoute, api, esc, icon, spinnerBtn, statusMsg, friendlyError, toast, reportHandledException, currentEpoch, submitOnEnter, navigate,
} from '../app.js';
import { tabsHtml } from '../tabs.js';
import { EVENT_LABELS } from '../format.js';

const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};
const formatDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};
const timeOnly = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { timeStyle: 'short' });
};
/** Hoverable (not clickable) "i" badge: a small themed tooltip instead of the native title attribute. Matches pages/developer.js.
    `lines`: one fact per line (never one long run-on line). `openRight`: the tooltip opens to the right of the badge, for a
    badge near the left edge where opening left would be cut off. */
function infoIcon(lines, openRight = false) {
  const text = (Array.isArray(lines) ? lines : [lines]).filter(Boolean).join('\n');
  if (!text) return '';
  return `<span class="info-icon${openRight ? ' open-right' : ''}" tabindex="0">${icon('info_outline')}<span class="info-tooltip" role="tooltip">${esc(text)}</span></span>`;
}

/** How long to wait before quietly reloading an open Deliveries pop-up while something is still waiting to retry. */
const DELIVERIES_REFRESH_MS = 30_000;

registerRoute('/developer/webhooks', async (app) => {
  const myEpoch = currentEpoch();
  const s = {
    isLoading: true, loadError: null,
    events: [], endpoints: [],
    url: '', chosen: new Set(),
    isCreating: false, formError: null,
    revealed: null, // { secret, rotated }
    deliveriesFor: null, deliveries: [], loadingDeliveries: false, deliveriesTimer: null,
    eventsFor: null, // the id of the endpoint whose Events pop-up is open
    confirm: null, // { kind: 'revoke' | 'rotate', id, url }
    busyEndpoints: new Set(), // endpoint ids with a switch/events change in flight
    isBusy: false, _lastFormError: null,
  };
  const isCurrent = () => currentEpoch() === myEpoch;
  const findEndpoint = (id) => s.endpoints.find((x) => x.id === id) || null;
  const replaceEndpoint = (updated) => { s.endpoints = s.endpoints.map((x) => (x.id === updated.id ? { ...x, ...updated } : x)); };

  async function loadEndpoints() {
    const res = await api('/gateway/webhooks');
    s.endpoints = res.endpoints || [];
  }
  async function load() {
    s.isLoading = true; s.loadError = null; render();
    try {
      const events = await api('/gateway/webhook-events');
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
      const res = await api('/gateway/webhooks', { method: 'POST', body });
      s.revealed = { secret: res.secret, rotated: false };
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
  /** A change to one endpoint (switch, events) that does not need a confirmation pop-up; only that card's buttons wait on it. */
  async function changeEndpoint(id, what, fn, failText) {
    if (s.busyEndpoints.has(id)) return;
    s.busyEndpoints.add(id); render();
    try { await fn(); } catch (err) { reportHandledException(err, what); toast(friendlyError(err, failText), true); }
    finally { s.busyEndpoints.delete(id); if (isCurrent()) render(); }
  }

  const sendTest = (id) => changeEndpoint(id, 'testWebhook', async () => {
    await api(`/gateway/webhooks/${encodeURIComponent(id)}/test`, { method: 'POST', body: {} });
    toast('Test event queued. It arrives within a minute; see Deliveries for the result.');
  }, 'Could not queue a test event.');
  const setActive = (ep, on) => changeEndpoint(ep.id, on ? 'resumeWebhook' : 'suspendWebhook', async () => {
    const res = await api(`/gateway/webhooks/${encodeURIComponent(ep.id)}/${on ? 'resume' : 'suspend'}`, { method: 'POST', body: {} });
    replaceEndpoint(res.endpoint);
    toast(on ? 'Endpoint switched on.' : 'Endpoint switched off. Nothing is sent to it until you switch it back on.');
  }, on ? 'Could not switch that endpoint on.' : 'Could not switch that endpoint off.');
  const toggleEvent = (ep, event, on) => changeEndpoint(ep.id, 'setWebhookEvents', async () => {
    const next = on ? [...new Set([...ep.events, event])] : ep.events.filter((x) => x !== event);
    const res = await api(`/gateway/webhooks/${encodeURIComponent(ep.id)}/events`, { method: 'PUT', body: { events: s.events.filter((x) => next.includes(x)) } });
    replaceEndpoint(res.endpoint);
    toast(on ? `${EVENT_LABELS[event] || event}: added.` : `${EVENT_LABELS[event] || event}: removed.`);
  }, 'Could not change the events.');
  const revokeEndpoint = (id) => guarded('deleteWebhook', async () => {
    await api(`/gateway/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (s.deliveriesFor === id) closeDeliveries();
    if (s.eventsFor === id) s.eventsFor = null;
    await loadEndpoints();
    toast('Endpoint revoked.');
  }, 'Could not revoke that endpoint.');
  const rotate = (id) => guarded('rotateWebhookSecret', async () => {
    const res = await api(`/gateway/webhooks/${encodeURIComponent(id)}/rotate-secret`, { method: 'POST', body: {} });
    s.revealed = { secret: res.secret, rotated: true };
    await loadEndpoints();
  }, 'Could not rotate that secret.');

  // ── deliveries pop-up ───────────────────────────────────────────────────────────────────────────────────────────
  function closeDeliveries() {
    if (s.deliveriesTimer) clearTimeout(s.deliveriesTimer);
    s.deliveriesTimer = null; s.deliveriesFor = null; s.deliveries = [];
  }
  async function fetchDeliveries(id, quiet) {
    if (!quiet) { s.deliveries = []; s.loadingDeliveries = true; render(); }
    try {
      const rows = (await api(`/gateway/webhooks/${encodeURIComponent(id)}/deliveries`)).deliveries || [];
      if (s.deliveriesFor !== id) return; // closed (or switched) while loading
      s.deliveries = rows;
    } catch (err) {
      if (!quiet) { toast(friendlyError(err, 'Could not load the deliveries.'), true); closeDeliveries(); }
    } finally {
      s.loadingDeliveries = false;
      if (isCurrent()) {
        render();
        // Keep the table honest while something is still waiting for its next try (each try updates the row).
        if (s.deliveriesFor === id && s.deliveries.some((d) => d.status === 'pending')) {
          if (s.deliveriesTimer) clearTimeout(s.deliveriesTimer);
          s.deliveriesTimer = setTimeout(() => { if (isCurrent() && s.deliveriesFor === id) fetchDeliveries(id, true); }, DELIVERIES_REFRESH_MS);
        }
      }
    }
  }
  function openDeliveries(id) {
    closeDeliveries();
    s.deliveriesFor = id;
    fetchDeliveries(id, false);
  }

  async function copySecret() {
    const input = document.getElementById('wh-secret');
    if (!input) return;
    try { await navigator.clipboard.writeText(s.revealed.secret); toast('Secret copied.'); } catch { input.select(); toast('Press Ctrl+C to copy the selected secret.'); }
  }
  const onKeydown = (e) => {
    if (!isCurrent()) { document.removeEventListener('keydown', onKeydown); if (s.deliveriesTimer) clearTimeout(s.deliveriesTimer); return; }
    if (e.key !== 'Escape') return;
    if (s.confirm && !s.isBusy) { s.confirm = null; render(); return; }
    if (s.eventsFor) { s.eventsFor = null; render(); return; }
    if (s.deliveriesFor) { closeDeliveries(); render(); return; }
    if (s.revealed) { s.revealed = null; render(); }
  };
  document.addEventListener('keydown', onKeydown);

  function endpointInfo(ep) {
    const lines = [`Created ${formatDate(ep.createdAt)}`, ep.active ? 'Active' : 'Inactive'];
    if (!ep.active && ep.disabledReason) lines.push(ep.disabledReason);
    return lines;
  }

  function endpointHtml(ep) {
    const off = !ep.active;
    const busy = s.busyEndpoints.has(ep.id);
    return `
      <div class="state-card key-card">
        <div class="biz-icon neutral">${icon('link')}</div>
        <div class="biz-body">
          <div class="biz-title-row"><div class="biz-title">${esc(ep.url)}</div>${infoIcon(endpointInfo(ep))}</div>
        </div>
        <div class="key-actions endpoint-actions">
          <button type="button" class="btn btn-sm" data-deliveries="${esc(ep.id)}" aria-label="Show deliveries to ${esc(ep.url)}">Deliveries</button>
          <button type="button" class="btn btn-sm" data-events="${esc(ep.id)}" ${busy ? 'disabled' : ''} aria-label="Choose events for ${esc(ep.url)}">Events</button>
          <button type="button" class="btn btn-sm" data-test="${esc(ep.id)}" ${off || busy ? 'disabled' : ''} aria-label="Send a test event to ${esc(ep.url)}">Send test</button>
          <button type="button" class="btn btn-sm btn-suspend-toggle ${off ? 'btn-warn' : ''}" data-switch="${esc(ep.id)}" data-on="${off ? '1' : '0'}" ${busy ? 'disabled' : ''} aria-label="${off ? 'Switch on' : 'Switch off'} ${esc(ep.url)}">${off ? 'Switch on' : 'Switch off'}</button>
          <button type="button" class="btn btn-sm" data-rotate="${esc(ep.id)}" ${busy ? 'disabled' : ''} aria-label="Rotate the signing secret for ${esc(ep.url)}">Rotate</button>
          <button type="button" class="btn btn-sm" data-revoke="${esc(ep.id)}" aria-label="Revoke ${esc(ep.url)}">Revoke</button>
        </div>
      </div>`;
  }

  function revealModalHtml() {
    const r = s.revealed;
    return `
      <div class="modal-backdrop" id="wh-reveal-backdrop">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="wh-reveal-title">
          <h2 id="wh-reveal-title">${r.rotated ? 'Copy your new signing secret' : 'Copy your signing secret'}</h2>
          <p class="modal-text">This is the only time it is shown. Your server uses it to check that a request really came from Desk.</p>
          <div class="reveal-key">
            <input id="wh-secret" readonly value="${esc(r.secret)}" aria-label="Signing secret" />
            <button type="button" class="btn btn-primary" id="wh-copy">${icon('content_copy')} Copy</button>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn" id="wh-dismiss">I've saved it</button>
          </div>
        </div>
      </div>`;
  }

  function eventsModalHtml(ep) {
    const busy = s.busyEndpoints.has(ep.id);
    return `
      <div class="modal-backdrop" id="wh-events-backdrop">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="wh-events-title">
          <h2 id="wh-events-title">Events for "${esc(ep.url)}"</h2>
          <div class="library-list">
            ${s.events.map((x) => {
              const on = ep.events.includes(x);
              const lastOne = on && ep.events.length === 1; // an endpoint always listens for at least one event
              return `<label class="library-row"><input type="checkbox" data-event-choice="${esc(x)}" ${on ? 'checked' : ''} ${busy || lastOne ? 'disabled' : ''} /><span class="library-body"><span class="name">${esc(EVENT_LABELS[x] || x)}</span></span></label>`;
            }).join('')}
          </div>
          <div class="modal-actions">
            <button type="button" class="btn" id="wh-events-close">Cancel</button>
          </div>
        </div>
      </div>`;
  }

  /** One delivery's progress: a full bar once it is sent or has used every try, otherwise a bar that fills in real time
      (a CSS animation, so no per-second re-render) from when its current wait began until its next try is due. */
  function progressHtml(d) {
    if (d.status === 'delivered') return '<div class="delivery-progress done"><div class="delivery-fill"></div></div>';
    if (d.status === 'failed') return '<div class="delivery-progress failed"><div class="delivery-fill"></div></div>';
    const next = d.nextAttemptAt ? Date.parse(d.nextAttemptAt) : NaN;
    if (!d.retryWaitSeconds || Number.isNaN(next)) {
      return '<div class="delivery-progress"><div class="delivery-fill" style="width:0"></div></div><div class="delivery-next">Sending now</div>';
    }
    const total = d.retryWaitSeconds * 1000;
    const remaining = Math.max(0, next - Date.now());
    const pct = Math.min(100, Math.max(0, ((total - remaining) / total) * 100));
    return `<div class="delivery-progress"><div class="delivery-fill filling" style="--from:${pct.toFixed(2)}%;animation-duration:${Math.round(remaining / 1000)}s"></div></div><div class="delivery-next">Next try ${esc(timeOnly(d.nextAttemptAt))}</div>`;
  }

  function resultHtml(d) {
    if (d.status === 'delivered') return `<span class="delivery-result sent">${icon('check_circle_outline')} Sent</span>`;
    if (d.attempts === 0) return '<span class="delivery-result">Queued</span>';
    const reason = d.lastStatus ? `The receiver answered ${d.lastStatus}` : d.lastError;
    return `<span class="delivery-result failed">${icon('error_outline')} Failed${d.lastStatus ? ` ${d.lastStatus}` : ''}</span>${reason && !d.lastStatus ? `<div class="biz-sub">${esc(reason)}</div>` : ''}`;
  }

  function deliveriesModalHtml() {
    const ep = findEndpoint(s.deliveriesFor);
    return `
      <div class="modal-backdrop" id="wh-deliveries-backdrop">
        <div class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="wh-deliveries-title">
          <h2 id="wh-deliveries-title">Deliveries</h2>
          ${ep ? `<p class="modal-text">${esc(ep.url)} · last 30 days</p>` : ''}
          <div class="deliveries-body">
            ${s.loadingDeliveries ? `<div class="empty-state">${spinnerBtn(true, '', { dark: true })}</div>`
              : s.deliveries.length === 0 ? '<p class="modal-text">Nothing has been sent to this endpoint in the last 30 days.</p>'
              : `<table class="plain-table deliveries-table"><thead><tr><th>When</th><th>Event</th><th>Progress</th><th>Result</th><th class="num">Tries</th></tr></thead><tbody>${s.deliveries.map((d) => `
                  <tr>
                    <td>${esc(when(d.createdAt))}</td>
                    <td>${esc(EVENT_LABELS[d.eventType] || d.eventType)}</td>
                    <td class="progress-cell">${progressHtml(d)}</td>
                    <td>${resultHtml(d)}</td>
                    <td class="num">${d.attempts}/${d.maxAttempts}</td>
                  </tr>`).join('')}</tbody></table>`}
          </div>
          <div class="modal-actions">
            <button type="button" class="btn" id="wh-deliveries-close">Close</button>
          </div>
        </div>
      </div>`;
  }

  function confirmModalHtml(c) {
    const revoke = c.kind === 'revoke';
    return `
      <div class="modal-backdrop" id="wh-backdrop">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="wh-modal-title">
          <h2 id="wh-modal-title">${revoke ? 'Revoke endpoint' : 'Rotate secret'}</h2>
          <p class="modal-text">${revoke
            ? `Revoke "${esc(c.url)}"? Nothing more is sent to it. This cannot be undone.`
            : `Rotate the signing secret for "${esc(c.url)}"? Its current secret stops working immediately and a new one is shown once. Your server will need the new one to check requests.`}</p>
          <div class="modal-actions">
            <button type="button" class="btn" id="wh-cancel" ${s.isBusy ? 'disabled' : ''}>Cancel</button>
            <button type="button" class="btn ${revoke ? 'btn-danger' : 'btn-primary'}" id="wh-confirm" ${s.isBusy ? 'disabled' : ''}>${s.isBusy ? spinnerBtn(true, '') : (revoke ? 'Revoke' : 'Rotate')}</button>
          </div>
        </div>
      </div>`;
  }

  function render() {
    const scrolls = Object.fromEntries([...document.querySelectorAll('.modal-backdrop')].map((b) => [b.id, b.querySelector('.modal')?.scrollTop || 0]));
    let body;
    if (s.isLoading) body = `<div class="empty-state">${spinnerBtn(true, '', { dark: true })}</div>`;
    else if (s.loadError) body = `<div class="empty-state">${icon('error_outline')}<div style="margin-top:var(--sp-md);">Webhooks could not load</div><div class="hint">${esc(s.loadError)}</div><button type="button" class="btn" id="retry-btn" style="margin-top:var(--sp-lg);">${icon('refresh')} Try again</button></div>`;
    else {
      const animate = s.formError !== s._lastFormError; s._lastFormError = s.formError;
      body = `
        <div class="developer-split">
          <div class="card">
            <div class="biz-title-row section-title-row"><h2 class="biz-section-title">Add an endpoint</h2>${infoIcon(['Desk sends a signed message to this address when the events you choose happen. It must start with https:// and be reachable from the internet (developers using http:// addresses are also supported).', 'Each delivery is tried up to 6 times over about 9 hours. An endpoint is switched off after 10 deliveries in a row fail all their tries.'], true)}</div>
            <form id="wh-form" novalidate>
              <div class="field-float has-icon"><span class="field-icon">${icon('link')}</span><label>Address (https://…)</label><input name="url" type="url" placeholder=" " maxlength="500" value="${esc(s.url)}" autocomplete="off" /></div>
              <div class="field-header"><label>Events</label></div>
              <div class="library-list">${s.events.map((x) => `<label class="library-row"><input type="checkbox" name="event" value="${esc(x)}" ${s.chosen.has(x) ? 'checked' : ''} /><span class="library-body"><span class="name">${esc(EVENT_LABELS[x] || x)}</span></span></label>`).join('')}</div>
              ${s.formError ? statusMsg('error', s.formError, animate) : ''}
              <div class="wizard-actions">
                <div></div>
                <div><button type="submit" class="btn btn-primary" ${s.isCreating ? 'disabled' : ''}>${s.isCreating ? spinnerBtn(true, '') : icon('link')}${s.isCreating ? '' : ' Add endpoint'}</button></div>
              </div>
            </form>
          </div>
          <div>
            <h2 class="biz-section-title">Your endpoints</h2>
            ${s.endpoints.length ? s.endpoints.map(endpointHtml).join('') : `<div class="state-card"><div class="biz-icon neutral">${icon('link')}</div><div class="biz-body"><div class="biz-title">No endpoints yet</div><div class="biz-sub">Add one to get started.</div></div></div>`}
          </div>
        </div>`;
    }
    const eventsEp = s.eventsFor ? findEndpoint(s.eventsFor) : null;
    app.innerHTML = `
      <div class="page">
        <div class="page-head-row"><div class="head-text"><h1>API Library</h1><p>Get a signed message on your server when something happens.</p></div></div>
        ${tabsHtml('/developer/webhooks')}
        ${body}
      </div>
      ${s.deliveriesFor ? deliveriesModalHtml() : ''}
      ${eventsEp ? eventsModalHtml(eventsEp) : ''}
      ${s.revealed ? revealModalHtml() : ''}
      ${s.confirm ? confirmModalHtml(s.confirm) : ''}`;
    for (const [id, top] of Object.entries(scrolls)) {
      const m = document.getElementById(id)?.querySelector('.modal');
      if (m) m.scrollTop = top;
    }
    wire(scrolls);
  }

  function wire(previouslyOpen = {}) {
    const justOpened = (id) => !(id in previouslyOpen);
    const $ = (id) => document.getElementById(id);
    const onBackdrop = (id, close) => { const el = $(id); if (el) el.addEventListener('click', (e) => { if (e.target === el) close(); }); };
    app.querySelectorAll('[data-nav]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); navigate(a.dataset.nav); }));
    const retry = $('retry-btn'); if (retry) retry.addEventListener('click', load);
    const form = $('wh-form');
    if (form) {
      form.addEventListener('submit', createEndpoint); submitOnEnter(form);
      form.querySelector('input[name="url"]').addEventListener('input', (e) => { s.url = e.target.value; });
      form.querySelectorAll('input[name="event"]').forEach((box) => box.addEventListener('change', () => { if (box.checked) s.chosen.add(box.value); else s.chosen.delete(box.value); }));
    }

    app.querySelectorAll('[data-deliveries]').forEach((b) => b.addEventListener('click', () => openDeliveries(b.dataset.deliveries)));
    app.querySelectorAll('[data-events]').forEach((b) => b.addEventListener('click', () => { s.eventsFor = b.dataset.events; render(); }));
    app.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', () => sendTest(b.dataset.test)));
    app.querySelectorAll('[data-switch]').forEach((b) => b.addEventListener('click', () => { const ep = findEndpoint(b.dataset.switch); if (ep) setActive(ep, b.dataset.on === '1'); }));
    app.querySelectorAll('[data-rotate]').forEach((b) => b.addEventListener('click', () => { const ep = findEndpoint(b.dataset.rotate); if (ep) { s.confirm = { kind: 'rotate', id: ep.id, url: ep.url }; render(); } }));
    app.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', () => { const ep = findEndpoint(b.dataset.revoke); if (ep) { s.confirm = { kind: 'revoke', id: ep.id, url: ep.url }; render(); } }));

    // Deliveries pop-up
    const closeDel = () => { closeDeliveries(); render(); };
    const delClose = $('wh-deliveries-close'); if (delClose) { delClose.addEventListener('click', closeDel); if (!s.confirm && !s.revealed && !s.eventsFor && justOpened('wh-deliveries-backdrop')) delClose.focus(); }
    onBackdrop('wh-deliveries-backdrop', closeDel);

    // Events pop-up
    const eventsEp = s.eventsFor ? findEndpoint(s.eventsFor) : null;
    if (eventsEp) app.querySelectorAll('[data-event-choice]').forEach((box) => box.addEventListener('change', () => toggleEvent(eventsEp, box.dataset.eventChoice, box.checked)));
    const closeEvents = () => { s.eventsFor = null; render(); };
    const evClose = $('wh-events-close'); if (evClose) { evClose.addEventListener('click', closeEvents); if (justOpened('wh-events-backdrop')) evClose.focus(); }
    onBackdrop('wh-events-backdrop', closeEvents);

    // Secret reveal pop-up
    const copy = $('wh-copy'); if (copy) copy.addEventListener('click', copySecret);
    const dismissReveal = () => { s.revealed = null; render(); };
    const dismiss = $('wh-dismiss'); if (dismiss) dismiss.addEventListener('click', dismissReveal);
    onBackdrop('wh-reveal-backdrop', dismissReveal);

    // Revoke / rotate confirmation
    const cancel = $('wh-cancel'); if (cancel) { cancel.addEventListener('click', () => { s.confirm = null; render(); }); if (justOpened('wh-backdrop')) cancel.focus(); }
    const ok = $('wh-confirm'); if (ok) ok.addEventListener('click', () => { const c = s.confirm; if (c.kind === 'revoke') revokeEndpoint(c.id); else rotate(c.id); });
    onBackdrop('wh-backdrop', () => { if (!s.isBusy) { s.confirm = null; render(); } });
  }

  await load();
});
