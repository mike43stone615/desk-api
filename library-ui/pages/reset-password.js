// Ported from desk_business's web_app/public/pages/reset-password.js, branded for the API Library: read ?token=,
// submit new password, sign out locally, redirect to /login with a toast.
import { registerRoute, navigate, toast, esc, statusMsg, spinnerBtn, eyeIcon, icon, confirmPasswordReset, signOut, currentEpoch, submitOnEnter, friendlyError, passwordValidationMessage, reportHandledException } from '../app.js';

registerRoute('/reset-password', async (app, params) => {
  const myEpoch = currentEpoch();
  const token = params.get('token');
  const s = { isLoading: false, obscurePassword: true, errorMessage: null, fieldErrors: {}, password: '' };

  async function submit(e) {
    e.preventDefault();
    const pwMsg = !s.password ? 'Enter a password.' : passwordValidationMessage(s.password);
    s.fieldErrors = pwMsg ? { password: pwMsg } : {};
    if (pwMsg) { render(); return; }
    if (!token) {
      s.errorMessage = 'Password reset link is missing or incomplete. Request a new reset link from the sign-in page.';
      render();
      return;
    }
    s.isLoading = true;
    s.errorMessage = null;
    render();
    try {
      await confirmPasswordReset(token, s.password);
      await signOut();
      navigate('/login', { replace: true });
      toast('Password updated. Sign in again.');
      return;
    } catch (err) {
      reportHandledException(err, 'passwordRecoverySubmit');
      s.errorMessage = friendlyError(err, 'We could not update that password. Try again.');
    } finally {
      // On success we've already navigated to /login (see above); route()
      // bumps the epoch synchronously before this runs, so this skips
      // re-rendering the stale reset form over the login page.
      if (currentEpoch() === myEpoch) {
        s.isLoading = false;
        render();
      }
    }
  }

  function render() {
    const animateError = s.errorMessage !== s._lastError;
    s._lastError = s.errorMessage;

    app.innerHTML = `
      <div class="auth-shell">
        <div class="auth-card">
          <img src="/desk_logo.png" alt="" class="auth-card-logo" />
          <h1>Desk <span class="brand-business">API Library</span></h1>
          <p class="subtitle">Create a new password for your account.</p>
          <form id="reset-form" novalidate>
            <div class="field-float has-icon">
              <span class="field-icon">${icon('lock_reset_outlined')}</span>
              <label>New password</label>
              <div class="password-field">
                <input name="password" type="${s.obscurePassword ? 'password' : 'text'}" placeholder=" " value="${esc(s.password)}" autocomplete="new-password" class="${s.fieldErrors.password ? 'invalid' : ''}" />
                <button type="button" class="password-toggle" id="toggle-pw" aria-label="${s.obscurePassword ? 'Show password' : 'Hide password'}" title="${s.obscurePassword ? 'Show password' : 'Hide password'}">${eyeIcon(s.obscurePassword)}</button>
              </div>
            </div>
            ${s.fieldErrors.password ? `<div class="error-text">${esc(s.fieldErrors.password)}</div>` : ''}
            ${s.errorMessage ? statusMsg('error', s.errorMessage, animateError) : ''}
            <button type="submit" class="btn btn-primary btn-block" style="margin-top:var(--sp-xl);" ${s.isLoading ? 'disabled' : ''}>
              ${s.isLoading ? spinnerBtn(true, '') : icon('check_circle_outline')}
              ${s.isLoading ? '' : 'Update password'}
            </button>
          </form>
        </div>
      </div>
    `;
    const form = document.getElementById('reset-form');
    form.addEventListener('submit', submit);
    submitOnEnter(form);
    form.querySelector('input[name="password"]').addEventListener('input', (e) => { s.password = e.target.value; });
    document.getElementById('toggle-pw').addEventListener('click', () => { s.obscurePassword = !s.obscurePassword; render(); });
  }

  render();
});
