// What a person may do in a team, so the Teams page only offers buttons that will work. The SERVER decides for real
// (src/domain/teams/teams.ts); this only mirrors its rules so nobody is shown a button that would be refused.
export const ROLES = ['owner', 'admin', 'developer', 'viewer'];
const RANK = { viewer: 0, developer: 1, admin: 2, owner: 3 };

export const ROLE_LABELS = {
  owner: 'Owner',
  admin: 'Admin',
  developer: 'Developer',
  viewer: 'Viewer',
};

export const ROLE_HELP = {
  owner: 'Everything, including deleting the team.',
  admin: 'Invites and removes developers and viewers, and manages every key.',
  developer: 'Creates keys and manages the ones they made.',
  viewer: 'Sees the team, its keys and their usage.',
};

export function atLeast(role, needed) {
  return Boolean(role) && RANK[role] >= RANK[needed];
}

/** The roles this person may hand out when inviting or changing someone's role. */
export function grantableRoles(myRole) {
  if (myRole === 'owner') return ['owner', 'admin', 'developer', 'viewer'];
  if (myRole === 'admin') return ['developer', 'viewer'];
  return [];
}

/**
 * Whether the person may change or remove someone else's membership. An owner may touch anyone; an admin only
 * developers, viewers and invitations that are still pending; nobody else may.
 */
export function canManageMember(myRole, member) {
  if (myRole === 'owner') return true;
  if (myRole === 'admin') return !member.accepted || RANK[member.role] < RANK.admin;
  return false;
}

/** Whether the person may make a new key for the team. */
export function canCreateKeys(myRole) {
  return atLeast(myRole, 'developer');
}

/** Whether the person may delete the team. */
export function canDeleteTeam(myRole) {
  return myRole === 'owner';
}

/** The APIs a team key may carry (never the Desk API: it would act as the person who made the key). */
export function teamKeyServices(catalog) {
  return (catalog || []).filter((s) => s.service !== 'desk_api');
}
