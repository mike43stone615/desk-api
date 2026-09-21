import { z } from 'zod';
import { GATEWAY_SERVICES } from '../domain/gateway/services';
import { DESK_SCOPES } from '../domain/gateway/keys';

export const CreateGatewayKeySchema = z.object({
  label: z.string().trim().min(1, 'A label is required.').max(64, 'Label must be 64 characters or fewer.').transform((v) => v.normalize('NFC')),
  services: z
    .array(z.enum(GATEWAY_SERVICES))
    .min(1, 'Choose at least one API.')
    .max(GATEWAY_SERVICES.length),
  // Optional: the key stops working after this many days (1 to 730). Leave it out for a key that does not expire.
  // Which parts of the Desk API the key may read: profile, drafts, businesses. Leave it out for all of them.
  deskScopes: z.array(z.enum(DESK_SCOPES)).min(1, 'Choose at least one scope.').default([...DESK_SCOPES]),
  expiresInDays: z.number().int('expiresInDays must be a whole number of days.').min(1, 'expiresInDays must be at least 1.').max(730, 'expiresInDays must be at most 730.').optional(),
  // Optional: make the key a TEAM key (shared with the team, drawing on the team's allowance). Registry and Market APIs only.
  teamId: z.string().trim().min(1).max(64).optional(),
  // Optional: a sandbox key answers with fixed sample data and calls nothing real (Registry and Market APIs only).
  sandbox: z.boolean().optional(),
});
export type CreateGatewayKeyRequest = z.infer<typeof CreateGatewayKeySchema>;

export const AddKeyServiceSchema = z.object({ service: z.enum(GATEWAY_SERVICES) });

export const TEAM_ROLE_VALUES = ['owner', 'admin', 'developer', 'viewer'] as const;
export const CreateTeamSchema = z.object({
  name: z.string().trim().min(1, 'A team name is required.').max(64, 'Team name must be 64 characters or fewer.').transform((v) => v.normalize('NFC')),
});
export const InviteTeamMemberSchema = z.object({
  email: z.string().trim().min(3, 'An e-mail address is required.').max(254, 'That e-mail address is too long.'),
  role: z.enum(TEAM_ROLE_VALUES).default('developer'),
});
export const ChangeTeamRoleSchema = z.object({ role: z.enum(TEAM_ROLE_VALUES) });
export const TeamLimitSchema = z.object({ perMinute: z.number().int('perMinute must be a whole number.').min(1).max(100_000).nullable() });
