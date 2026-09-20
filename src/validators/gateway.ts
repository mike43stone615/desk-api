import { z } from 'zod';
import { GATEWAY_SERVICES } from '../domain/gateway/services';

export const CreateGatewayKeySchema = z.object({
  label: z.string().trim().min(1, 'A label is required.').max(64, 'Label must be 64 characters or fewer.'),
  services: z
    .array(z.enum(GATEWAY_SERVICES))
    .min(1, 'Choose at least one API.')
    .max(GATEWAY_SERVICES.length),
  // Optional: the key stops working after this many days (1 to 730). Leave it out for a key that does not expire.
  expiresInDays: z.number().int('expiresInDays must be a whole number of days.').min(1, 'expiresInDays must be at least 1.').max(730, 'expiresInDays must be at most 730.').optional(),
});
export type CreateGatewayKeyRequest = z.infer<typeof CreateGatewayKeySchema>;
