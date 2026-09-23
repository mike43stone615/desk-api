// Teams — people sharing API keys and one allowance. Backed by desk-api's /teams routes (src/routes/teams.ts) and the team
// options of /gateway/api-keys. Everything here needs a signed-in session. Who may do what is decided by the server;
// ../team-rules.js only hides buttons that would be refused.
import {
  registerRoute, api, esc, icon, spinnerBtn, statusMsg, friendlyError, toast,
  reportHandledException, currentEpoch, submitOnEnter, navigate, state,
} from '../app.js';
import { tabsHtml } from '../tabs.js';
import {
  ROLES, ROLE_LABELS, ROLE_HELP, grantableRoles, canManageMember, canCreateKeys, canDeleteTeam, teamKeyServices,
} from '../team-rules.js';

const MAX_NAME_LENGTH = 64;

function newIdempotencyKey() {
  const c = globalThis.crypto;
  return c && typeof c.randomUUID === 'function' ? c.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

registerRoute('/developer/teams', async (app) => {
  const myEpoch = currentEpoch();
  const s = {
    isLoading: true,
    loadError: null,
    teams: [],
    invites: [],
    services: [],
    selectedId: null,
    detail: null, // { team, members, emailInvites }
    keys: [],
    newName: '',
    isCreatingTeam: false,
    teamError: null,
    inviteEmail: '',
    inviteRole: 'developer',
    isInviting: false,
    inviteMessage: null,
    inviteError: null,
    keyLabel: '',
    keyServices: new Set(),
    isCreatingKey: false,
    keyError: null,
    keyAttempt: null,
    revealed: null,
    confirm: null, // { kind: 'revokeKey' | 'removeMember' | 'withdrawInvite' | 'leave' | 'deleteTeam', ... }
    isBusy: false,
    _lastKeyError: null,
    _lastTeamError: null,
  };

  const isCurrent = () => currentEpoch() === myEpoch;
  const serviceName = (id) => (s.services.find((x) => x.service === id) || {}).name || id;
  const myRole = () => (s.detail ? s.detail.team.role : null);
  const post = (path, body, headers) => api(path, { method: 'POST', body, headers });

  async function loadOverview() {
    const [list, inv, catalog] = await Promise.all([api('/teams'), api('/teams/invites'), api('/gateway/services')]);
    s.teams = list.teams || [];
    s.invites = inv.invites || [];
    s.services = catalog.services || [];
  }

  async function loadDetail() {
    if (!s.selectedId) { s.detail = null; s.keys = []; return; }
    try {
      const [detail, keys] = await Promise.all([api(`/teams/${encodeURIComponent(s.selectedId)}`), api(`/gateway/api-keys?teamId=${encodeURIComponent(s.selectedId)}`)]);
      s.detail = detail;
      s.keys = keys.apiKeys || [];
    } catch (err) {
      // The team is gone, or the person is no longer in it: back to the list.
      s.selectedId = null; s.detail = null; s.keys = [];
      throw err;
    }
  }

  async function load() {
    s.isLoading = true;
    s.loadError = null;
    render();
    try {
      await loadOverview();
      await loadDetail();
    } catch (err) {
      reportHandledException(err, 'loadTeams');
      s.loadError = friendlyError(err, 'We could not load your teams.');
    } finally {
      if (isCurrent()) { s.isLoading = false; render(); }
    }
  }

  async function guarded(what, fn, failText) {
    if (s.isBusy) return;
    s.isBusy = true;
    render();
    try {
      await fn();
    } catch (err) {
      reportHandledException(err, what);
      toast(friendlyError(err, failText), true);
    } finally {
      s.confirm = null;
      s.isBusy = false;
      if (isCurrent()) render();
    }
  }

  async function createTeam(e) {
    e.preventDefault();
    if (!s.newName.trim()) { s.teamError = 'Give the team a name.'; render(); return; }
    s.isCreatingTeam = true; s.teamError = null; render();
    try {
      const res = await post('/teams', { name: s.newName.trim() });
      s.newName = '';
      await loadOverview();
      s.selectedId = res.team.id;
      await loadDetail();
    } catch (err) {
      reportHandledException(err, 'createTeam');
      s.teamError = friendlyError(err, 'We could not create that team. Please try again.');
    } finally {
      s.isCreatingTeam = false;
      if (isCurrent()) render();
    }
  }

  async function openTeam(id) {
    s.selectedId = id; s.detail = null; s.keys = []; s.revealed = null;
    s.inviteMessage = null; s.inviteError = null; s.keyError = null;
    s.isLoading = true; render();
    try { await loadDetail(); } catch (err) { toast(friendlyError(err, 'Could not open that team.'), true); }
    finally { if (isCurrent()) { s.isLoading = false; render(); } }
  }

  async function answerInvite(id, accept) {
    await guarded('answerTeamInvite', async () => {
      if (accept) await post(`/teams/invites/${encodeURIComponent(id)}/accept`, {});
      else await api(`/teams/invites/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await loadOverview();
      toast(accept ? 'You joined the team.' : 'Invitation declined.');
    }, 'Could not answer that invitation.');
  }

  async function invite(e) {
    e.preventDefault();
    if (!s.inviteEmail.trim()) { s.inviteError = 'Enter an email address.'; s.inviteMessage = null; render(); return; }
    s.isInviting = true; s.inviteError = null; s.inviteMessage = null; render();
    try {
      const res = await post(`/teams/${encodeURIComponent(s.selectedId)}/members`, { email: s.inviteEmail.trim(), role: s.inviteRole });
      s.inviteEmail = '';
      s.inviteMessage = res.message || 'Invitation sent.';
      await loadDetail();
    } catch (err) {
      reportHandledException(err, 'inviteTeamMember');
      s.inviteError = friendlyError(err, 'We could not send that invitation.');
    } finally {
      s.isInviting = false;
      if (isCurrent()) render();
    }
  }

  async function changeRole(membershipId, role) {
    await guarded('changeTeamRole', async () => {
      await api(`/teams/${encodeURIComponent(s.selectedId)}/members/${encodeURIComponent(membershipId)}`, { method: 'PATCH', body: { role } });
      await loadDetail();
      await loadOverview();
      toast('Role changed.');
    }, 'Could not change that role.');
  }

  async function removeMember(membershipId, leaving) {
    await guarded('removeTeamMember', async () => {
      await api(`/teams/${encodeURIComponent(s.selectedId)}/members/${encodeURIComponent(membershipId)}`, { method: 'DELETE' });
      if (leaving) { s.selectedId = null; s.detail = null; s.keys = []; await loadOverview(); toast('You left the team.'); }
      else { await loadDetail(); await loadOverview(); toast('Removed.'); }
    }, 'Could not remove that person.');
  }

  async function withdrawInvite(inviteId) {
    await guarded('withdrawTeamEmailInvite', async () => {
      await api(`/teams/${encodeURIComponent(s.selectedId)}/email-invites/${encodeURIComponent(inviteId)}`, { method: 'DELETE' });
      await loadDetail();
      toast('Invitation withdrawn.');
    }, 'Could not withdraw that invitation.');
  }

  async function revokeKey(id) {
    await guarded('revokeTeamKey', async () => {
      await api(`/gateway/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
      s.keys = s.keys.filter((k) => k.id !== id);
      if (s.revealed && s.revealed.id === id) s.revealed = null;
      await loadOverview();
      toast('Key revoked.');
    }, 'Could not revoke that key. You can revoke keys you made; admins and owners can revoke any.');
  }

  async function deleteTeam() {
    await guarded('deleteTeam', async () => {
      await api(`/teams/${encodeURIComponent(s.selectedId)}`, { method: 'DELETE' });
      s.selectedId = null; s.detail = null; s.keys = [];
      await loadOverview();
      toast('Team deleted, and its keys revoked.');
    }, 'Could not delete that team.');
  }

  async function createKey(e) {
    e.preventDefault();
    if (!s.keyLabel.trim()) { s.keyError = 'Give this key a name.'; render(); return; }
    if (s.keyServices.size === 0) { s.keyError = 'Choose at least one API.'; render(); return; }
    s.isCreatingKey = true; s.keyError = null; render();
    try {
      const services = teamKeyServices(s.services).map((x) => x.service).filter((id) => s.keyServices.has(id));
      const body = { label: s.keyLabel.trim(), services, teamId: s.selectedId };
      const signature = JSON.stringify(body);
      if (!s.keyAttempt || s.keyAttempt.signature !== signature) s.keyAttempt = { signature, key: newIdempotencyKey() };
      const res = await post('/gateway/api-keys', body, { 'idempotency-key': s.keyAttempt.key });
      s.keyAttempt = null;
      const { key, ...summary } = res.apiKey;
      s.keys = [summary, ...s.keys];
      s.revealed = { ...summary, key };
      s.keyLabel = ''; s.keyServices = new Set();
      await loadOverview();
    } catch (err) {
      reportHandledException(err, 'createTeamKey');
      s.keyError = friendlyError(err, 'We could not create that key. Please try again.');
    } finally {
      s.isCreatingKey = false;
      if (isCurrent()) render();
    }
  }

  async function copyRevealed() {
    const input = document.getElementById('team-reveal-input');
    if (!input) return;
    try { await navigator.clipboard.writeText(s.revealed.key); toast('Key copied.'); }
    catch { input.select(); toast('Press Ctrl+C to copy the selected key.'); }
  }

  const onKeydown = (e) => {
    if (!isCurrent()) { document.removeEventListener('keydown', onKeydown); return; }
    if (e.key === 'Escape' && s.confirm && !s.isBusy) { s.confirm = null; render(); }
  };
  document.addEventListener('keydown', onKeydown);

  // ---------- views ----------
  const tabs = tabsHtml('/developer/teams');

  function teamCardHtml(t) {
    return `
      <div class="state-card key-card">
        <div class="biz-icon neutral">${icon('group')}</div>
        <div class="biz-body">
          <div class="biz-title">${esc(t.name)}</div>
          <div class="biz-sub">${t.memberCount} ${t.memberCount === 1 ? 'member' : 'members'} · ${t.keyCount} ${t.keyCount === 1 ? 'key' : 'keys'} · Created ${esc(formatDate(t.createdAt))}</div>
          <div class="biz-chips"><span class="meta-chip">${esc(ROLE_LABELS[t.role] || t.role)}</span></div>
        </div>
        <button type="button" class="btn btn-sm" data-open-team="${esc(t.id)}" aria-label="Open team ${esc(t.name)}">Open</button>
      </div>`;
  }

  function inviteCardHtml(i) {
    return `
      <div class="state-card key-card">
        <div class="biz-icon neutral">${icon('mail_outline')}</div>
        <div class="biz-body">
          <div class="biz-title">${esc(i.teamName)}</div>
          <div class="biz-sub">You are invited as ${esc((ROLE_LABELS[i.role] || i.role).toLowerCase())}.</div>
        </div>
        <button type="button" class="btn btn-sm btn-primary" data-accept-invite="${esc(i.id)}">Accept</button>
        <button type="button" class="btn btn-sm" data-decline-invite="${esc(i.id)}">Decline</button>
      </div>`;
  }

  function memberRowHtml(m) {
    const me = m.userId === (state.user && state.user.id);
    const role = myRole();
    const accepted = m.acceptedAt !== null;
    const manageable = canManageMember(role, { role: m.role, accepted });
    const roleOptions = grantableRoles(role);
    const roleCell = !me && manageable && accepted && roleOptions.length
      ? `<select class="team-select" data-role-for="${esc(m.id)}" aria-label="Role of ${esc(m.user.email)}">${ROLES.filter((r) => roleOptions.includes(r) || r === m.role).map((r) => `<option value="${r}" ${r === m.role ? 'selected' : ''} ${roleOptions.includes(r) ? '' : 'disabled'}>${esc(ROLE_LABELS[r])}</option>`).join('')}</select>`
      : `<span class="meta-chip">${esc(ROLE_LABELS[m.role] || m.role)}</span>`;
    // The last owner cannot leave (the server refuses): say so instead of offering a button that can only fail.
    const lastOwner = m.role === 'owner' && s.detail.members.filter((x) => x.role === 'owner' && x.acceptedAt !== null).length === 1;
    const action = me
      ? (lastOwner ? `<span class="biz-sub" title="Make someone else an owner, or delete the team">Last owner</span>` : `<button type="button" class="btn btn-sm" data-leave="${esc(m.id)}">Leave</button>`)
      : manageable ? `<button type="button" class="btn btn-sm" data-remove-member="${esc(m.id)}" data-email="${esc(m.user.email)}" aria-label="${accepted ? 'Remove' : 'Withdraw invitation for'} ${esc(m.user.email)}">${accepted ? 'Remove' : 'Withdraw'}</button>` : '';
    return `
      <div class="state-card key-card">
        <div class="biz-icon neutral">${icon('person_outline')}</div>
        <div class="biz-body">
          <div class="biz-title">${esc(m.user.email)}${me ? ' (you)' : ''}</div>
          <div class="biz-sub">${accepted ? 'Member' : 'Invitation not accepted yet'}</div>
        </div>
        ${roleCell}
        ${action}
      </div>`;
  }

  /** An invitation to an address with no Desk account yet: waits (30 days) for that address to sign up and confirm it. */
  function emailInviteRowHtml(inv) {
    const canWithdraw = grantableRoles(myRole()).includes(inv.role);
    const left = Math.max(0, Math.ceil((Date.parse(inv.invitedAt) + 30 * 86_400_000 - Date.now()) / 86_400_000));
    return `
      <div class="state-card key-card">
        <div class="biz-icon neutral">${icon('mail_outline')}</div>
        <div class="biz-body">
          <div class="biz-title">${esc(inv.email)}</div>
          <div class="biz-sub">No Desk account yet · invitation waits ${left} more ${left === 1 ? 'day' : 'days'} for them to sign up with this address</div>
        </div>
        <span class="meta-chip">${esc(ROLE_LABELS[inv.role] || inv.role)}</span>
        ${canWithdraw ? `<button type="button" class="btn btn-sm" data-withdraw-invite="${esc(inv.id)}" data-email="${esc(inv.email)}" aria-label="Withdraw invitation for ${esc(inv.email)}">Withdraw</button>` : ''}
      </div>`;
  }

  function teamKeyHtml(k) {
    const used = k.lastUsedAt ? `Last used ${formatDate(k.lastUsedAt)}` : 'Never used';
    return `
      <div class="state-card key-card">
        <div class="biz-icon neutral">${icon('key')}</div>
        <div class="biz-body">
          <div class="biz-title">${esc(k.label)}</div>
          <div class="biz-sub">${esc(k.keyPrefix)}… · Created ${esc(formatDate(k.createdAt))} · ${esc(used)}</div>
          <div class="biz-chips">${(k.services || []).map((id) => `<span class="meta-chip">${esc(serviceName(id))}</span>`).join('')}</div>
        </div>
        ${canCreateKeys(myRole()) ? `<button type="button" class="btn btn-sm" data-revoke-key="${esc(k.id)}" data-label="${esc(k.label)}" aria-label="Revoke key ${esc(k.label)}">Revoke</button>` : ''}
      </div>`;
  }

  function detailHtml() {
    const { team, members } = s.detail;
    const emailInvites = s.detail.emailInvites || [];
    const role = team.role;
    const roles = grantableRoles(role);
    const catalog = teamKeyServices(s.services);
    const animateKeyError = s.keyError !== s._lastKeyError;
    s._lastKeyError = s.keyError;
    return `
      <button type="button" class="btn btn-sm" id="back-to-teams" style="margin-bottom:var(--sp-lg);">${icon('arrow_back')} All teams</button>
      <div class="card" style="margin-bottom:var(--sp-lg);">
        <h2 class="biz-section-title">${esc(team.name)}</h2>
        <p class="biz-sub">You are ${esc((ROLE_LABELS[role] || role).toLowerCase())}: ${esc(ROLE_HELP[role] || '')}</p>
        <p class="biz-sub" style="margin-top:var(--sp-sm);">Every key of this team shares one allowance of calls${team.rateLimitPerMinute ? ` (${team.rateLimitPerMinute} a minute)` : ''}, so one busy key can use up what the others have. Team keys reach the Registry and Market APIs only.</p>
      </div>
      ${s.revealed ? `
        <div class="card" style="margin-bottom:var(--sp-lg);">
          <h2 class="biz-section-title">Copy your new key</h2>
          <p class="biz-sub" style="margin-bottom:var(--sp-md);">This is the only time the full key is shown. Store it somewhere safe.</p>
          <div class="reveal-key">
            <input id="team-reveal-input" readonly value="${esc(s.revealed.key)}" aria-label="Your new team key" />
            <button type="button" class="btn btn-primary" id="team-copy-btn">${icon('content_copy')} Copy</button>
          </div>
          <button type="button" class="btn" id="team-dismiss-btn" style="margin-top:var(--sp-lg);">I've saved my key</button>
        </div>` : ''}
      <h2 class="biz-section-title">People</h2>
      ${members.map(memberRowHtml).join('')}
      ${emailInvites.map(emailInviteRowHtml).join('')}
      ${roles.length ? `
        <div class="card" style="margin:var(--sp-lg) 0;">
          <h3 class="biz-section-title">Invite someone</h3>
          <p class="biz-sub" style="margin-bottom:var(--sp-md);">We email them. If they have no Desk account yet, the invitation waits 30 days for them to sign up with this address; either way they accept it on this page.</p>
          <form id="invite-form" novalidate>
            <div class="field-float has-icon">
              <span class="field-icon">${icon('mail_outline')}</span>
              <label>E-mail address</label>
              <input name="email" type="email" placeholder=" " maxlength="254" value="${esc(s.inviteEmail)}" autocomplete="off" />
            </div>
            <div class="field-header"><label for="invite-role">Role</label></div>
            <select id="invite-role" class="team-select" name="role">${roles.map((r) => `<option value="${r}" ${r === s.inviteRole ? 'selected' : ''}>${esc(ROLE_LABELS[r])}: ${esc(ROLE_HELP[r])}</option>`).join('')}</select>
            ${s.inviteError ? statusMsg('error', s.inviteError, true) : ''}
            ${s.inviteMessage ? statusMsg('success', s.inviteMessage, true) : ''}
            <button type="submit" class="btn btn-primary" style="margin-top:var(--sp-lg);" ${s.isInviting ? 'disabled' : ''}>${s.isInviting ? spinnerBtn(true, '') : icon('person_add')}${s.isInviting ? '' : ' Send invitation'}</button>
          </form>
        </div>` : ''}
      <h2 class="biz-section-title" style="margin-top:var(--sp-xl);">Team keys</h2>
      ${s.keys.length ? s.keys.map(teamKeyHtml).join('') : `<div class="state-card"><div class="biz-icon neutral">${icon('key')}</div><div class="biz-body"><div class="biz-title">No team keys yet</div><div class="biz-sub">${canCreateKeys(role) ? 'Create the first one below.' : 'A developer, admin or owner can create one.'}</div></div></div>`}
      ${canCreateKeys(role) ? `
        <div class="card" style="margin:var(--sp-lg) 0;">
          <h3 class="biz-section-title">Create a team key</h3>
          <form id="team-key-form" novalidate>
            <div class="field-float has-icon">
              <span class="field-icon">${icon('key')}</span>
              <label>Key name</label>
              <input name="label" placeholder=" " maxlength="64" value="${esc(s.keyLabel)}" autocomplete="off" />
            </div>
            <div class="field-header"><label>APIs this key can call</label></div>
            <div class="library-list">${catalog.map((svc) => `
              <label class="library-row">
                <input type="checkbox" name="service" value="${esc(svc.service)}" aria-labelledby="tsvc-${esc(svc.service)}" ${s.keyServices.has(svc.service) ? 'checked' : ''} ${svc.available ? '' : 'disabled'} />
                <span class="library-body"><span class="name" id="tsvc-${esc(svc.service)}">${esc(svc.name)}</span><span class="biz-sub">${esc(svc.description)}</span></span>
              </label>`).join('')}</div>
            ${s.keyError ? statusMsg('error', s.keyError, animateKeyError) : ''}
            <button type="submit" class="btn btn-primary" style="margin-top:var(--sp-lg);" ${s.isCreatingKey ? 'disabled' : ''}>${s.isCreatingKey ? spinnerBtn(true, '') : icon('key')}${s.isCreatingKey ? '' : ' Create team key'}</button>
          </form>
        </div>` : ''}
      ${canDeleteTeam(role) ? `<div style="margin-top:var(--sp-xl);"><button type="button" class="btn btn-danger" id="delete-team-btn">Delete this team</button><p class="biz-sub" style="margin-top:var(--sp-sm);">Every key of the team is revoked and stops working at once.</p></div>` : ''}
    `;
  }

  function overviewHtml() {
    const animateTeamError = s.teamError !== s._lastTeamError;
    s._lastTeamError = s.teamError;
    return `
      ${s.invites.length ? `<h2 class="biz-section-title">Invitations for you</h2>${s.invites.map(inviteCardHtml).join('')}<div style="height:var(--sp-lg)"></div>` : ''}
      <div class="card" style="margin-bottom:var(--sp-lg);">
        <h2 class="biz-section-title">Create a team</h2>
        <p class="biz-sub" style="margin-bottom:var(--sp-lg);">A team shares API keys and one allowance of calls. You become its owner and can invite the others.</p>
        <form id="create-team-form" novalidate>
          <div class="field-float has-icon">
            <span class="field-icon">${icon('group')}</span>
            <label>Team name</label>
            <input name="name" placeholder=" " maxlength="${MAX_NAME_LENGTH}" value="${esc(s.newName)}" autocomplete="off" />
          </div>
          ${s.teamError ? statusMsg('error', s.teamError, animateTeamError) : ''}
          <button type="submit" class="btn btn-primary" style="margin-top:var(--sp-lg);" ${s.isCreatingTeam ? 'disabled' : ''}>${s.isCreatingTeam ? spinnerBtn(true, '') : icon('group_add')}${s.isCreatingTeam ? '' : ' Create team'}</button>
        </form>
      </div>
      <h2 class="biz-section-title" style="margin-top:var(--sp-xl);">Your teams</h2>
      ${s.teams.length ? s.teams.map(teamCardHtml).join('') : `<div class="state-card"><div class="biz-icon neutral">${icon('group')}</div><div class="biz-body"><div class="biz-title">No teams yet</div><div class="biz-sub">Create one above, or accept an invitation.</div></div></div>`}`;
  }

  function confirmHtml() {
    const c = s.confirm;
    const text = {
      revokeKey: `Revoke "${c.label}"? Anything using it stops working immediately. This cannot be undone.`,
      removeMember: `Remove ${c.email} from the team? Keys they made stay with the team.`,
      withdrawInvite: `Withdraw the invitation for ${c.email}? They will not be able to join with it.`,
      leave: 'Leave this team? Keys you made stay with the team.',
      deleteTeam: 'Delete this team? Every key of the team is revoked and stops working at once. This cannot be undone.',
    }[c.kind];
    const button = { revokeKey: 'Revoke', removeMember: 'Remove', withdrawInvite: 'Withdraw', leave: 'Leave', deleteTeam: 'Delete' }[c.kind];
    return `
      <div class="modal-backdrop" id="team-modal-backdrop">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="team-modal-title">
          <h2 id="team-modal-title">${esc(button)}</h2>
          <p>${esc(text)}</p>
          <div style="display:flex;justify-content:flex-end;gap:var(--sp-sm);margin-top:var(--sp-xl);">
            <button type="button" class="btn" id="team-cancel-btn" ${s.isBusy ? 'disabled' : ''}>Cancel</button>
            <button type="button" class="btn btn-danger" id="team-confirm-btn" ${s.isBusy ? 'disabled' : ''}>${s.isBusy ? spinnerBtn(true, '') : esc(button)}</button>
          </div>
        </div>
      </div>`;
  }

  function render() {
    let body;
    if (s.isLoading) {
      body = `<div class="empty-state">${spinnerBtn(true, '', { dark: true })}<div style="margin-top:var(--sp-md);">Loading your teams…</div></div>`;
    } else if (s.loadError) {
      body = `<div class="empty-state">${icon('error_outline')}<div style="margin-top:var(--sp-md);">Teams could not load</div><div class="hint">${esc(s.loadError)}</div><button type="button" class="btn" id="retry-teams-btn" style="margin-top:var(--sp-lg);">${icon('refresh')} Try again</button></div>`;
    } else {
      body = s.detail ? detailHtml() : overviewHtml();
    }
    app.innerHTML = `
      <div class="page">
        <div class="page-head-row"><div class="head-text"><h1>API Library</h1><p>Share API keys and one allowance with the people you work with.</p></div></div>
        ${tabs}
        ${body}
      </div>
      ${s.confirm ? confirmHtml() : ''}`;
    wire();
  }

  function wire() {
    const $ = (id) => document.getElementById(id);
    app.querySelectorAll('[data-nav]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); navigate(a.dataset.nav); }));
    const retry = $('retry-teams-btn'); if (retry) retry.addEventListener('click', load);
    app.querySelectorAll('[data-open-team]').forEach((b) => b.addEventListener('click', () => openTeam(b.dataset.openTeam)));
    app.querySelectorAll('[data-accept-invite]').forEach((b) => b.addEventListener('click', () => answerInvite(b.dataset.acceptInvite, true)));
    app.querySelectorAll('[data-decline-invite]').forEach((b) => b.addEventListener('click', () => answerInvite(b.dataset.declineInvite, false)));
    const createForm = $('create-team-form');
    if (createForm) {
      createForm.addEventListener('submit', createTeam); submitOnEnter(createForm);
      createForm.querySelector('input[name="name"]').addEventListener('input', (e) => { s.newName = e.target.value; });
    }
    const back = $('back-to-teams');
    if (back) back.addEventListener('click', async () => { s.selectedId = null; s.detail = null; s.keys = []; s.revealed = null; await loadOverview().catch(() => {}); render(); });
    const inviteForm = $('invite-form');
    if (inviteForm) {
      inviteForm.addEventListener('submit', invite); submitOnEnter(inviteForm);
      inviteForm.querySelector('input[name="email"]').addEventListener('input', (e) => { s.inviteEmail = e.target.value; });
      inviteForm.querySelector('select[name="role"]').addEventListener('change', (e) => { s.inviteRole = e.target.value; });
    }
    app.querySelectorAll('[data-role-for]').forEach((sel) => sel.addEventListener('change', () => changeRole(sel.dataset.roleFor, sel.value)));
    app.querySelectorAll('[data-remove-member]').forEach((b) => b.addEventListener('click', () => { s.confirm = { kind: 'removeMember', id: b.dataset.removeMember, email: b.dataset.email }; render(); }));
    app.querySelectorAll('[data-withdraw-invite]').forEach((b) => b.addEventListener('click', () => { s.confirm = { kind: 'withdrawInvite', id: b.dataset.withdrawInvite, email: b.dataset.email }; render(); }));
    app.querySelectorAll('[data-leave]').forEach((b) => b.addEventListener('click', () => { s.confirm = { kind: 'leave', id: b.dataset.leave }; render(); }));
    app.querySelectorAll('[data-revoke-key]').forEach((b) => b.addEventListener('click', () => { s.confirm = { kind: 'revokeKey', id: b.dataset.revokeKey, label: b.dataset.label }; render(); }));
    const del = $('delete-team-btn'); if (del) del.addEventListener('click', () => { s.confirm = { kind: 'deleteTeam' }; render(); });
    const keyForm = $('team-key-form');
    if (keyForm) {
      keyForm.addEventListener('submit', createKey); submitOnEnter(keyForm);
      keyForm.querySelector('input[name="label"]').addEventListener('input', (e) => { s.keyLabel = e.target.value; });
      keyForm.querySelectorAll('input[name="service"]').forEach((box) => box.addEventListener('change', () => { if (box.checked) s.keyServices.add(box.value); else s.keyServices.delete(box.value); }));
    }
    const copy = $('team-copy-btn'); if (copy) copy.addEventListener('click', copyRevealed);
    const dismiss = $('team-dismiss-btn'); if (dismiss) dismiss.addEventListener('click', () => { s.revealed = null; render(); });
    const cancel = $('team-cancel-btn');
    if (cancel) { cancel.addEventListener('click', () => { s.confirm = null; render(); }); cancel.focus(); }
    const ok = $('team-confirm-btn');
    if (ok) ok.addEventListener('click', () => {
      const c = s.confirm;
      if (c.kind === 'revokeKey') revokeKey(c.id);
      else if (c.kind === 'removeMember') removeMember(c.id, false);
      else if (c.kind === 'withdrawInvite') withdrawInvite(c.id);
      else if (c.kind === 'leave') removeMember(c.id, true);
      else if (c.kind === 'deleteTeam') deleteTeam();
    });
    const backdrop = $('team-modal-backdrop');
    if (backdrop) backdrop.addEventListener('click', (e) => { if (e.target === backdrop && !s.isBusy) { s.confirm = null; render(); } });
  }

  await load();
});
