import { z } from 'zod';

// The two draft fields that become columns when a draft is completed (businesses.name / businesses.industry).
export const MAX_BUSINESS_NAME_LENGTH = 200;
export const MAX_INDUSTRY_LENGTH = 100;

export const DraftPatchSchema = z.object({
  draft: z
    .record(z.string(), z.unknown())
    .superRefine((draft, ctx) => {
      for (const [field, max] of [['businessName', MAX_BUSINESS_NAME_LENGTH], ['industry', MAX_INDUSTRY_LENGTH]] as const) {
        const value = draft[field];
        if (typeof value === 'string' && value.length > max) {
          ctx.addIssue({ code: 'custom', message: `${field} must be at most ${max} characters.` });
        }
      }
    }),
});
export type DraftPatchRequest = z.infer<typeof DraftPatchSchema>;

export const MemberInviteSchema = z.object({
  email: z.string().min(1, 'email is required').max(254, 'email must be at most 254 characters'),
  role: z.enum(['owner', 'admin', 'member', 'accountant']).optional(),
});
export type MemberInviteRequest = z.infer<typeof MemberInviteSchema>;
