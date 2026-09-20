// Content-Security-Policy for the three kinds of response this service sends.
//  - JSON API answers: nothing may load or run, and nothing may frame them.
//  - The API Library web pages (library-ui/): scripts only from this origin and the pinned Sentry bundle, styles from
//    this origin and Google Fonts, connections only back to this origin and Sentry's ingest host.
//  - The Swagger UI docs page: the pinned, hash-checked Swagger files from unpkg and its own single inline script
//    (allowed by its hash, not by 'unsafe-inline').
import { createHash } from 'crypto';

/** 'report-only' logs violations in the browser console without blocking, for checking a policy before enforcing it. */
export const CSP_MODE = 'enforce' as 'enforce' | 'report-only';
export const CSP_HEADER = CSP_MODE === 'enforce' ? 'content-security-policy' : 'content-security-policy-report-only';

/** Applied to an HTML response: replaces the strict API policy every response starts with. */
export function applyHtmlCsp(reply: { removeHeader: (k: string) => unknown; header: (k: string, v: string) => unknown }, policy: string): void {
  reply.removeHeader('content-security-policy');
  reply.header(CSP_HEADER, policy);
}

export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export const LIBRARY_UI_CSP = [
  "default-src 'none'",
  // static.cloudflareinsights.com: Cloudflare adds its own analytics beacon to HTML it proxies.
  "script-src 'self' https://browser.sentry-cdn.com https://static.cloudflareinsights.com",
  "style-src 'self' https://fonts.googleapis.com",
  "style-src-attr 'unsafe-inline'",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' https://*.ingest.us.sentry.io https://cloudflareinsights.com",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  'upgrade-insecure-requests',
].join('; ');

// The exact Swagger UI release the docs page loads, and the hash of each file: the browser refuses a file that does
// not match, so unpkg (or anyone in between) cannot swap in different code. To upgrade, change the version and
// recompute both hashes (openssl dgst -sha384 -binary <file> | openssl base64 -A).
export const SWAGGER_UI_VERSION = '5.33.0';
export const SWAGGER_UI_CSS_SRI = 'sha384-Ov4/wv3j2bmct8cDc5X4ngJZohVPzEmc6uDPH8WeljUxO5vtoykvMEfbu9Vh6RaW';
export const SWAGGER_UI_JS_SRI = 'sha384-YDALVcy8kj8yltLBVi1vBiBAUqdxvus673gM8XKwiy6aDUJFXivF/KCufekjYbVf';

export function docsInlineScript(base: string): string {
  return `SwaggerUIBundle({ url: '${base}/docs/openapi.json', dom_id: '#swagger-ui', presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset] });`;
}

/** The docs page's policy: its one inline script is allowed by hash. Swagger UI styles itself with inline styles. */
export function docsCsp(base: string): string {
  const scriptHash = `'sha256-${createHash('sha256').update(docsInlineScript(base), 'utf8').digest('base64')}'`;
  return [
    "default-src 'none'",
    `script-src https://unpkg.com/swagger-ui-dist@${SWAGGER_UI_VERSION}/ ${scriptHash} https://static.cloudflareinsights.com`,
    `style-src https://unpkg.com/swagger-ui-dist@${SWAGGER_UI_VERSION}/ 'unsafe-inline'`,
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self' https://cloudflareinsights.com",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}
