import { z } from 'zod';
import { validationError } from '../middleware/http-error';

export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 200;

const PageQuerySchema = z.object({
  limit: z.coerce.number().int('limit must be a whole number').min(1, 'limit must be at least 1').max(MAX_PAGE_SIZE, `limit must be at most ${MAX_PAGE_SIZE}`).default(DEFAULT_PAGE_SIZE),
  offset: z.coerce.number().int('offset must be a whole number').min(0, 'offset must be 0 or more').default(0),
});

export interface Page {
  limit: number;
  offset: number;
}

/** `?limit=&offset=` for list endpoints; absent values mean the first DEFAULT_PAGE_SIZE rows. */
export function parsePage(query: unknown): Page {
  const parsed = PageQuerySchema.safeParse(query ?? {});
  if (!parsed.success) throw validationError(parsed.error);
  return parsed.data;
}

/**
 * Lists are fetched one row past the page so "is there more?" needs no second
 * query. Returns the rows to send and whether another page exists.
 */
export function slicePage<T>(rows: T[], page: Page): { rows: T[]; hasMore: boolean } {
  return { rows: rows.slice(0, page.limit), hasMore: rows.length > page.limit };
}
