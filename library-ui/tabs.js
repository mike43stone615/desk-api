// The sections of the API Library, shown as a row of tabs at the top of every page. One list, so every page shows the same.
const ADMIN_TAB = { path: '/developer/admin', label: 'Administration' };
export const TABS = [
  { path: '/developer', label: 'API keys' },
  { path: '/developer/teams', label: 'Teams' },
  { path: '/developer/webhooks', label: 'Webhooks' },
  { path: '/developer/apps', label: 'Apps' },
  { path: '/developer/billing', label: 'Plans & billing' },
];

// The Administration tab exists only for administrators (set by app.js after asking the server). Hiding it is a convenience: the
// server refuses every administrator request from anyone else.
let adminVisible = false;
export function setAdminTab(visible) { adminVisible = visible === true; }

/** The tab row for a page; `active` is that page's own path. Links carry real hrefs (so they work with the keyboard and a new tab). */
export function tabsHtml(active) {
  return `<div class="page-tabs" role="navigation" aria-label="API Library sections">${(adminVisible ? [...TABS, ADMIN_TAB] : TABS).map((t) => `<a href="${t.path}" data-nav="${t.path}" class="page-tab${t.path === active ? ' active' : ''}"${t.path === active ? ' aria-current="page"' : ''}>${t.label}</a>`).join('')}</div>`;
}
