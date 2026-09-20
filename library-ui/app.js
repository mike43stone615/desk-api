// Desk web dashboard — plain JS SPA, no build step, replacing the Flutter
// web build. Ported route-for-route from lib/navigation/app_router.dart and
// lib/core/api_client.dart so the emailed reset-password/confirm-email
// links (real paths, not hash routes — see desk-api's resend.ts) keep
// working. Mobile/desktop stay on Flutter untouched.

// Same-origin ('') by default in local dev: dev-server.mjs proxies the API
// under this same origin to sidestep CORS without touching desk-api's own
// config. Production is genuinely cross-origin to api.deskbusiness.co,
// which already allows the deployed app's origin (see desk-api's
// PRODUCTION_ORIGINS in src/config.ts).
const IS_LOCAL_DEV = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

// This copy is served by desk-api itself (api.deskbusiness.co), so the API is
// same-origin: relative URLs, and the session cookie is first-party.
export const API_BASE = '';

// Error monitoring -- the web app's own Sentry project (separate from the
// Flutter app's, so a browser error doesn't get miscounted against the
// phone/desktop app's error rate; see lib/main.dart for that one). DSNs are
// meant to be embedded in client code same as this -- they only let you
// *send* events in, not read anything back out, same as Flutter's own DSN
// ends up baked into its compiled JS/native bundle either way.
// window.Sentry comes from the CDN bundle index.html loads before this
// module -- guarded in case that request ever fails (an ad blocker, a CDN
// outage), so a missing monitoring script never breaks the app itself.
//
// Nothing personal or secret may leave the browser in a report: addresses lose their query string and fragment (reset and
// confirmation links carry a one-time token there), emails and long secret-looking strings inside messages are blanked,
// and cookies, authorization headers and the signed-in user are never attached. See scrubSentryEvent.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SECRET_RE = /\b(?:deskgw_[A-Za-z0-9]{8,}|[A-Fa-f0-9]{32,}|[A-Za-z0-9_-]{40,})\b/g;
const TOKEN_PARAM_RE = /([?&#](?:token|code|key|password|secret)=)[^&#\s"']+/gi;

/** Removes the query string and fragment from an address (the path alone says where the error happened). */
export function stripUrl(url) {
  if (typeof url !== 'string') return url;
  return url.replace(/[?#].*$/, '');
}

/** Blanks emails, one-time tokens and long secret-looking strings inside free text. */
export function scrubText(text) {
  if (typeof text !== 'string') return text;
  return text.replace(TOKEN_PARAM_RE, '$1[removed]').replace(EMAIL_RE, '[email]').replace(SECRET_RE, '[secret]');
}

/** The Sentry beforeSend / beforeBreadcrumb hook: returns the event with everything personal or secret taken out. */
export function scrubSentryEvent(event) {
  if (!event || typeof event !== 'object') return event;
  if (event.request) {
    event.request.url = stripUrl(event.request.url);
    delete event.request.cookies;
    delete event.request.query_string;
    delete event.request.data;
    if (event.request.headers) {
      for (const name of Object.keys(event.request.headers)) {
        if (/^(cookie|authorization|x-api-key|referer)$/i.test(name)) delete event.request.headers[name];
      }
    }
  }
  delete event.user;
  if (typeof event.message === 'string') event.message = scrubText(event.message);
  for (const ex of event.exception?.values ?? []) ex.value = scrubText(ex.value);
  for (const b of event.breadcrumbs ?? []) {
    if (typeof b.message === 'string') b.message = scrubText(b.message);
    if (b.data) {
      for (const k of ['url', 'from', 'to']) if (typeof b.data[k] === 'string') b.data[k] = stripUrl(b.data[k]);
      delete b.data.body;
    }
  }
  if (event.transaction) event.transaction = stripUrl(event.transaction);
  return event;
}

window.Sentry?.init({
  dsn: 'https://a72a6770bf6b88426769c4a79f429c7c@o4512008263368704.ingest.us.sentry.io/4512108606783488',
  environment: IS_LOCAL_DEV ? 'development' : 'production',
  sendDefaultPii: false,
  beforeSend: scrubSentryEvent,
  beforeBreadcrumb: (breadcrumb) => scrubSentryEvent({ breadcrumbs: [breadcrumb] }).breadcrumbs[0],
});

// Mirrors DeskDiagnostics.logHandledException in the Flutter app: reports a
// caught (not crashed-on) exception, for cases the app already recovered
// from a user's perspective (showed a friendly message) but that are still
// worth knowing about. Never passes anything from the request itself
// (credentials, tokens) -- only the Error object and a short label for
// where it happened.
export function reportHandledException(error, context) {
  console.error(`Desk handled exception in ${context}:`, error);
  // An error that came from the server carries the server's request id: quote it in the report, so the browser error
  // and the server's own log lines for that request can be matched (node scripts/search-logs.mjs --request <id>).
  const tags = { context };
  if (error && typeof error === 'object') {
    if (error.requestId) tags.request_id = String(error.requestId).slice(0, 80);
    if (error.errorCode) tags.error_code = String(error.errorCode).slice(0, 60);
  }
  window.Sentry?.captureException(error, { tags });
}

const ADMIN_EMAILS = ['mike43stone615@gmail.com'];

// How long a "resend" button (confirmation email, password reset email)
// stays disabled after use. UX only -- the server enforces the real limit.
// Matches DeskAppConstants.resendCooldownSeconds in the Flutter app.
export const RESEND_COOLDOWN_SECONDS = 60;

// Debounce before the admin table grid re-queries after a filter edit.
// Matches DeskAppConstants.adminFilterDebounce in the Flutter app.
export const ADMIN_FILTER_DEBOUNCE_MS = 400;

// No session token lives here (or anywhere in JS) any more -- desk-api sets
// it as an httpOnly cookie on sign-in (see session-cookie.ts), which this
// page's own script can't read even if it wanted to, and the browser
// attaches automatically to every api() call below (credentials: 'include').
// `user` is the source of truth for "are we signed in", established each
// boot by asking the server (restoreSession() -> GET /auth/session), not by
// checking for a locally-stored token.
export const state = {
  user: null,
  hasRestoredSession: false,
  pendingPasswordResetEmail: null,
  businessesRefreshToken: 0,
  // The page a signed-out visitor originally asked for (e.g. arriving at
  // /developer from the API landing page), so signing in can take them there.
  returnTo: null,
};

function rememberReturnPath(url) {
  const path = url.pathname + url.search;
  if (path === '/' || path === '/login' || path === '/loading') return;
  state.returnTo = path;
}

// One-shot. Only ever a same-site path: anything else (a full URL, a
// protocol-relative `//host`) is ignored, so this can't become an open redirect.
export function takeReturnPath() {
  const path = state.returnTo;
  state.returnTo = null;
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') ? path : null;
}

export function isAdminEmail(email) {
  return ADMIN_EMAILS.includes((email || '').trim().toLowerCase());
}

export class ApiError extends Error {
  constructor(message, statusCode, { requestId, errorCode } = {}) {
    super(message);
    this.statusCode = statusCode;
    /** The server's id for the request that failed (x-request-id), when the answer carried one. */
    this.requestId = requestId;
    /** The server's stable error code (for example "invalid_credentials"), when the answer carried one. */
    this.errorCode = errorCode;
  }
}

// Auth error codes the server returns as an ApiError's message (see
// desk-api's safeMessage()) that client code branches on by value, rather
// than just displaying -- centralized here so every comparison uses the
// same spelling. Matches DeskAuthErrorCodes in the Flutter app.
export const AUTH_ERROR_CODES = {
  emailNotConfirmed: 'email_not_confirmed',
  passwordResetRequired: 'password_reset_required',
};

// Matches DeskValidators.passwordValidationMessage in the Flutter app.
// Shared by auth.js (sign-up) and reset-password.js (new password) rather
// than each keeping its own copy.
export function passwordValidationMessage(password) {
  if (password.length < 8) return 'Use at least eight characters.';
  if (!/[A-Z]/.test(password)) return 'Include at least one uppercase letter.';
  if (!/[a-z]/.test(password)) return 'Include at least one lowercase letter.';
  if (!/[0-9]/.test(password)) return 'Include at least one number.';
  if (!/[^A-Za-z0-9]/.test(password)) return 'Include at least one symbol.';
  return null;
}

// Mirrors DeskApiClient's JSON body / real-Error-on-non-2xx shape, but auth
// works differently: no bearer header, because there's no token in JS to
// put in one any more. `credentials: 'include'` is what makes the browser
// attach desk-api's httpOnly session cookie on every call, including the
// cross-origin ones (app.deskbusiness.co calling api.deskbusiness.co) —
// desk-api's CORS config already allows credentials for exactly this origin
// (see src/app.ts). A 401 while the app currently believes it's signed in
// means the session itself was rejected — forces a local sign-out, same as
// AuthController.forceSignOutLocally() wired to onSessionExpired in the
// Flutter app's main.dart. A 401 while not signed in (e.g. a bad sign-in
// attempt) is just a normal on-screen error.
export async function api(path, { method = 'GET', body, headers: extraHeaders = {}, timeoutMs = 15000 } = {}) {
  const wasSignedIn = Boolean(state.user);
  const headers = { ...extraHeaders };
  if (body !== undefined) headers['content-type'] = 'application/json';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      credentials: 'include',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new ApiError('The request took too long. Please try again.');
    throw new ApiError('Could not reach the server. Check your connection and try again.');
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let data = {};
  if (text.trim()) {
    try {
      data = JSON.parse(text);
      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('not an object');
      }
    } catch {
      if (!res.ok) throw new ApiError('The server returned an unexpected response.', res.status);
      data = {};
    }
  }

  if (!res.ok) {
    if (res.status === 401 && wasSignedIn) {
      forceSignOutLocally();
    }
    throw new ApiError(data.error || 'Request failed.', res.status, { requestId: res.headers?.get?.('x-request-id') ?? undefined, errorCode: typeof data.code === 'string' ? data.code : undefined });
  }
  return data;
}

// `fallback` covers non-ApiError failures (a network hiccup, a bad JSON
// response) where there's no server-supplied message to show -- callers
// pass their own so the user sees something specific to what they were
// doing ("We could not load your businesses.") rather than a generic line,
// while still going through the one place that knows how to translate a
// real ApiError.
export function friendlyError(err, fallback = 'We could not complete that request. Please try again.') {
  if (err instanceof ApiError && err.message === AUTH_ERROR_CODES.emailNotConfirmed) {
    return 'Confirm your email before signing in.';
  }
  if (err instanceof ApiError) return err.message;
  return fallback;
}

// ---------------- Auth ----------------

// No local token to check before deciding whether to even try any more --
// this always just asks the server, which answers from whatever httpOnly
// cookie the browser did or didn't attach.
export async function restoreSession() {
  try {
    const res = await api('/auth/session');
    state.user = res.user;
  } catch {
    state.user = null;
  } finally {
    state.hasRestoredSession = true;
  }
}

export async function signIn(email, password) {
  try {
    // Cookie transport: this app lives on the httpOnly cookie, so ask the server not to
    // put the session token in the response body where this page's JavaScript could read it.
    const res = await api('/auth/signin', { method: 'POST', body: { email, password }, headers: { 'x-session-transport': 'cookie' } });
    state.pendingPasswordResetEmail = null;
    state.user = res.user;
  } catch (err) {
    if (err instanceof ApiError && err.message === AUTH_ERROR_CODES.passwordResetRequired) {
      state.pendingPasswordResetEmail = email;
      const e = new Error(AUTH_ERROR_CODES.passwordResetRequired);
      e.isPasswordResetRequired = true;
      throw e;
    }
    throw err;
  }
}

export async function signUp({ email, password, firstName, lastName }) {
  const res = await api('/auth/signup', { method: 'POST', body: { email, password, firstName, lastName } });
  return res.message || 'If that email is not already registered, a confirmation link has been sent. Check your inbox before signing in.';
}

export async function sendEmailConfirmation(email) {
  const res = await api('/auth/email-confirmation/request', { method: 'POST', body: { email } });
  return res.message || 'If that email needs confirmation, a new link has been sent.';
}

export async function confirmEmail(token) {
  await api('/auth/email-confirmation/confirm', { method: 'POST', body: { token } });
}

export async function sendPasswordResetEmail(email) {
  const res = await api('/auth/password-reset/request', { method: 'POST', body: { email } });
  return res.message || '';
}

export async function confirmPasswordReset(token, password) {
  await api('/auth/password-reset/confirm', { method: 'POST', body: { token, password } });
}

export async function signOut() {
  try {
    await api('/auth/signout', { method: 'POST', body: {} });
  } finally {
    state.pendingPasswordResetEmail = null;
    state.user = null;
  }
}

// The session cookie itself is httpOnly -- this can't clear it (only a
// Set-Cookie response from the server can, which the real /auth/signout
// call above does). This just makes the app stop believing it's signed in;
// an already-rejected cookie sitting in the browser doing nothing is
// harmless, and the next restoreSession() will get the same 401 again.
export function forceSignOutLocally() {
  state.pendingPasswordResetEmail = null;
  state.user = null;
}

// ---------------- Router ----------------
// Real path-based routing (History API), not hash routes: desk-api emails
// real links like {appBaseUrl}/reset-password?token=... and
// {appBaseUrl}/confirm-email?token=... (see desk-api/src/infrastructure/
// email/resend.ts) that must resolve correctly on direct navigation.

const routes = [];
export function registerRoute(path, render) {
  routes.push({ path, render });
}

// Flutter's widget tree only rebuilds a still-mounted page (every setState
// after an await is `mounted`-gated), so a stale async continuation from a
// page the user has since left can never repaint over the new one. This SPA
// has no such guard by default: navigate() doesn't wait for the outgoing
// page's pending promises to settle, so a `finally { render() }` from the
// OLD page can run after the NEW page has already drawn into #app, silently
// overwriting it. `epoch` is bumped every time route() takes ownership of
// #app; a page module should capture currentEpoch() at the top of its render
// callback and check it again before any render()/DOM-touching call that
// follows an `await` or a timer tick, skipping (and clearing timers) if it
// no longer matches.
let epoch = 0;
export function currentEpoch() {
  return epoch;
}

export function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  route();
}

export function backToBusinesses() {
  state.businessesRefreshToken++;
  navigate('/developer', { replace: true });
}

window.addEventListener('popstate', () => route());

async function route() {
  const url = new URL(location.href);
  const path = url.pathname === '/' ? '/developer' : url.pathname;
  const isTokenRoute = path === '/reset-password' || path === '/confirm-email';
  // The one-time token of an emailed link travels in the address's #fragment (#token=...): browsers never send a
  // fragment to any server, so it is not in Cloudflare's logs, the API's logs or a Referer header. Links sent before
  // this change carry it as ?token= and keep working. Either way it is removed from the address bar as soon as it is
  // read, so it does not linger in the history or get copied along with the page address.
  const params = new URLSearchParams(url.search);
  if (isTokenRoute) {
    for (const [k, v] of new URLSearchParams(url.hash.replace(/^#/, ''))) params.set(k, v);
    if ((url.search || url.hash) && params.has('token')) history.replaceState(null, '', path);
  }

  if (!isTokenRoute) {
    if (!state.hasRestoredSession) {
      if (path !== '/loading') {
        rememberReturnPath(url);
        return navigate('/loading', { replace: true });
      }
    } else {
      const pendingEmail = state.pendingPasswordResetEmail;
      if (pendingEmail && !state.user) {
        const target = `/login?resetEmail=${encodeURIComponent(pendingEmail)}`;
        if (url.pathname + url.search !== target) return navigate(target, { replace: true });
      } else if (!state.user) {
        if (path !== '/login') {
          rememberReturnPath(url);
          return navigate('/login', { replace: true });
        }
      } else if (path === '/login' || path === '/loading') {
        return navigate(takeReturnPath() || '/developer', { replace: true });
      } else if (path === '/admin/tables' && !isAdminEmail(state.user.email)) {
        return navigate('/developer', { replace: true });
      }
    }
  }

  epoch++;
  renderChrome(path);
  const app = document.getElementById('app');
  const match = routes.find((r) => r.path === path);
  if (!match) {
    app.innerHTML = '<div class="empty-state">Not found.</div>';
    return;
  }
  try {
    await match.render(app, params);
  } catch (err) {
    reportHandledException(err, `route:${path}`);
    app.innerHTML = `<div class="page"><div class="card"><b>Something went wrong.</b><p>${esc(err.message || String(err))}</p></div></div>`;
  }
}

function renderChrome(path) {
  const topbar = document.getElementById('topbar');
  const authbox = document.getElementById('authbox');
  const nav = document.getElementById('nav');
  const backBtn = document.getElementById('back-btn');
  const isAuthPage = path === '/login' || path === '/reset-password' || path === '/confirm-email' || path === '/loading';

  // The ribbon is always visible — Flutter shows it everywhere too, just in
  // two forms: AuthBrandRibbon (brand mark only) on auth pages, and the full
  // ProfileRibbon (back arrow, nav, sign-out) once signed in.
  topbar.hidden = false;

  if (isAuthPage || !state.user) {
    backBtn.hidden = true;
    nav.innerHTML = '';
    authbox.innerHTML = '';
    return;
  }

  // Mirrors ProfileRibbon's `onBack` wiring in app_router.dart: only the
  // setup wizard, admin tables and API Library have a meaningful previous
  // page, and all go back to /businesses (CLAUDE.md's ribbon rule requires
  // this arrow).
  // The API Library is this site's only signed-in page: nothing to go back to.
  backBtn.hidden = true;

  // Flutter's ProfileRibbon has no separate topbar nav link — "Switch
  // businesses" only lives inside the profile dropdown below (_ProfileMenu).
  nav.innerHTML = '';

  const name = [state.user.firstName, state.user.lastName].filter(Boolean).join(' ') || '';
  const nameLabel = name || 'Name not set';
  const avatarSource = name || state.user.email;
  const avatarLabel = esc((avatarSource.trim()[0] || 'D').toUpperCase());
  const showSwitchBusiness = false; // no business pages on this site
  const showApiLibrary = false; // already on it

  // Matches ProfileMenu exactly: a pill trigger (avatar + chevron) that
  // opens a dropdown with a "Signed in as" header, then Switch businesses /
  // Sign out — not an always-visible "Sign out" button.
  authbox.innerHTML = `
    <div class="profile-menu">
      <button type="button" class="profile-trigger" id="profile-trigger" aria-label="Profile menu">
        <span class="profile-avatar">${avatarLabel}</span>
        ${icon('expand_more')}
      </button>
      <div class="profile-dropdown" id="profile-dropdown" hidden>
        <div class="profile-header">
          <div class="profile-label">Signed in as</div>
          <div class="profile-name">${esc(nameLabel)}</div>
          <div class="profile-email">${esc(state.user.email)}</div>
        </div>
        <div class="profile-divider"></div>
        ${showSwitchBusiness ? `<button type="button" class="profile-item" id="switch-business-item">${icon('business_outlined')} Switch businesses</button>` : ''}
        ${showApiLibrary ? `<button type="button" class="profile-item" id="api-library-item">${icon('key')} API Library</button>` : ''}
        <button type="button" class="profile-item" id="sign-out-item">${icon('logout')} Sign out</button>
      </div>
    </div>
  `;
  const trigger = document.getElementById('profile-trigger');
  const dropdown = document.getElementById('profile-dropdown');
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.hidden = !dropdown.hidden;
  });
  const switchItem = document.getElementById('switch-business-item');
  if (switchItem) switchItem.addEventListener('click', () => { dropdown.hidden = true; backToBusinesses(); });
  const apiLibraryItem = document.getElementById('api-library-item');
  if (apiLibraryItem) apiLibraryItem.addEventListener('click', () => { dropdown.hidden = true; navigate('/developer'); });
  document.getElementById('sign-out-item').addEventListener('click', async () => {
    dropdown.hidden = true;
    await signOut();
    navigate('/login', { replace: true });
  });
}

// back-btn is a static element in index.html (renderChrome only toggles its
// hidden state, never recreates it), so its listener is wired once here
// rather than inside renderChrome, which would stack a duplicate listener
// on every navigation.
document.getElementById('back-btn').addEventListener('click', () => backToBusinesses());

// #profile-dropdown is recreated on every renderChrome() call (authbox's
// innerHTML is replaced each time), so this outside-click handler is wired
// once, globally, via delegation rather than re-attached per render.
document.addEventListener('click', (e) => {
  const dropdown = document.getElementById('profile-dropdown');
  const trigger = document.getElementById('profile-trigger');
  if (dropdown && !dropdown.hidden && !dropdown.contains(e.target) && e.target !== trigger && !trigger?.contains(e.target)) {
    dropdown.hidden = true;
  }
});

// Intercept same-origin link clicks for client-side navigation.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin) return;
  if (a.target === '_blank' || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(url.pathname + url.search);
});

// ---------------- Shared helpers ----------------

export function toast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// `animate`: pass false when the caller has determined this exact message
// (same kind + same text) was already showing on the previous render — a
// plain innerHTML re-render otherwise recreates this element every time,
// which would replay the fold-in animation even though nothing visibly
// changed (e.g. a resend-cooldown timer ticking once a second).
export function statusMsg(kind, message, animate = true) {
  return `<div class="status-msg ${kind}${animate ? ' status-msg-animate' : ''}">${esc(message)}</div>`;
}

export function spinnerBtn(isLoading, label, { dark = false } = {}) {
  return isLoading ? `<span class="spinner${dark ? ' spinner-dark' : ''}"></span>` : esc(label);
}

// Pressing Enter in a text input should submit the form like clicking its
// submit button would, same as every native HTML form -- wired explicitly
// per form (rather than relying on the browser's own implicit-submission
// behavior) so it works the same regardless of field count or button
// placement. Skips firing while the submit button itself is disabled (e.g.
// mid-request or during a resend cooldown), matching what a real click
// would do.
export function submitOnEnter(form) {
  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn && submitBtn.disabled) return;
    e.preventDefault();
    form.requestSubmit(submitBtn || undefined);
  });
}

// Matches Icons.visibility_outlined / Icons.visibility_off_outlined — the
// icon shows the action a click will take (an open eye when the password is
// hidden means "click to reveal"), same convention Flutter uses.
export function eyeIcon(obscured) {
  return obscured
    ? `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/></svg>`
    : `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/><line x1="2" y1="2" x2="22" y2="22"/></svg>`;
}

// Hand-drawn stand-ins for the specific Material icons Flutter's auth
// screens use (Icons.mail_outline, Icons.login, etc. — see login_page.dart
// / password_recovery_page.dart) so fields and buttons aren't missing the
// icons the real app has everywhere. Not pixel-identical to Material's
// glyphs (no icon font is loaded), just recognizable equivalents at the
// same 18x18 size/stroke weight as eyeIcon().
const ICONS = {
  mail_outline: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  lock_outline: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  person_outline: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-7 8-7s8 3 8 7"/>',
  login: '<path d="M13 4h5a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5"/><path d="M10 8l4 4-4 4"/><path d="M14 12H3"/>',
  person_add_alt_1: '<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3.5-7 7-7s7 3 7 7"/><path d="M18 8v6M15 11h6"/>',
  mark_email_read_outlined: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M3 7l9 6 9-6"/><path d="M14.5 16.5l2 2L21 14"/>',
  mark_email_unread_outlined: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M3 7l9 6 9-6"/><circle cx="19" cy="6" r="3" fill="currentColor" stroke="none"/>',
  help_outline: '<circle cx="12" cy="12" r="10"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.9.4-1.5 1.1-1.5 2.2"/><line x1="12" y1="17.3" x2="12" y2="17.31"/>',
  arrow_back: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
  lock_reset_outlined: '<rect x="4" y="11" width="12" height="9" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.5-2.2"/><path d="M18 4v4h-4"/>',
  check_circle_outline: '<circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-6"/>',
  error_outline: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="7" x2="12" y2="13"/><line x1="12" y1="16.5" x2="12" y2="16.51"/>',
  business_outlined: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M9 20v-4h6v4"/><path d="M9 9h.01M15 9h.01M9 13h.01M15 13h.01"/>',
  apartment_outlined: '<rect x="6" y="2" width="12" height="19" rx="1"/><path d="M9 20v-3h6v3"/><path d="M9 6h.01M9 10h.01M9 14h.01M15 6h.01M15 10h.01M15 14h.01"/>',
  add_business_outlined: '<rect x="3" y="9" width="12" height="11" rx="1"/><path d="M7 20v-4h4v4"/><path d="M7 13h.01M11 13h.01"/><path d="M18 6v8M14 10h8"/>',
  pending_actions_outlined: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4h6"/><circle cx="12" cy="13.5" r="3.5"/><path d="M12 12v1.5l1 1"/>',
  table_chart_outlined: '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 10h18M9 4v16"/>',
  logout: '<path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5"/><path d="M15 16l4-4-4-4"/><path d="M19 12H8"/>',
  expand_more: '<path d="M6 9l6 6 6-6"/>',
  delete_outline: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"/><path d="M10 11v6M14 11v6"/>',
  chevron_right: '<path d="M9 6l6 6-6 6"/>',
  category_outlined: '<path d="M12 2l9 5v10l-9 5-9-5V7z"/>',
  badge_outlined: '<rect x="4" y="7" width="16" height="14" rx="2"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><circle cx="12" cy="13" r="2"/><path d="M9 18c0-1.7 1.3-3 3-3s3 1.3 3 3"/>',
  access_time: '<circle cx="12" cy="12" r="10"/><path d="M12 7v5l3.5 2"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 15.3-6.4L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.3 6.4L3 16"/><path d="M3 21v-5h5"/>',
  arrow_forward: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a7 7 0 0 1 0 14h-6"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a7 7 0 0 0 0 14h6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3L21 2M17 6l3 3M14 9l2 2"/>',
  content_copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  view_column_outlined: '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M9 4v16M15 4v16"/>',
  open_in_full: '<path d="M8 3H3v5"/><path d="M16 21h5v-5"/><path d="M3 3l7 7"/><path d="M21 21l-7-7"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>',
};

// aria-hidden: this SVG never carries its own accessible name (no <title>,
// no role="img") -- it's always either decorative next to real text, or
// inside a button that supplies its own aria-label, so a screen reader
// should skip it rather than announce a blank/generic graphic.
export function icon(name) {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

// ---------------- Boot ----------------

registerRoute('/loading', async (app) => {
  app.innerHTML = '<div class="page" style="display:flex;justify-content:center;padding-top:120px;"><div class="spinner spinner-dark" style="width:28px;height:28px;border-width:3px;"></div></div>';
});

// Dynamic (not static) imports: page modules call registerRoute() at their
// own top level, and import ../app.js back (circular). A static import here
// would evaluate the page modules before this module's own top-level code
// (routes/registerRoute/state) has finished running, hitting a temporal-
// dead-zone ReferenceError on `routes`. Dynamic imports resolve after this
// module's body has fully executed, so the circular reference is safe.
(async function boot() {
  await Promise.all([
    import('./pages/auth.js'),
    import('./pages/developer.js'),
  ]);
  await restoreSession();
  await route();
})();
