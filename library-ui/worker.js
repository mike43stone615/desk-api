// Cloudflare Workers Static Assets already serves any request that matches a real file in this deployment (app.js,
// style.css, pages/*.js, fonts, index.html, ...) directly, without ever running this code. Everything that reaches
// this fetch handler is one of two things:
//   1. one of library-ui's own client-side routes (registerRoute() in app.js/pages/*.js) -- there's no file on disk
//      for "/developer" or "/login", the SPA's own router handles it once index.html's JS has loaded -- so serve
//      the app shell for those.
//   2. real backend traffic that has nothing to do with this static deployment at all: the actual API calls the
//      pages make (/auth, /gateway, /admin, /billing, /oauth, /teams), plus things this project has no opinion on
//      and must not swallow -- health checks, OAuth discovery (/.well-known/*), /docs, /openapi.json, /changelog,
//      /status, etc. -- proxy those straight through to the same origin api.deskbusiness.co's DNS record already
//      points at, unchanged.
//
// The allowlist below is deliberately the *small, closed* set (every registerRoute() call across library-ui) rather
// than trying to enumerate every backend path: missing an SPA route just means one page 404s instead of loading
// (obvious, low-stakes, easy to add); missing a backend prefix here would instead be silent -- a real endpoint would
// wrongly get the app shell back. Keep this in sync with library-ui's own registerRoute() calls.
const SPA_ROUTES = new Set([
  '/',
  '/login',
  '/loading',
  '/confirm-email',
  '/reset-password',
  '/developer',
  '/developer/admin',
  '/developer/apps',
  '/developer/authorize',
  '/developer/billing',
  '/developer/teams',
  '/developer/webhooks',
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (SPA_ROUTES.has(url.pathname)) {
      // Asking Assets for "/index.html" explicitly triggers its own default canonicalizing redirect to "/" (a
      // 307, not the file) -- "/" is what actually serves the content directly.
      return env.ASSETS.fetch(new Request(new URL('/', url), request));
    }
    // api-origin.deskbusiness.co is a second hostname on the same Tunnel, routed to the same local service
    // (localhost:3458) as api.deskbusiness.co -- added specifically so this Worker has a way to reach the real
    // origin that doesn't recurse into itself once it's the thing api.deskbusiness.co's DNS points at.
    const originUrl = new URL(url);
    originUrl.hostname = 'api-origin.deskbusiness.co';
    return fetch(new Request(originUrl, request));
  },
};
