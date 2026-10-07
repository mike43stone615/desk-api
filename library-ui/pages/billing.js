// Plans & billing: the three plans side by side, each showing this person's usage against that plan's limits, and invoices.
// Backed by /billing/plans (public), /billing/subscription and /billing/invoices (src/routes/billing.ts).
// Nobody can buy a plan here yet: there is no payment provider, so "Upgrade" opens a pop-up saying so.
import {
  registerRoute, api, esc, icon, spinnerBtn, friendlyError, reportHandledException, currentEpoch, navigate,
} from '../app.js';
import { tabsHtml } from '../tabs.js';
import { formatMoney, periodText, usageShare } from '../format.js';

const num = (n) => Number(n).toLocaleString('en-US');
const INVOICE_PAGE = 10;
const SERVICES = [
  ['desk_api', 'Desk API'],
  ['registry_api', 'Business Name Registry API'],
  ['market_validation_api', 'Market Validation API'],
  ['total', 'Total API calls'],
];

registerRoute('/developer/billing', async (app) => {
  const myEpoch = currentEpoch();
  const s = {
    isLoading: true, loadError: null, plans: [], sub: null, usage: null,
    invoices: [], invoicesHasMore: false, accountName: '', invoiceNote: null, isLoadingMore: false, moreError: null,
    upgradeTo: null,
  };
  const isCurrent = () => currentEpoch() === myEpoch;

  async function load() {
    s.isLoading = true; s.loadError = null; render();
    try {
      const [plans, subRes] = await Promise.all([api('/billing/plans'), api('/billing/subscription')]);
      s.plans = plans.plans || [];
      s.sub = subRes.subscription; s.usage = subRes.usage;
      s.invoices = []; s.invoiceNote = null; s.invoicesHasMore = false;
      try {
        const page = await api(`/billing/invoices?limit=${INVOICE_PAGE}&offset=0`);
        s.invoices = page.invoices || []; s.invoicesHasMore = Boolean(page.hasMore); s.accountName = page.accountName || '';
      } catch (err) {
        if (err && (err.statusCode === 403 || err.statusCode === 404)) s.invoiceNote = 'We could not load your invoices.'; else throw err;
      }
    } catch (err) { reportHandledException(err, 'loadBilling'); s.loadError = friendlyError(err, 'We could not load your plan.'); }
    finally { if (isCurrent()) { s.isLoading = false; render(); } }
  }

  /** The next page of invoices, added under the ones already shown. */
  async function loadMore() {
    if (s.isLoadingMore) return;
    s.isLoadingMore = true; s.moreError = null; render();
    try {
      const page = await api(`/billing/invoices?limit=${INVOICE_PAGE}&offset=${s.invoices.length}`);
      s.invoices = s.invoices.concat(page.invoices || []); s.invoicesHasMore = Boolean(page.hasMore);
    } catch (err) { reportHandledException(err, 'loadMoreInvoices'); s.moreError = friendlyError(err, 'We could not load more invoices.'); }
    finally { if (isCurrent()) { s.isLoadingMore = false; render(); } }
  }

  const bar = (used, limit, label) => {
    const u = usageShare(used, limit);
    return `
      <div class="usage-row"><span>${esc(num(used))} / ${esc(num(limit))} ${esc(label)}</span></div>
      <div class="usage-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${u.percent}" aria-label="${esc(`${num(used)} of ${num(limit)} ${label}`)}"><div class="usage-fill${u.over ? ' over' : ''}" style="width:${u.percent}%"></div></div>`;
  };

  /** One plan as a column of rows; every card has the same rows in the same order, so they line up across the cards. */
  function planCard(p, current) {
    const u = s.usage;
    const cheaper = p.monthlyPriceCents < s.sub.plan.monthlyPriceCents;
    const action = current
      ? '<span class="meta-chip plan-active">Active</span>'
      : `<button type="button" class="btn${cheaper ? '' : ' btn-primary'} btn-sm" data-upgrade="${esc(p.id)}">${cheaper ? 'Downgrade' : 'Upgrade'}</button>`;
    const perMinute = (k) => (k === 'total' ? p.totalPerMinute : p.servicePerMinute);
    const perMonth = (k) => (k === 'total' ? p.totalPerMonth : p.servicePerMonth);
    return `
      <div class="card plan-card${current ? ' current' : ''}">
        <div class="plan-row plan-head-row">
          <div class="plan-head"><h3>${esc(p.name)}</h3>${action}</div>
          ${current ? `<div class="plan-period">Current period: ${esc(periodText(s.sub.periodStart, s.sub.periodEnd))}</div>` : ''}
        </div>
        <div class="plan-row">
          <div class="plan-price">${esc(formatMoney(p.monthlyPriceCents))}<span> / month</span></div>
          ${p.overageCentsPerCall ? `<div class="biz-sub">+${esc(formatMoney(p.overageCentsPerCall))} per API call beyond limits</div>` : ''}
        </div>
        ${SERVICES.map(([k, label]) => `
          <div class="plan-row">
            <div class="plan-row-title">${esc(label)}</div>
            ${bar(u.callsThisMinute[k], perMinute(k), 'calls in the last minute')}
            ${bar(u.callsThisMonth[k], perMonth(k), 'calls this month')}
          </div>`).join('')}
        <div class="plan-row">
          <div class="plan-row-title">Market analyses</div>
          ${bar(u.marketAnalyses, p.includedAnalyses, 'analyses this month')}
          ${p.overageCentsPerAnalysis ? `<div class="biz-sub">+${esc(formatMoney(p.overageCentsPerAnalysis))} per analysis beyond limits</div>` : ''}
        </div>
        <div class="plan-row"><div class="plan-row-title">API keys</div><div class="biz-sub">${esc(num(u.apiKeys))}/${esc(num(p.maxKeys))} keys created</div></div>
        <div class="plan-row"><div class="plan-row-title">Webhook endpoints</div><div class="biz-sub">${esc(num(u.webhookEndpoints))}/${esc(num(p.maxWebhooks))} webhook endpoints added</div></div>
        <div class="plan-row"><div class="plan-row-title">App registrations</div><div class="biz-sub">${esc(num(u.apps))}/${esc(num(p.maxApps))} apps registered</div></div>
      </div>`;
  }

  const invoiceCard = (inv) => `
    <div class="card invoice-card">${esc(periodText(inv.periodStart, inv.periodEnd))}: ${esc(inv.planName)} Plan ${esc(s.accountName)}</div>`;

  function invoicesHtml() {
    if (s.invoiceNote) return `<div class="state-card"><div class="biz-body"><div class="biz-sub">${esc(s.invoiceNote)}</div></div></div>`;
    if (!s.invoices.length) return `<div class="state-card"><div class="biz-icon neutral">${icon('receipt_long')}</div><div class="biz-body"><div class="biz-title">No invoices yet</div><div class="biz-sub">Invoices appear here after a month on a paid plan.</div></div></div>`;
    return `
      <div class="invoice-list">${s.invoices.map(invoiceCard).join('')}</div>
      ${s.moreError ? `<p class="biz-sub" role="alert">${esc(s.moreError)}</p>` : ''}
      ${s.invoicesHasMore ? `<div class="load-more-row"><button type="button" class="btn" id="load-more-invoices" ${s.isLoadingMore ? 'disabled' : ''}>${s.isLoadingMore ? spinnerBtn(true, '', { dark: true }) : 'Load more'}</button></div>` : ''}`;
  }

  function upgradeModalHtml() {
    const p = s.plans.find((x) => x.id === s.upgradeTo);
    if (!p) return '';
    return `
      <div class="modal-backdrop" id="upgrade-backdrop">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="upgrade-title">
          <h2 id="upgrade-title">Switch to ${esc(p.name)}</h2>
          <p class="modal-text">${esc(p.name)} is ${esc(formatMoney(p.monthlyPriceCents))} a month. Online payment is coming soon; you will be able to change your plan here once it is ready.</p>
          <div class="modal-actions"><button type="button" class="btn" id="upgrade-close">Close</button></div>
        </div>
      </div>`;
  }

  function render() {
    const hadModal = Boolean(document.getElementById('upgrade-backdrop'));
    let body;
    if (s.isLoading) body = `<div class="empty-state">${spinnerBtn(true, '', { dark: true })}</div>`;
    else if (s.loadError) body = `<div class="empty-state">${icon('error_outline')}<div style="margin-top:var(--sp-md);">Plans could not load</div><div class="hint">${esc(s.loadError)}</div><button type="button" class="btn" id="retry-btn" style="margin-top:var(--sp-lg);">${icon('refresh')} Try again</button></div>`;
    else {
      const current = s.sub.plan.id;
      body = `
        <h2 class="biz-section-title">Plans</h2>
        <div class="plan-grid plan-grid-aligned">${s.plans.map((p) => planCard(p, p.id === current)).join('')}</div>
        <h2 class="biz-section-title" style="margin-top:var(--sp-xl);">Invoices</h2>
        ${invoicesHtml()}`;
    }
    app.innerHTML = `
      <div class="page">
        <div class="page-head-row"><div class="head-text"><h1>API Library</h1><p>Plans, usage and invoices.</p></div></div>
        ${tabsHtml('/developer/billing')}
        ${body}
      </div>
      ${s.upgradeTo ? upgradeModalHtml() : ''}`;
    wire(hadModal);
  }

  function wire(hadModal) {
    app.querySelectorAll('[data-nav]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); navigate(a.dataset.nav); }));
    const retry = document.getElementById('retry-btn'); if (retry) retry.addEventListener('click', load);
    const more = document.getElementById('load-more-invoices'); if (more) more.addEventListener('click', loadMore);
    app.querySelectorAll('[data-upgrade]').forEach((b) => b.addEventListener('click', () => { s.upgradeTo = b.dataset.upgrade; render(); }));
    const close = () => { s.upgradeTo = null; render(); };
    const closeBtn = document.getElementById('upgrade-close');
    if (closeBtn) { closeBtn.addEventListener('click', close); if (!hadModal) closeBtn.focus({ preventScroll: true }); }
    const backdrop = document.getElementById('upgrade-backdrop');
    if (backdrop) backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  }

  await load();
});
