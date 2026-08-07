import { z } from 'zod';

export const DraftPatchSchema = z.object({
  draft: z.record(z.string(), z.unknown()),
});
export type DraftPatchRequest = z.infer<typeof DraftPatchSchema>;

export const MemberInviteSchema = z.object({
  email: z.string().min(1, 'email is required'),
  role: z.enum(['owner', 'admin', 'member', 'accountant']).optional(),
});
export type MemberInviteRequest = z.infer<typeof MemberInviteSchema>;
