// Plans & billing: the three plans side by side, each showing this person's usage against that plan's limits, and invoices.
// Backed by /billing/plans (public), /billing/subscription and /billing/invoices (src/routes/billing.ts).
// Nobody can buy a plan here yet: there is no payment provider, so "Upgrade" opens a pop-up saying so.
import {
  registerRoute, api, esc, icon, spinnerBtn, friendlyError, reportHandledException, currentEpoch, navigate,
} from '../app.js';
import { tabsHtml } from '../tabs.js';
import { formatMoney, periodText, periodShort, usageShare } from '../format.js';

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
    upgradeTo: null, viewInvoice: null,
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

  /** A usage bar and its caption, drawn like the progress bars in the Webhooks "Deliveries" pop-up (thin pill bar, small faint text under it). */
  const bar = (used, limit, label) => {
    const u = usageShare(used, limit);
    return `
      <div class="plan-usage">
        <div class="delivery-progress${u.over ? ' failed' : ''}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${u.percent}" aria-label="${esc(`${num(used)} of ${num(limit)} ${label}`)}"><div class="delivery-fill" style="width:${u.percent}%"></div></div>
        <div class="delivery-next">${esc(num(used))} / ${esc(num(limit))} ${esc(label)}</div>
      </div>`;
  };

  /** One plan as a column of rows; every card has the same rows in the same order, so they line up across the cards. */
  function planCard(p, current) {
    const u = s.usage;
    const cheaper = p.monthlyPriceCents < s.sub.plan.monthlyPriceCents;
    // The three states are the same pill; only the color says which one it is.
    const action = current
      ? '<span class="plan-pill active">Active</span>'
      : `<button type="button" class="plan-pill ${cheaper ? 'downgrade' : 'upgrade'}" data-upgrade="${esc(p.id)}">${cheaper ? 'Downgrade' : 'Upgrade'}</button>`;
    const perMinute = (k) => (k === 'total' ? p.totalPerMinute : p.servicePerMinute);
    const perMonth = (k) => (k === 'total' ? p.totalPerMonth : p.servicePerMonth);
    return `
      <div class="card plan-card${current ? ' current' : ''}">
        <div class="plan-row plan-head-row">
          <div class="plan-head"><h3>${esc(p.name)}</h3>${action}</div>
          ${current ? `<div class="plan-period">Current period: ${esc(periodShort(s.sub.periodStart, s.sub.periodEnd))}</div>` : ''}
        </div>
        <div class="plan-row">
          <div class="plan-price">${esc(formatMoney(p.monthlyPriceCents))}<span> / month</span></div>
          ${p.overageCentsPerCall ? `<div class="biz-sub">+${esc(formatMoney(p.overageCentsPerCall))} per API call beyond limits</div>` : ''}
          ${p.overageCentsPerAnalysis ? `<div class="biz-sub">+${esc(formatMoney(p.overageCentsPerAnalysis))} per uncached market validation analysis beyond limits</div>` : ''}
        </div>
        ${SERVICES.map(([k, label]) => `
          <div class="plan-row">
            <div class="plan-row-title">${esc(label)}</div>
            ${bar(u.callsThisMinute[k], perMinute(k), 'calls in the last minute')}
            ${bar(u.callsThisMonth[k], perMonth(k), 'calls this month')}
            ${k === 'market_validation_api' ? bar(u.marketAnalyses, p.includedAnalyses, 'uncached market validation analyses this month') : ''}
          </div>`).join('')}
        <div class="plan-row"><div class="plan-row-title">API keys</div><div class="biz-sub">${esc(num(u.apiKeys))}/${esc(num(p.maxKeys))} keys created</div></div>
        <div class="plan-row"><div class="plan-row-title">Webhook endpoints</div><div class="biz-sub">${esc(num(u.webhookEndpoints))}/${esc(num(p.maxWebhooks))} webhook endpoints added</div></div>
        <div class="plan-row"><div class="plan-row-title">App registrations</div><div class="biz-sub">${esc(num(u.apps))}/${esc(num(p.maxApps))} apps registered</div></div>
      </div>`;
  }

  const STATUS_TEXT = { draft: 'Draft', open: 'Unpaid', paid: 'Paid', void: 'Void' };
  const invoiceTitle = (inv) => `${periodText(inv.periodStart, inv.periodEnd)}: ${inv.planName} Plan ${s.accountName}`;

  const invoiceCard = (inv) => `
    <div class="card invoice-card">
      <div class="invoice-main">
        <div>${esc(invoiceTitle(inv))}</div>
        <div class="biz-sub">${esc(formatMoney(inv.subtotalCents, inv.currency))} · ${esc(STATUS_TEXT[inv.status] || inv.status)}</div>
      </div>
      <div class="invoice-actions">
        <button type="button" class="btn btn-sm" data-view-invoice="${esc(inv.id)}" aria-label="View the invoice for ${esc(periodText(inv.periodStart, inv.periodEnd))}">View</button>
        <button type="button" class="btn btn-sm" data-print-invoice="${esc(inv.id)}" aria-label="Print the invoice for ${esc(periodText(inv.periodStart, inv.periodEnd))} to PDF">${icon('print')} Print to PDF</button>
      </div>
    </div>`;

  /** The invoice as a page: who, when, what for, each line, and the total. Shown in a pop-up and used for printing. */
  function invoiceDocHtml(inv) {
    return `
      <div class="invoice-doc">
        <div class="invoice-doc-head">
          <div><div class="invoice-doc-kicker">Desk API Library</div><h2 class="invoice-doc-title">Invoice</h2></div>
          <div class="invoice-doc-status">${esc(STATUS_TEXT[inv.status] || inv.status)}</div>
        </div>
        <dl class="invoice-doc-meta">
          <div><dt>Billed to</dt><dd>${esc(s.accountName)}</dd></div>
          <div><dt>Period</dt><dd>${esc(periodText(inv.periodStart, inv.periodEnd))}</dd></div>
          <div><dt>Plan</dt><dd>${esc(inv.planName)}</dd></div>
          <div><dt>Invoice number</dt><dd>${esc(inv.id.replace(/^sample-/, '').slice(0, 8).toUpperCase())}</dd></div>
        </dl>
        <table class="plain-table invoice-doc-table">
          <thead><tr><th>Description</th><th class="num">Quantity</th><th class="num">Unit price</th><th class="num">Amount</th></tr></thead>
          <tbody>${inv.lines.map((l) => `<tr><td>${esc(l.description)}</td><td class="num">${esc(num(l.quantity))}</td><td class="num">${esc(formatMoney(l.unitCents, inv.currency))}</td><td class="num">${esc(formatMoney(l.totalCents, inv.currency))}</td></tr>`).join('')}</tbody>
          <tfoot><tr><td colspan="3">Total</td><td class="num">${esc(formatMoney(inv.subtotalCents, inv.currency))}</td></tr></tfoot>
        </table>
      </div>`;
  }

  /** Opens the browser's print dialog for one invoice: choose "Save as PDF" there. Only the invoice is printed. */
  function printInvoice(inv) {
    const sheet = document.createElement('div');
    sheet.id = 'print-invoice';
    sheet.innerHTML = invoiceDocHtml(inv);
    document.body.appendChild(sheet);
    const done = () => { sheet.remove(); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print();
  }

  function invoiceModalHtml() {
    const inv = s.invoices.find((x) => x.id === s.viewInvoice);
    if (!inv) return '';
    return `
      <div class="modal-backdrop" id="invoice-backdrop">
        <div class="modal modal-wide" role="dialog" aria-modal="true" aria-label="Invoice">
          ${invoiceDocHtml(inv)}
          <div class="modal-actions">
            <button type="button" class="btn" id="invoice-close">Close</button>
            <button type="button" class="btn btn-primary" id="invoice-print">${icon('print')} Print to PDF</button>
          </div>
        </div>
      </div>`;
  }

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
      ${s.upgradeTo ? upgradeModalHtml() : ''}
      ${s.viewInvoice ? invoiceModalHtml() : ''}`;
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

    const invoiceOf = (id) => s.invoices.find((x) => x.id === id);
    app.querySelectorAll('[data-view-invoice]').forEach((b) => b.addEventListener('click', () => { s.viewInvoice = b.dataset.viewInvoice; render(); }));
    app.querySelectorAll('[data-print-invoice]').forEach((b) => b.addEventListener('click', () => { const inv = invoiceOf(b.dataset.printInvoice); if (inv) printInvoice(inv); }));
    const closeInvoice = () => { s.viewInvoice = null; render(); };
    const invClose = document.getElementById('invoice-close'); if (invClose) invClose.addEventListener('click', closeInvoice);
    const invPrint = document.getElementById('invoice-print'); if (invPrint) invPrint.addEventListener('click', () => { const inv = invoiceOf(s.viewInvoice); if (inv) printInvoice(inv); });
    const invBackdrop = document.getElementById('invoice-backdrop');
    if (invBackdrop) invBackdrop.addEventListener('click', (e) => { if (e.target === invBackdrop) closeInvoice(); });
  }

  await load();
});
