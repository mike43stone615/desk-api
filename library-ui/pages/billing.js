// Plans & billing: the plans on offer, your plan, this month's usage, and invoices.
// Backed by /billing/plans (public), /billing/subscription and /billing/invoices (src/routes/billing.ts).
// Nobody can buy a plan here yet: there is no payment provider, prices are drafts and an administrator assigns plans.
import {
  registerRoute, api, esc, icon, spinnerBtn, friendlyError, reportHandledException, currentEpoch, navigate,
} from '../app.js';
import { tabsHtml } from '../tabs.js';
import { formatMoney, monthLabel, usageShare } from '../format.js';

const num = (n) => Number(n).toLocaleString('en-US');
const limitText = (n, unit) => (n == null ? `No ${unit} limit` : `${num(n)} ${unit}`);
const INVOICE_STATUS = { draft: 'Draft', open: 'Open', paid: 'Paid', void: 'Canceled' };

registerRoute('/developer/billing', async (app) => {
  const myEpoch = currentEpoch();
  const s = {
    isLoading: true, loadError: null, plans: [], note: '',
    sub: null, usage: null, invoices: [], invoiceNote: null,
  };
  const isCurrent = () => currentEpoch() === myEpoch;

  async function load() {
    s.isLoading = true; s.loadError = null; render();
    try {
      const [plans, subRes] = await Promise.all([api('/billing/plans'), api('/billing/subscription')]);
      s.plans = plans.plans || []; s.note = plans.note || '';
      s.sub = subRes.subscription; s.usage = subRes.usage;
      s.invoices = []; s.invoiceNote = null;
      try { s.invoices = (await api('/billing/invoices')).invoices || []; } catch (err) {
        if (err && (err.statusCode === 403 || err.statusCode === 404)) s.invoiceNote = 'We could not load your invoices.'; else throw err;
      }
    } catch (err) { reportHandledException(err, 'loadBilling'); s.loadError = friendlyError(err, 'We could not load your plan.'); }
    finally { if (isCurrent()) { s.isLoading = false; render(); } }
  }

  const planCard = (p, current) => `
    <div class="card plan-card${current ? ' current' : ''}">
      <div class="plan-head"><h3>${esc(p.name)}</h3>${current ? '<span class="meta-chip">Your plan</span>' : ''}</div>
      <div class="plan-price">${p.monthlyPriceCents === 0 ? 'Free' : `${esc(formatMoney(p.monthlyPriceCents))}<span> / month</span>`}</div>
      ${p.description ? `<p class="biz-sub">${esc(p.description)}</p>` : ''}
      <ul class="plan-list">
        <li>${esc(num(p.includedAnalyses))} market analyses a month</li>
        <li>${p.overageCentsPerAnalysis ? `${esc(formatMoney(p.overageCentsPerAnalysis))} for each one beyond that` : 'Stops at the included amount'}</li>
        <li>${esc(limitText(p.perMinuteLimit, 'requests a minute'))}</li>
        <li>Up to ${esc(num(p.maxKeys))} API keys</li>
        <li>Up to ${esc(num(p.maxWebhooks))} webhook endpoints</li>
      </ul>
    </div>`;

  function usageHtml() {
    const u = usageShare(s.usage.marketAnalyses, s.usage.included);
    return `
      <div class="usage-row"><span>${esc(num(s.usage.marketAnalyses))} of ${esc(num(s.usage.included))} market analyses used this month</span><span>${u.percent}%</span></div>
      <div class="usage-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${u.percent}" aria-label="Market analyses used this month"><div class="usage-fill${u.over ? ' over' : ''}" style="width:${u.percent}%"></div></div>
      ${u.over ? `<p class="biz-sub">${esc(num(u.extra))} beyond the included amount${s.sub.plan.overageCentsPerAnalysis ? `, ${esc(formatMoney(s.sub.plan.overageCentsPerAnalysis))} each` : ''}.</p>` : ''}`;
  }

  const invoiceHtml = (inv) => `
    <tr>
      <td>${esc(monthLabel(inv.periodStart))}</td>
      <td>${inv.lines.map((l) => `${esc(l.description)}${l.quantity > 1 ? ` × ${esc(num(l.quantity))}` : ''}`).join('<br>')}</td>
      <td class="num">${esc(formatMoney(inv.subtotalCents, inv.currency))}</td>
      <td>${esc(INVOICE_STATUS[inv.status] || inv.status)}</td>
    </tr>`;

  function render() {
    let body;
    if (s.isLoading) body = `<div class="empty-state">${spinnerBtn(true, '', { dark: true })}</div>`;
    else if (s.loadError) body = `<div class="empty-state">${icon('error_outline')}<div style="margin-top:var(--sp-md);">Plans could not load</div><div class="hint">${esc(s.loadError)}</div><button type="button" class="btn" id="retry-btn" style="margin-top:var(--sp-lg);">${icon('refresh')} Try again</button></div>`;
    else {
      const current = s.sub.plan.id;
      const paused = s.sub.status !== 'active';
      body = `
        <div class="card" style="margin-bottom:var(--sp-lg);">
          <h2 class="biz-section-title">Your plan: ${esc(s.sub.plan.name)}</h2>
          <p class="biz-sub">${paused ? `This plan is ${esc(s.sub.status === 'past_due' ? 'past due' : 'canceled')}. ` : ''}The current period runs ${esc(new Date(s.sub.periodStart).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }))} to ${esc(new Date(s.sub.periodEnd).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }))}.</p>
          ${usageHtml()}
        </div>
        <h2 class="biz-section-title">Plans</h2>
        <p class="biz-sub" style="margin-bottom:var(--sp-md);">${esc(s.note || 'Prices are draft figures; nobody is charged today.')} Plans are assigned by a Desk administrator: contact us to change yours.</p>
        <div class="plan-grid">${s.plans.map((p) => planCard(p, p.id === current)).join('')}</div>
        <h2 class="biz-section-title" style="margin-top:var(--sp-xl);">Invoices</h2>
        ${s.invoiceNote ? `<div class="state-card"><div class="biz-body"><div class="biz-sub">${esc(s.invoiceNote)}</div></div></div>`
          : s.invoices.length ? `<div class="card table-wrap"><table class="plain-table"><thead><tr><th>Month</th><th>What for</th><th class="num">Amount</th><th>Status</th></tr></thead><tbody>${s.invoices.map(invoiceHtml).join('')}</tbody></table></div>`
          : `<div class="state-card"><div class="biz-icon neutral">${icon('receipt_long')}</div><div class="biz-body"><div class="biz-title">No invoices yet</div><div class="biz-sub">Invoices appear here after a month on a paid plan. The Free plan has none.</div></div></div>`}`;
    }
    app.innerHTML = `
      <div class="page">
        <div class="page-head-row"><div class="head-text"><h1>API Library</h1><p>Plans, usage and invoices.</p></div></div>
        ${tabsHtml('/developer/billing')}
        ${body}
      </div>`;
    wire();
  }

  function wire() {
    app.querySelectorAll('[data-nav]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); navigate(a.dataset.nav); }));
    const retry = document.getElementById('retry-btn'); if (retry) retry.addEventListener('click', load);
  }

  await load();
});
