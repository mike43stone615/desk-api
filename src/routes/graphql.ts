// POST /graphql — the read-only GraphQL endpoint (domain/graphql/schema.ts has the schema). Depth, size and cost limits keep
// one request from costing more than a few ordinary ones; there are no mutations, and no GET (so it cannot be triggered from a page).
import type { FastifyReply, FastifyRequest } from 'fastify';
import { execute, GraphQLError, parse, validate, Kind, type DocumentNode, type FragmentDefinitionNode, type SelectionSetNode } from 'graphql';
import { HttpError } from '../middleware/http-error';
import { requireAuth } from '../middleware/auth';
import { getSchema, ROOT_VALUE, type GraphQLContext } from '../domain/graphql/schema';

export const GRAPHQL_LIMITS = { maxQueryChars: 8000, maxDepth: 6, maxFields: 150, maxAliases: 10 } as const;

interface Measure { depth: number; fields: number; aliases: number }

/** Depth, field count and alias count of an operation, with fragments expanded. Introspection (`__schema`, `__type`) is exempt. */
export function measureQuery(doc: DocumentNode): Measure {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const d of doc.definitions) if (d.kind === Kind.FRAGMENT_DEFINITION) fragments.set(d.name.value, d);
  const total: Measure = { depth: 0, fields: 0, aliases: 0 };
  const walk = (set: SelectionSetNode, depth: number, seen: Set<string>): number => {
    let deepest = depth;
    for (const sel of set.selections) {
      if (sel.kind === Kind.FIELD) {
        if (sel.name.value.startsWith('__')) continue;
        total.fields++;
        if (sel.alias) total.aliases++;
        deepest = Math.max(deepest, sel.selectionSet ? walk(sel.selectionSet, depth + 1, seen) : depth + 1);
      } else if (sel.kind === Kind.INLINE_FRAGMENT) {
        deepest = Math.max(deepest, walk(sel.selectionSet, depth, seen));
      } else if (!seen.has(sel.name.value)) {
        const f = fragments.get(sel.name.value);
        if (f) deepest = Math.max(deepest, walk(f.selectionSet, depth, new Set([...seen, sel.name.value])));
      }
    }
    return deepest;
  };
  for (const d of doc.definitions) if (d.kind === Kind.OPERATION_DEFINITION) total.depth = Math.max(total.depth, walk(d.selectionSet, 0, new Set()));
  return total;
}

function problem(reply: FastifyReply, status: number, message: string, code: string) {
  return reply.status(status).send({ data: null, errors: [{ message, extensions: { code } }] });
}

export async function graphqlHandler(request: FastifyRequest, reply: FastifyReply) {
  await requireAuth(request, reply);
  const body = (request.body ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (typeof body.query !== 'string' || body.query.trim() === '') throw new HttpError(400, 'Send a JSON body with a "query" string.', 'invalid_request');
  if (body.query.length > GRAPHQL_LIMITS.maxQueryChars) return problem(reply, 400, `The query is over ${GRAPHQL_LIMITS.maxQueryChars} characters.`, 'QUERY_TOO_LARGE');
  if (body.variables !== undefined && (body.variables === null || typeof body.variables !== 'object' || Array.isArray(body.variables))) throw new HttpError(400, '"variables" must be an object.', 'invalid_request');

  let doc: DocumentNode;
  try {
    doc = parse(body.query);
  } catch (err) {
    return problem(reply, 400, (err as GraphQLError).message, 'GRAPHQL_PARSE_FAILED');
  }
  if (doc.definitions.some((d) => d.kind === Kind.OPERATION_DEFINITION && d.operation !== 'query')) {
    return problem(reply, 400, 'Only queries are supported; nothing can be changed through GraphQL.', 'READ_ONLY');
  }
  const schema = getSchema();
  const invalid = validate(schema, doc);
  if (invalid.length > 0) return reply.status(400).send({ data: null, errors: invalid.slice(0, 10).map((e) => ({ message: e.message, locations: e.locations, extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } })) });
  const m = measureQuery(doc);
  if (m.depth > GRAPHQL_LIMITS.maxDepth) return problem(reply, 400, `The query is nested ${m.depth} levels deep; the limit is ${GRAPHQL_LIMITS.maxDepth}.`, 'QUERY_TOO_DEEP');
  if (m.fields > GRAPHQL_LIMITS.maxFields) return problem(reply, 400, `The query asks for ${m.fields} fields; the limit is ${GRAPHQL_LIMITS.maxFields}.`, 'QUERY_TOO_COSTLY');
  if (m.aliases > GRAPHQL_LIMITS.maxAliases) return problem(reply, 400, `The query uses ${m.aliases} aliases; the limit is ${GRAPHQL_LIMITS.maxAliases}.`, 'QUERY_TOO_COSTLY');

  const user = request.currentUser!;
  const scopes = request.gatewayKey ? new Set<string>(request.gatewayKey.deskScopes) : request.oauth ? new Set<string>(request.oauth.scopes) : null;
  const contextValue: GraphQLContext = { user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, emailConfirmedAt: user.emailConfirmedAt ?? null }, scopes };
  const result = await execute({
    schema,
    document: doc,
    rootValue: ROOT_VALUE,
    contextValue,
    variableValues: body.variables as Record<string, unknown> | undefined,
    operationName: typeof body.operationName === 'string' ? body.operationName : undefined,
  });
  // A resolver's own error is a normal GraphQL answer (HTTP 200 with errors); a bug is logged and hidden from the caller.
  const errors = result.errors?.map((e) => {
    const known = e.extensions?.code !== undefined;
    if (!known) request.log.error({ err: e.originalError ?? e }, 'graphql resolver failed');
    return { message: known ? e.message : 'Something went wrong on our side.', path: e.path, extensions: e.extensions?.code !== undefined ? e.extensions : { code: 'INTERNAL' } };
  });
  return reply.send({ data: result.data ?? null, ...(errors ? { errors } : {}) });
}
