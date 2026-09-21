// Where the link in a reset or confirmation e-mail should lead. Someone who signed up through the API Library pages
// (served from the API's own host) should finish there, not be sent to the Desk app they may never have seen; everyone
// else goes to the app. Only two hosts are ever possible, both ours, so a request header cannot point a link elsewhere.
import type { FastifyRequest } from 'fastify';
import { trimTrailingSlashes } from '../../utils/strings';
import { config } from '../../config';

export function emailLinkBase(request: Pick<FastifyRequest, 'headers'>): string {
  const library = trimTrailingSlashes(process.env.API_PUBLIC_URL || 'https://api.deskbusiness.co');
  const origin = typeof request.headers.origin === 'string' ? trimTrailingSlashes(request.headers.origin) : '';
  return origin && origin === library ? library : config.appBaseUrl;
}
