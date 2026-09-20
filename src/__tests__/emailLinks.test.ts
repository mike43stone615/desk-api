// The one-time token in an emailed link is in the address's #fragment, so it is never sent to any server, log or Referer.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendEmailConfirmationEmail, sendPasswordResetEmail } from '../infrastructure/email/resend';
import type { AppConfig } from '../config';

const config = { resendApiKey: 're_test', emailFrom: 'noreply@example.com', appBaseUrl: 'https://app.example.com' } as unknown as AppConfig;
afterEach(() => vi.unstubAllGlobals());

async function sentHtml(send: () => Promise<void>): Promise<string> {
  const fetchMock = vi.fn(async () => new Response('{"id":"x"}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  await send();
  return JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body)).html as string;
}

describe('emailed links', () => {
  it('the password-reset link carries the token in the fragment, not the query string', async () => {
    const html = await sentHtml(() => sendPasswordResetEmail(config, 'a@example.com', 'tok/en+1', 'req-1'));
    expect(html).toContain('https://app.example.com/reset-password#token=tok%2Fen%2B1');
    expect(html).not.toMatch(/reset-password\?token=/);
  });
  it('and so does the email-confirmation link', async () => {
    const html = await sentHtml(() => sendEmailConfirmationEmail(config, 'a@example.com', 'abc123', 'req-2'));
    expect(html).toContain('https://app.example.com/confirm-email#token=abc123');
    expect(html).not.toMatch(/confirm-email\?token=/);
  });
});
