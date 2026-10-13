// Identifiers in the address (a draft, a key, a membership) are only ever short letters, digits, "-" and "_".
// Anything else is refused up front with 400 invalid_id, instead of travelling down to the database as a query
// parameter and coming back as a misleading "not found".
import type { FastifyInstance } from 'fastify';
import { HttpError } from './http-error';

const ID_PARAMS = ['id', 'membershipId'];
const ID_FORMAT = /^[A-Za-z0-9_-]{1,64}$/;
// A row in the administrator tables is named by its id, or (for a table with no single id column, see
// domain/adminTableEdits.ts) by a row key built from its key columns: the same characters, but it can be longer.
const ADMIN_ROW_ID_FORMAT = /^[A-Za-z0-9_-]{1,1024}$/;
const ADMIN_ROW_ROUTE = '/admin/tables/:table/rows/:id';

export function registerPathParamCheck(app: FastifyInstance): void {
  app.addHook('preValidation', async (request) => {
    const params = request.params as Record<string, unknown> | undefined;
    if (!params) return;
    const adminRow = (request.routeOptions.url ?? '').endsWith(ADMIN_ROW_ROUTE);
    for (const name of ID_PARAMS) {
      const value = params[name];
      if (typeof value === 'string' && !(adminRow && name === 'id' ? ADMIN_ROW_ID_FORMAT : ID_FORMAT).test(value)) throw new HttpError(400, `The ${name === 'id' ? 'identifier' : 'membership identifier'} in the address is not valid.`, 'invalid_id');
    }
  });
}
