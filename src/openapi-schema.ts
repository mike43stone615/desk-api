// Keeps the published API description honest.
//  - Request bodies are generated FROM the validators the routes really use (zod), so the description cannot drift from
//    what the server accepts.
//  - Response schemas are inferred from real captured answers (openapi-examples.ts), and contract tests check that the
//    routes really answer that way (see __tests__/routes/openapiContract.test.ts).
import { z } from 'zod';

type Json = Record<string, unknown>;

/** Members that are text when there is something to say and null when there is not (never used, never expires, ...). */
const NULLABLE_MEMBERS = new Set(['lastUsedAt', 'expiresAt', 'emailConfirmedAt', 'invitedByUserId', 'invitedAt', 'industry', 'unavailableReason']);

/** A JSON schema for the body a route accepts, taken from its validator. */
export function bodySchemaFrom(schema: z.ZodType): Json {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Json;
  delete json.$schema;
  return json;
}

/** A description of the shape of an example value: object properties (all required), array item shape, primitive type. */
export function inferSchema(value: unknown): Json {
  if (value === null || value === undefined) return { nullable: true };
  if (Array.isArray(value)) return { type: 'array', items: value.length > 0 ? inferSchema(value[0]) : {} };
  switch (typeof value) {
    case 'string': return { type: 'string' };
    case 'number': return { type: Number.isInteger(value) ? 'integer' : 'number' };
    case 'boolean': return { type: 'boolean' };
    case 'object': {
      const props = Object.fromEntries(Object.entries(value as Json).map(([k, v]) => [k, NULLABLE_MEMBERS.has(k) ? { ...inferSchema(v), nullable: true } : inferSchema(v)]));
      return { type: 'object', properties: props, required: Object.keys(props) };
    }
    default: return {};
  }
}

/** Problems found when `value` does not fit `schema` (missing members, wrong types). Extra members are allowed. */
export function shapeProblems(schema: Json, value: unknown, at = '$'): string[] {
  if (value === null || value === undefined) return schema.nullable === true || Object.keys(schema).length === 0 ? [] : [`${at}: is ${value === null ? 'null' : 'missing'}`];
  const type = schema.type as string | undefined;
  if (!type) return [];
  const actual = Array.isArray(value) ? 'array' : typeof value;
  const ok = type === 'integer' ? Number.isInteger(value) : type === 'number' ? actual === 'number' : actual === type;
  if (!ok) return [`${at}: expected ${type}, got ${actual}`];
  if (type === 'object') {
    const props = (schema.properties ?? {}) as Record<string, Json>;
    const problems: string[] = [];
    for (const key of (schema.required ?? []) as string[]) {
      if (!(key in (value as Json))) problems.push(`${at}.${key}: missing`);
      else problems.push(...shapeProblems(props[key] ?? {}, (value as Json)[key], `${at}.${key}`));
    }
    return problems;
  }
  if (type === 'array' && (value as unknown[]).length > 0) return shapeProblems((schema.items ?? {}) as Json, (value as unknown[])[0], `${at}[0]`);
  return [];
}
