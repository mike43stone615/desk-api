import { z } from 'zod';
import { GATEWAY_SERVICES } from '../domain/gateway/services';

export const CreateGatewayKeySchema = z.object({
  label: z.string().trim().min(1, 'A label is required.').max(64, 'Label must be 64 characters or fewer.'),
  services: z
    .array(z.enum(GATEWAY_SERVICES))
    .min(1, 'Choose at least one API.')
    .max(GATEWAY_SERVICES.length),
});
export type CreateGatewayKeyRequest = z.infer<typeof CreateGatewayKeySchema>;
