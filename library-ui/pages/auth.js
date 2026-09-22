// Ported from lib/screens/auth/login_page.dart — sign-in/sign-up/forgot-password
// as one view with a mode toggle, matching the Flutter version's behavior:
// password_reset_required forces reset mode with the email prefilled,
// email_not_confirmed shows a resend button with a 60s client-side cooldown
// (server is the real enforcement; this is UX only).
import {
  registerRoute, navigate, esc, statusMsg, spinnerBtn, eyeIcon, icon, currentEpoch,
  signIn, signUp, sendPasswordResetEmail, sendEmailConfirmation, ApiError, friendlyError,
  submitOnEnter, RESEND_COOLDOWN_SECONDS, AUTH_ERROR_CODES, passwordValidationMessage,
  reportHandledException, takeReturnPath, state,
} from '../app.js';

const subtitles = {
  signIn: 'Build on business data with your own API keys.',
  signUp: 'Create your account and confirm your email before opening your workspace.',
  resetPassword: 'Enter your account email and we will send a secure password reset link.',
};

// Cooldown deadlines survive navigating away and back (or switching modes)
// by storing the absolute wall-clock end time in sessionStorage instead of
// a plain in-memory counter — a fresh page/route re-render only recreates
// the local `s` object, not this. UX only, same as the cooldown itself; the
// server is the real enforcement either way.
const COOLDOWN_STORAGE_KEYS = {
  resetCooldown: 'desk_cooldown_password_reset',
  confirmationCooldown: 'desk_cooldown_confirmation_resend',
};

function cooldownEndTime(field) {
  try {
    return Number(sessionStorage.getItem(COOLDOWN_STORAGE_KEYS[field])) || 0;
  } catch {
    return 0;
  }
}

function setCooldownEndTime(field, endTime) {
  try {
    sessionStorage.setItem(COOLDOWN_STORAGE_KEYS[field], String(endTime));
  } catch {
    // sessionStorage unavailable (private browsing, etc.) — the cooldown
    // just won't survive navigation this time; server still enforces it.
  }
}

function cooldownSecondsRemaining(field) {
  return Math.max(0, Math.ceil((cooldownEndTime(field) - Date.now()) / 1000));
}

registerRoute('/login', async (app, params) => {
  const myEpoch = currentEpoch();
  const resetEmail = params.get('resetEmail');
  const s = {
    mode: resetEmail ? 'resetPassword' : 'signIn',
    isForcedReset: Boolean(resetEmail),
    isLoading: false,
    obscurePassword: true,
    errorMessage: null,
    successMessage: null,
    fieldErrors: {},
    showResendConfirmation: false,
    isResendingConfirmation: false,
    resetCooldown: cooldownSecondsRemaining('resetCooldown'),
    confirmationCooldown: cooldownSecondsRemaining('confirmationCooldown'),
    values: { firstName: '', lastName: '', email: resetEmail || '', password: '', confirmPassword: '' },
  };
  const cooldownTimers = {};

  // Ticks a field down from whatever's actually left (recomputed from the
  // stored wall-clock deadline each tick, so a backgrounded/throttled tab
  // can't drift it) rather than just decrementing a counter.
  function tickCooldown(field) {
    if (cooldownTimers[field]) clearInterval(cooldownTimers[field]);
    cooldownTimers[field] = setInterval(() => {
      if (currentEpoch() !== myEpoch) { clearInterval(cooldownTimers[field]); return; }
      s[field] = cooldownSecondsRemaining(field);
      if (s[field] <= 0) clearInterval(cooldownTimers[field]);
      updateCooldownUI();
    }, 1000);
  }
  if (s.resetCooldown > 0) tickCooldown('resetCooldown');
  if (s.confirmationCooldown > 0) tickCooldown('confirmationCooldown');

  // The tick only ever changes one of two buttons' text/disabled state -- a full render() here would rebuild the
  // whole form for that, which (while a cooldown from an earlier request is still counting down) tears down and
  // recreates whatever field the person is mid-typing into once a second: it steals focus, and for a type="email"
  // field specifically (which can't have its cursor position restored afterward -- setSelectionRange throws on
  // that input type) it scrambles what they've typed so far, since new characters land wherever the cursor
  // defaulted to rather than where they left off. Updates just the element that actually needs it instead.
  function updateCooldownUI() {
    if (s.mode === 'resetPassword' && !s.isLoading) {
      const submitBtn = document.querySelector('#auth-form button[type="submit"]');
      if (submitBtn) {
        submitBtn.disabled = s.resetCooldown > 0;
        submitBtn.innerHTML = `${icon(primaryIcon())} ${primaryLabel()}`;
      }
    }
    if (s.showResendConfirmation && !s.isResendingConfirmation) {
      const resendBtn = document.getElementById('resend-confirmation-btn');
      if (resendBtn) {
        resendBtn.disabled = s.confirmationCooldown > 0;
        resendBtn.innerHTML = `${icon('mark_email_unread_outlined')} ${s.confirmationCooldown > 0 ? `Resend confirmation email in ${s.confirmationCooldown}s` : 'Resend confirmation email'}`;
      }
    }
  }

  // Callers always render() again themselves right after calling this (in
  // their own finally block) — no render() here, since an immediate one
  // here would update s._last* in app.js's render() before that caller's
  // own render() runs, making the caller's render see "unchanged" and skip
  // the fold-in animation for the message that just appeared.
  function startCooldown(field) {
    setCooldownEndTime(field, Date.now() + RESEND_COOLDOWN_SECONDS * 1000);
    s[field] = RESEND_COOLDOWN_SECONDS;
    tickCooldown(field);
  }

  function setMode(mode) {
    // Leaving the mode that owns the active cooldown: no point still ticking a countdown for a button this mode
    // no longer shows -- but the counter itself isn't reset; it's still backed by the stored deadline and resumes
    // correctly if this mode is entered again.
    Object.values(cooldownTimers).forEach(clearInterval);
    s.mode = mode;
    s.errorMessage = null;
    s.successMessage = null;
    s.fieldErrors = {};
    s.showResendConfirmation = false;
    s.isForcedReset = false;
    s.values.password = '';
    s.values.confirmPassword = '';
    if (mode === 'resetPassword' && s.resetCooldown > 0) tickCooldown('resetCooldown');
    if (mode === 'signIn' && s.confirmationCooldown > 0) tickCooldown('confirmationCooldown');
    render();
  }

  function primaryLabel() {
    if (s.mode === 'resetPassword') return s.resetCooldown > 0 ? `Resend in ${s.resetCooldown}s` : 'Send reset link';
    if (s.mode === 'signUp') return 'Create account';
    return 'Sign in';
  }

  // Matches _primaryActionIcon in login_page.dart.
  function primaryIcon() {
    if (s.mode === 'resetPassword') return 'mark_email_read_outlined';
    if (s.mode === 'signUp') return 'person_add_alt_1';
    return 'login';
  }

  // Checks every field for the current mode and returns one message per
  // invalid field, instead of stopping at the first problem found — so a
  // submit with several empty fields flags all of them at once (matching
  // Flutter's Form.validate(), which runs every TextFormField's validator
  // together). These render inline under their own field; the shared
  // banner below is reserved for things that aren't about one specific
  // field (wrong password, rate limits, network failures).
  function validate() {
    const v = s.values;
    const errors = {};
    const email = v.email.trim();
    if (!email) errors.email = 'Enter your email.';
    else if (!email.includes('@')) errors.email = 'Enter a valid email.';
    if (s.mode === 'signUp') {
      if (!v.firstName.trim()) errors.firstName = 'Enter your first name.';
      if (!v.lastName.trim()) errors.lastName = 'Enter your last name.';
    }
    if (s.mode !== 'resetPassword') {
      if (!v.password) errors.password = 'Enter your password.';
      else if (s.mode === 'signUp') {
        const pwMsg = passwordValidationMessage(v.password);
        if (pwMsg) errors.password = pwMsg;
      }
      if (s.mode === 'signUp') {
        if (!v.confirmPassword) errors.confirmPassword = 'Confirm your password.';
        else if (v.confirmPassword !== v.password) errors.confirmPassword = 'Passwords do not match.';
      }
    }
    return errors;
  }

  async function submit(e) {
    e.preventDefault();
    s.fieldErrors = validate();
    if (Object.keys(s.fieldErrors).length > 0) { render(); return; }
    const email = s.values.email.trim();
    const v = s.values;

    s.isLoading = true;
    s.errorMessage = null;
    s.successMessage = null;
    s.showResendConfirmation = false;
    render();

    try {
      if (s.mode === 'resetPassword') {
        const message = await sendPasswordResetEmail(email);
        s.successMessage = message;
        startCooldown('resetCooldown');
      } else if (s.mode === 'signUp') {
        s.successMessage = await signUp({ email, password: v.password, firstName: v.firstName.trim(), lastName: v.lastName.trim() });
        s.mode = 'signIn';
        v.password = '';
        v.confirmPassword = '';
      } else {
        await signIn(email, v.password);
        navigate(takeReturnPath() || '/developer', { replace: true });
        return;
      }
    } catch (err) {
      if (err.isPasswordResetRequired) {
        navigate(`/login?resetEmail=${encodeURIComponent(email)}`, { replace: true });
        return;
      }
      reportHandledException(err, 'authSubmit');
      s.errorMessage = friendlyError(err);
      s.showResendConfirmation = err instanceof ApiError && err.message === AUTH_ERROR_CODES.emailNotConfirmed;
    } finally {
      // On success we've already navigated away (see the `return`s above);
      // route() bumps the epoch synchronously before this finally runs, so
      // this skips re-rendering the old form over whatever page is now live.
      if (currentEpoch() === myEpoch) {
        s.isLoading = false;
        render();
      }
    }
  }

  async function resendConfirmation() {
    s.isResendingConfirmation = true;
    render();
    try {
      const message = await sendEmailConfirmation(s.values.email.trim());
      s.successMessage = message;
      s.errorMessage = null;
      startCooldown('confirmationCooldown');
    } catch (err) {
      reportHandledException(err, 'resendConfirmationEmail');
      s.errorMessage = friendlyError(err);
    } finally {
      if (currentEpoch() === myEpoch) {
        s.isResendingConfirmation = false;
        render();
      }
    }
  }

  function render() {
    const isSignUp = s.mode === 'signUp';
    const isReset = s.mode === 'resetPassword';

    // Only animate a status message in when its (kind, text) actually
    // differs from what was showing on the previous render — see the
    // `animate` param on statusMsg() in app.js.
    // One-time explanation when the session ended while the person was using the page (see api() in app.js).
    if (state.sessionEndedNotice) {
      state.sessionEndedNotice = false;
      if (!s.errorMessage && !s.successMessage) s.errorMessage = 'Your session ended, so you were signed out. Sign in again and you will come back to where you were.';
    }
    const forcedResetText = s.isForcedReset ? 'Your account needs a new password before you can sign in. Enter your email to receive a reset link.' : null;
    const animateForcedReset = forcedResetText !== s._lastForcedReset;
    s._lastForcedReset = forcedResetText;
    // errorMessage and successMessage are mutually exclusive here, so they
    // share one slot below the fields: it never straddles the
    // resend-confirmation button (the button always renders directly below
    // whichever message is showing, never between an error above and a
    // success below).
    const displayedMessage = s.errorMessage ?? s.successMessage;
    const displayedKind = s.errorMessage ? 'error' : 'success';
    const animateDisplayed = displayedMessage !== s._lastDisplayed;
    s._lastDisplayed = displayedMessage;

    const invalidCls = (name) => (s.fieldErrors[name] ? 'invalid' : '');
    const errText = (name) => (s.fieldErrors[name] ? `<div class="error-text">${esc(s.fieldErrors[name])}</div>` : '');

    app.innerHTML = `
      <div class="auth-shell">
        <div class="auth-card">
          <img src="/desk_logo.png" alt="" class="auth-card-logo" />
          <h1>Desk <span class="brand-business">API Library</span></h1>
          <p class="subtitle">${esc(subtitles[s.mode])}</p>
          ${/* Matches _StatusMessage(isError: false) in login_page.dart exactly —
               that widget only has error(red)/success(green) states, so the
               forced-reset notice really is green, not a neutral gray banner. */
            forcedResetText ? statusMsg('success', forcedResetText, animateForcedReset) : ''}
          <form id="auth-form" novalidate>
            ${isSignUp ? `
              <div class="row-2">
                <div>
                  <div class="field-float has-icon"><span class="field-icon">${icon('person_outline')}</span><label>First name</label><input name="firstName" placeholder=" " value="${esc(s.values.firstName)}" autocomplete="given-name" class="${invalidCls('firstName')}" /></div>
                  ${errText('firstName')}
                </div>
                <div>
                  <div class="field-float has-icon"><span class="field-icon">${icon('person_outline')}</span><label>Last name</label><input name="lastName" placeholder=" " value="${esc(s.values.lastName)}" autocomplete="family-name" class="${invalidCls('lastName')}" /></div>
                  ${errText('lastName')}
                </div>
              </div>
            ` : ''}
            <div class="field-float has-icon">
              <span class="field-icon">${icon('mail_outline')}</span>
              <label>Email</label>
              <input name="email" type="email" placeholder=" " value="${esc(s.values.email)}" autocomplete="email" class="${invalidCls('email')}" />
            </div>
            ${errText('email')}
            ${!isReset ? `
              <div class="field-float has-icon">
                <span class="field-icon">${icon('lock_outline')}</span>
                <label>Password</label>
                <div class="password-field">
                  <input name="password" type="${s.obscurePassword ? 'password' : 'text'}" placeholder=" " value="${esc(s.values.password)}" autocomplete="${isSignUp ? 'new-password' : 'current-password'}" class="${invalidCls('password')}" />
                  <button type="button" class="password-toggle" id="toggle-pw" aria-label="${s.obscurePassword ? 'Show password' : 'Hide password'}" title="${s.obscurePassword ? 'Show password' : 'Hide password'}">${eyeIcon(s.obscurePassword)}</button>
                </div>
              </div>
              ${errText('password')}
            ` : ''}
            ${isSignUp ? `
              <div class="field-float has-icon">
                <span class="field-icon">${icon('lock_outline')}</span>
                <label>Confirm password</label>
                <input name="confirmPassword" type="${s.obscurePassword ? 'password' : 'text'}" placeholder=" " value="${esc(s.values.confirmPassword)}" autocomplete="new-password" class="${invalidCls('confirmPassword')}" />
              </div>
              ${errText('confirmPassword')}
            ` : ''}
            ${displayedMessage ? statusMsg(displayedKind, displayedMessage, animateDisplayed) : ''}
            ${s.showResendConfirmation ? `
              <button type="button" class="btn btn-primary btn-block" id="resend-confirmation-btn" style="margin-top:var(--sp-sm);" ${(s.isResendingConfirmation || s.confirmationCooldown > 0) ? 'disabled' : ''}>
                ${s.isResendingConfirmation ? spinnerBtn(true, '') : icon('mark_email_unread_outlined')}
                ${s.isResendingConfirmation ? '' : (s.confirmationCooldown > 0 ? `Resend confirmation email in ${s.confirmationCooldown}s` : 'Resend confirmation email')}
              </button>
            ` : ''}
            <button type="submit" class="btn btn-primary btn-block" style="margin-top:var(--sp-xl);" ${s.isLoading || (isReset && s.resetCooldown > 0) ? 'disabled' : ''}>
              ${s.isLoading ? spinnerBtn(true, '') : icon(primaryIcon())}
              ${s.isLoading ? '' : primaryLabel()}
            </button>
            ${!isSignUp ? `
              <button type="button" class="btn-link" id="toggle-reset-btn" style="display:flex;width:100%;margin-top:var(--sp-sm);" ${s.isLoading ? 'disabled' : ''}>
                ${icon(isReset ? 'arrow_back' : 'help_outline')}
                ${isReset ? 'Back to sign in' : 'Forgot password?'}
              </button>
            ` : ''}
            <button type="button" class="btn-link" id="toggle-signup-btn" style="display:flex;width:100%;margin-top:var(--sp-xs);" ${s.isLoading ? 'disabled' : ''}>
              ${isSignUp ? 'Already have an account? Sign in' : 'Need an account? Create one'}
            </button>
          </form>
        </div>
      </div>
    `;

    const form = document.getElementById('auth-form');
    form.addEventListener('submit', submit);
    submitOnEnter(form);
    form.querySelectorAll('input').forEach((input) => {
      input.addEventListener('input', () => { s.values[input.name] = input.value; });
    });
    const toggle = document.getElementById('toggle-pw');
    if (toggle) toggle.addEventListener('click', () => { s.obscurePassword = !s.obscurePassword; render(); });
    const resend = document.getElementById('resend-confirmation-btn');
    if (resend) resend.addEventListener('click', resendConfirmation);
    const toggleReset = document.getElementById('toggle-reset-btn');
    if (toggleReset) toggleReset.addEventListener('click', () => setMode(isReset ? 'signIn' : 'resetPassword'));
    document.getElementById('toggle-signup-btn').addEventListener('click', () => setMode(isSignUp ? 'signIn' : 'signUp'));
  }

  render();
});
