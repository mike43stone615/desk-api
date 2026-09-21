// The rules the Teams page uses to decide which buttons to show. The server still decides for real; this only has to agree
// with it (same roles, same limits), so nobody is shown a button that would be refused.
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain browser module without type declarations
import { grantableRoles, canManageMember, canCreateKeys, canDeleteTeam, teamKeyServices, atLeast } from '../../library-ui/team-rules.js';

const member = (role: string, accepted = true) => ({ role, accepted });

describe('team rules on the Teams page', () => {
  it('an owner may hand out every role, an admin only developer and viewer, everyone else none', () => {
    expect(grantableRoles('owner')).toEqual(['owner', 'admin', 'developer', 'viewer']);
    expect(grantableRoles('admin')).toEqual(['developer', 'viewer']);
    expect(grantableRoles('developer')).toEqual([]);
    expect(grantableRoles('viewer')).toEqual([]);
    expect(grantableRoles(null)).toEqual([]);
  });

  it('an owner manages anyone; an admin manages developers, viewers and pending invitations, never an owner or another admin', () => {
    for (const r of ['owner', 'admin', 'developer', 'viewer']) expect(canManageMember('owner', member(r))).toBe(true);
    expect(canManageMember('admin', member('developer'))).toBe(true);
    expect(canManageMember('admin', member('viewer'))).toBe(true);
    expect(canManageMember('admin', member('admin'))).toBe(false);
    expect(canManageMember('admin', member('owner'))).toBe(false);
    expect(canManageMember('admin', member('admin', false))).toBe(true); // a pending invitation can be withdrawn
    expect(canManageMember('developer', member('viewer'))).toBe(false);
    expect(canManageMember('viewer', member('viewer'))).toBe(false);
  });

  it('developers and above create keys; only an owner deletes the team', () => {
    expect(canCreateKeys('viewer')).toBe(false);
    expect(canCreateKeys('developer')).toBe(true);
    expect(canCreateKeys('admin')).toBe(true);
    expect(canDeleteTeam('admin')).toBe(false);
    expect(canDeleteTeam('owner')).toBe(true);
    expect(atLeast('admin', 'developer')).toBe(true);
    expect(atLeast(null, 'viewer')).toBe(false);
  });

  it('a team key is never offered the Desk API', () => {
    const catalog = [{ service: 'desk_api' }, { service: 'registry_api' }, { service: 'market_validation_api' }];
    expect(teamKeyServices(catalog).map((s: { service: string }) => s.service)).toEqual(['registry_api', 'market_validation_api']);
  });
});
