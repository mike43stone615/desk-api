// Identifiers in the address (a draft, a key, a membership) are only ever short letters, digits, "-" and "_".
// Anything else is refused up front with 400 invalid_id, instead of travelling down to the database as a query
// parameter and coming back as a misleading "not found".
import type { FastifyInstance } from 'fastify';
import { HttpError } from './http-error';

const ID_PARAMS = ['id', 'membershipId'];
const ID_FORMAT = /^[A-Za-z0-9_-]{1,64}$/;

export function registerPathParamCheck(app: FastifyInstance): void {
  app.addHook('preValidation', async (request) => {
    const params = request.params as Record<string, unknown> | undefined;
    if (!params) return;
    for (const name of ID_PARAMS) {
      const value = params[name];
      if (typeof value === 'string' && !ID_FORMAT.test(value)) throw new HttpError(400, `The ${name === 'id' ? 'identifier' : 'membership identifier'} in the address is not valid.`, 'invalid_id');
    }
  });
}
