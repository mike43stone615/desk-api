import { z } from 'zod';

// The two draft fields that become columns when a draft is completed (businesses.name / businesses.industry).
export const MAX_BUSINESS_NAME_LENGTH = 200;
export const MAX_INDUSTRY_LENGTH = 100;

/** Generous limits on the SHAPE of a draft (it is otherwise free-form JSON up to 256 KB, which also bounds any one value), so
 * it cannot be used to store absurdly deep or wide structures that make every later read and parse expensive. */
export const DRAFT_LIMITS = { maxDepth: 12, maxNodes: 5000, maxKeyLength: 100 } as const;

export function draftShapeProblem(draft: unknown): string | null {
  let nodes = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value: draft, depth: 1 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    nodes += 1;
    if (nodes > DRAFT_LIMITS.maxNodes) return `Draft has too many values (limit ${DRAFT_LIMITS.maxNodes}).`;
    if (depth > DRAFT_LIMITS.maxDepth) return `Draft is nested too deeply (limit ${DRAFT_LIMITS.maxDepth} levels).`;
    if (Array.isArray(value)) {
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
    } else if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (key.length > DRAFT_LIMITS.maxKeyLength) return `A draft field name is too long (limit ${DRAFT_LIMITS.maxKeyLength} characters).`;
        stack.push({ value: item, depth: depth + 1 });
      }
    }
  }
  return null;
}

export const DraftPatchSchema = z.object({
  draft: z
    .record(z.string(), z.unknown())
    .superRefine((draft, ctx) => {
      const shape = draftShapeProblem(draft);
      if (shape) ctx.addIssue({ code: 'custom', message: shape });
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
