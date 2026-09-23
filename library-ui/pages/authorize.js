// The consent screen of "Sign in with Desk": a third-party app asked to read part of the signed-in person's account. Reached
// from GET /oauth/authorize (which has already checked the request). Approve sends the browser back to the app with a
// one-time code; Deny sends it back with an error. Nothing is granted until Approve.
import { registerRoute, api, esc, icon, spinnerBtn, statusMsg, friendlyError, reportHandledException, currentEpoch, state } from '../app.js';

const KEYS = ['response_type', 'client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method'];

registerRoute('/developer/authorize', async (app) => {
  const myEpoch = currentEpoch();
  const q = new URLSearchParams(location.search);
  const params = Object.fromEntries(KEYS.filter((k) => q.has(k)).map((k) => [k, q.get(k)]));
  const s = { isLoading: true, info: null, error: null, deciding: null };
  const isCurrent = () => currentEpoch() === myEpoch;

  function render() {
    let body;
    if (s.isLoading) {
      body = `<div class="empty-state">${spinnerBtn(true, '', { dark: true })}<div style="margin-top:var(--sp-md);">Checking the request…</div></div>`;
    } else if (s.error) {
      body = `<div class="empty-state">${icon('error_outline')}<div style="margin-top:var(--sp-md);">This request cannot be approved</div><div class="hint">${esc(s.error)}</div></div>`;
    } else {
      body = `
        <div class="card">
          <h2 class="biz-section-title">${esc(s.info.app.name)} wants to access your Desk account</h2>
          <p class="biz-sub" style="margin-bottom:var(--sp-lg);">It will be able to:</p>
          <ul class="consent-list">${s.info.scopes.map((x) => `<li>${icon('check_circle_outline')} <span>${esc(x.description)}</span></li>`).join('')}</ul>
          <p class="biz-sub" style="margin:var(--sp-lg) 0;">It cannot change anything, see your password, or create keys. You can take its access away at any time from your list of authorized apps.</p>
          ${s.decisionError ? statusMsg('error', s.decisionError, true) : ''}
          <div style="display:flex;gap:var(--sp-sm);flex-wrap:wrap;">
            <button type="button" class="btn btn-primary" id="approve-btn" ${s.deciding ? 'disabled' : ''}>${s.deciding === 'approve' ? spinnerBtn(true, '') : 'Approve'}</button>
            <button type="button" class="btn" id="deny-btn" ${s.deciding ? 'disabled' : ''}>Deny</button>
          </div>
        </div>`;
    }
    app.innerHTML = `<div class="page"><div class="page-head-row"><div class="head-text"><h1>Authorize app</h1><p>Signed in as ${esc(state.user?.email ?? 'you')}. Only approve apps you trust.</p></div></div>${body}</div>`;
    const decide = (approve) => async () => {
      s.deciding = approve ? 'approve' : 'deny';
      s.decisionError = null;
      render();
      try {
        const res = await api('/oauth/authorize/decision', {
          method: 'POST',
          body: { clientId: params.client_id, redirectUri: params.redirect_uri, scope: params.scope, state: params.state, codeChallenge: params.code_challenge, codeChallengeMethod: params.code_challenge_method, responseType: params.response_type, approve },
        });
        location.assign(res.redirectTo);
      } catch (err) {
        reportHandledException(err, 'oauthDecision');
        s.decisionError = friendlyError(err, 'We could not complete that. Please try again.');
        s.deciding = null;
        if (isCurrent()) render();
      }
    };
    const a = document.getElementById('approve-btn');
    if (a) a.addEventListener('click', decide(true));
    const d = document.getElementById('deny-btn');
    if (d) d.addEventListener('click', decide(false));
  }

  render();
  try {
    s.info = await api(`/oauth/authorize/info?${new URLSearchParams(params).toString()}`);
  } catch (err) {
    s.error = friendlyError(err, 'We could not check this request.');
  } finally {
    s.isLoading = false;
    if (isCurrent()) render();
  }
});
