// The sections of the API Library, shown as a row of tabs at the top of every page. One list, so every page shows the same.
export const TABS = [
  { path: '/developer', label: 'API keys' },
  { path: '/developer/teams', label: 'Teams' },
  { path: '/developer/webhooks', label: 'Webhooks' },
  { path: '/developer/apps', label: 'Apps' },
  { path: '/developer/billing', label: 'Plans & billing' },
];

/** The tab row for a page; `active` is that page's own path. Links carry real hrefs (so they work with the keyboard and a new tab). */
export function tabsHtml(active) {
  return `<div class="page-tabs" role="navigation" aria-label="API Library sections">${TABS.map((t) => `<a href="${t.path}" data-nav="${t.path}" class="page-tab${t.path === active ? ' active' : ''}"${t.path === active ? ' aria-current="page"' : ''}>${t.label}</a>`).join('')}</div>`;
}
