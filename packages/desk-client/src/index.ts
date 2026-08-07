// @desk/desk-client — auto-typed Desk API client.
// Types are generated from docs/openapi.json via `npm run generate:client`.
// Do not edit openapi-types.ts directly — regenerate it instead.
import createClient, { type ClientOptions } from 'openapi-fetch';
import type { paths } from './openapi-types';

export type { paths };

export type SignUpRequest = paths['/auth/signup']['post']['requestBody']['content']['application/json'];
export type SignInRequest = paths['/auth/signin']['post']['requestBody']['content']['application/json'];
export type SignInResponse = paths['/auth/signin']['post']['responses']['200']['content']['application/json'];

export interface DeskClientOptions extends ClientOptions {
  baseUrl: string;
  /** Bearer session token from signIn() — required for session-authenticated calls. */
  sessionToken?: string;
}

export class DeskClientError extends Error {
  constructor(
    message: string,
    public readonly response: Response,
  ) {
    super(message);
    this.name = 'DeskClientError';
  }
}

function throwOnError<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.error !== undefined || !result.data) {
    throw new DeskClientError(`Desk API error ${result.response.status}: ${result.response.url}`, result.response);
  }
  return result.data;
}

export class DeskClient {
  private readonly client: ReturnType<typeof createClient<paths>>;
  private sessionToken: string | undefined;

  constructor({ sessionToken, ...clientOpts }: DeskClientOptions) {
    this.client = createClient<paths>(clientOpts);
    this.sessionToken = sessionToken;
  }

  private authHeaders(): Record<string, string> {
    if (!this.sessionToken) throw new Error('sessionToken is required for this call — call signIn() first.');
    return { Authorization: `Bearer ${this.sessionToken}` };
  }

  async signUp(request: SignUpRequest) {
    return throwOnError(await this.client.POST('/auth/signup', { body: request }));
  }

  async signIn(request: SignInRequest): Promise<SignInResponse> {
    const result = throwOnError(await this.client.POST('/auth/signin', { body: request }));
    this.sessionToken = result.token;
    return result;
  }

  async signOut() {
    return throwOnError(await this.client.POST('/auth/signout', { headers: this.authHeaders() }));
  }

  async getSession() {
    return throwOnError(await this.client.GET('/auth/session', { headers: this.authHeaders() }));
  }
}
