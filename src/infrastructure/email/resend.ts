import type { AppConfig } from '../../config.js';

export async function sendPasswordResetEmail(
  config: AppConfig,
  to: string,
  token: string,
  requestId: string,
): Promise<void> {
  if (!config.resendApiKey) {
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'password_reset_email_skipped',
      requestId,
      reason: 'RESEND_API_KEY not configured',
    }));
    return;
  }

  const resetUrl = `${config.appBaseUrl}/reset-password?token=${token}`;

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `Desk Business <${config.emailFrom}>`,
      to: [to],
      subject: 'Reset your Desk Business password',
      html: passwordResetHtml(resetUrl, config.resetTokenDurationMinutes),
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    console.error(JSON.stringify({
      level: 'error',
      event: 'password_reset_email_failed',
      requestId,
      status: resp.status,
      detail: detail.substring(0, 300),
    }));
    // Do not throw — the route still returns success to prevent account enumeration.
    // The token remains valid in D1 and can be retrieved by an admin if needed.
  } else {
    console.log(JSON.stringify({
      level: 'audit',
      event: 'password_reset_email_sent',
      requestId,
    }));
  }
}

function passwordResetHtml(resetUrl: string, expiresMinutes: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:sans-serif;background:#f5f5f5;margin:0;padding:32px 16px">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto">
    <tr><td style="background:#ffffff;border-radius:8px;padding:40px;border:1px solid #e0e0e0">
      <p style="font-size:22px;font-weight:600;margin:0 0 8px">Reset your password</p>
      <p style="color:#555;margin:0 0 24px">
        We received a request to reset the password for your Desk Business account.
        Click the button below to choose a new password.
      </p>
      <a href="${resetUrl}"
         style="display:inline-block;background:#1a56db;color:#ffffff;text-decoration:none;
                padding:12px 28px;border-radius:6px;font-weight:600;font-size:15px">
        Reset password
      </a>
      <p style="color:#888;font-size:13px;margin:24px 0 0">
        This link expires in ${expiresMinutes} minutes.
        If you did not request a password reset, you can safely ignore this email.
      </p>
    </td></tr>
  </table>
</body>
</html>`;
}
