// The sections of the API Library, shown as a row of tabs at the top of every page. One list, so every page shows the same.
// Each tab's icon is the same outline style (24px grid, 1.8 stroke) as the side menu in Desk Oracle; kept here so this file needs nothing else.
const ADMIN_TAB = { path: '/developer/admin', label: 'Administration', icon: '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6Z"/>' };
export const TABS = [
  { path: '/developer', label: 'API keys', icon: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3L21 2M17 6l3 3M14 9l2 2"/>' },
  { path: '/developer/webhooks', label: 'Webhooks', icon: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>' },
  { path: '/developer/apps', label: 'Apps', icon: '<path d="M12 2l9 5v10l-9 5-9-5V7z"/>' },
  { path: '/developer/billing', label: 'Plans & billing', icon: '<path d="M6 2h12v20l-2-1.5L14 22l-2-1.5L10 22l-2-1.5L6 22z"/><path d="M9 7h6M9 11h6M9 15h4"/>' },
];

// The Administration tab exists only for administrators (set by app.js after asking the server). Hiding it is a convenience: the
// server refuses every administrator request from anyone else.
let adminVisible = false;
export function setAdminTab(visible) { adminVisible = visible === true; }

/** The tab row for a page; `active` is that page's own path. Links carry real hrefs (so they work with the keyboard and a new tab). */
const tabIcon = (paths) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
export function tabsHtml(active) {
  return `<div class="page-tabs" role="navigation" aria-label="API Library sections">${(adminVisible ? [...TABS, ADMIN_TAB] : TABS).map((t) => `<a href="${t.path}" data-nav="${t.path}" class="page-tab${t.path === active ? ' active' : ''}"${t.path === active ? ' aria-current="page"' : ''}>${tabIcon(t.icon)}<span>${t.label}</span></a>`).join('')}</div>`;
}
