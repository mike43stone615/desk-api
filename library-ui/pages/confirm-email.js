// Ported from desk_business's web_app/public/pages/confirm-email.js, branded for the API Library: read ?token=,
// call confirm, show pending/success/error, "Sign in" button.
import { registerRoute, navigate, esc, icon, confirmEmail, reportHandledException } from '../app.js';

registerRoute('/confirm-email', async (app, params) => {
  const token = params.get('token') || '';
  let isDone = false;
  let hasError = false;
  let lastRendered = null;

  function render() {
    const iconName = !isDone ? 'mark_email_unread_outlined' : hasError ? 'error_outline' : 'mark_email_read_outlined';
    const title = !isDone ? 'Confirming email' : hasError ? 'Link could not be confirmed' : 'Email confirmed';
    const message = !isDone
      ? 'One moment while we verify your link.'
      : hasError
        ? 'The confirmation link may be expired or already used.'
        : 'You can sign in and start creating API keys.';
    const kind = !isDone ? 'info' : hasError ? 'error' : 'success';
    // Same "don't re-animate unchanged content" rule as statusMsg() in
    // app.js — this page hand-rolls its status box (it needs an icon +
    // title + message, not statusMsg()'s plain-text shape) so it tracks the
    // same thing manually.
    const current = `${kind}|${title}|${message}`;
    const animate = current !== lastRendered;
    lastRendered = current;

    app.innerHTML = `
      <div class="auth-shell">
        <div class="auth-card">
          <img src="/desk_logo.png" alt="" class="auth-card-logo" />
          <h1>Desk <span class="brand-business">API Library</span></h1>
          <p class="subtitle">Confirm this email address to continue with Desk's products.</p>
          <div class="status-msg ${kind}${animate ? ' status-msg-animate' : ''}">
            <span>${icon(iconName)}</span>
            <span><span class="title">${esc(title)}</span>${esc(message)}</span>
          </div>
          <button type="button" class="btn btn-primary btn-block" style="margin-top:var(--sp-xl);" id="signin-btn" ${!isDone ? 'disabled' : ''}>
            ${icon('login')} Sign in
          </button>
        </div>
      </div>
    `;
    document.getElementById('signin-btn').addEventListener('click', () => navigate('/login'));
  }

  render();
  try {
    await confirmEmail(token);
  } catch (err) {
    reportHandledException(err, 'confirmEmail');
    hasError = true;
  } finally {
    isDone = true;
    render();
  }
});
