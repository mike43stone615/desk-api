// Ported unchanged from the original (see git history) — same Resend
// integration, same themed HTML email, same "click a link to
// {appBaseUrl}/reset-password?token=..." design. Kept deliberately
// different from the sibling API-only services (registry-api,
// market-validation-api), which switched to a raw-token pattern since they
// have no web frontend of their own — desk-api's Flutter app (moving to
// Cloudflare Pages) DOES have a real frontend that serves /reset-password
// and /confirm-email, so the link-based design stays.
import type { AppConfig } from '../../config';

export async function sendPasswordResetEmail(
  config: AppConfig,
  to: string,
  token: string,
  requestId: string,
): Promise<void> {
  const resetUrl = `${config.appBaseUrl}/reset-password?token=${encodeURIComponent(token)}`;
  await sendEmail(config, {
    to,
    subject: 'Reset your Desk password',
    html: themedEmailHtml({
      title: 'Reset your password',
      body: 'We received a request to reset the password for your Desk account. Choose a new password with the secure link below.',
      actionLabel: 'Reset password',
      actionUrl: resetUrl,
      note: `This link expires in ${config.resetTokenDurationMinutes} minutes. If you did not request a password reset, you can safely ignore this email.`,
    }),
    requestId,
    skippedEvent: 'password_reset_email_skipped',
    failedEvent: 'password_reset_email_failed',
    sentEvent: 'password_reset_email_sent',
  });
}

export async function sendEmailConfirmationEmail(
  config: AppConfig,
  to: string,
  token: string,
  requestId: string,
): Promise<void> {
  const confirmationUrl = `${config.appBaseUrl}/confirm-email?token=${encodeURIComponent(token)}`;
  await sendEmail(config, {
    to,
    subject: 'Confirm your Desk email',
    html: themedEmailHtml({
      title: 'Confirm your email',
      body: 'Welcome to Desk. Confirm this email address before opening your business workspace.',
      actionLabel: 'Confirm email',
      actionUrl: confirmationUrl,
      note: 'If you did not create a Desk account, you can safely ignore this email.',
    }),
    requestId,
    skippedEvent: 'email_confirmation_skipped',
    failedEvent: 'email_confirmation_failed',
    sentEvent: 'email_confirmation_sent',
  });
}

export async function sendBusinessInviteEmail(
  config: AppConfig,
  to: string,
  businessName: string,
  inviterEmail: string,
  requestId: string,
): Promise<void> {
  const signInUrl = `${config.appBaseUrl}/login`;
  await sendEmail(config, {
    to,
    subject: `You've been added to ${businessName} on Desk`,
    html: themedEmailHtml({
      title: `You've been added to ${businessName}`,
      body: `${inviterEmail} added you to ${businessName} on Desk. Sign in and open your pending invites to accept or decline.`,
      actionLabel: 'Sign in',
      actionUrl: signInUrl,
      note: 'If you were not expecting this, you can decline the invite once signed in, or ignore this email — declining removes your access.',
    }),
    requestId,
    skippedEvent: 'business_invite_email_skipped',
    failedEvent: 'business_invite_email_failed',
    sentEvent: 'business_invite_email_sent',
  });
}

export async function sendAccountAlreadyExistsEmail(
  config: AppConfig,
  to: string,
  requestId: string,
): Promise<void> {
  const signInUrl = `${config.appBaseUrl}/login`;
  await sendEmail(config, {
    to,
    subject: 'You already have a Desk account',
    html: themedEmailHtml({
      title: 'You already have an account',
      body: 'Someone (hopefully you) just tried to sign up for a Desk account with this email address, but one already exists. If this was you, sign in below — or use "Forgot password" on the sign-in page if you don\'t remember your password.',
      actionLabel: 'Sign in',
      actionUrl: signInUrl,
      note: 'If you did not try to sign up, you can safely ignore this email — no changes were made to your account.',
    }),
    requestId,
    skippedEvent: 'account_already_exists_email_skipped',
    failedEvent: 'account_already_exists_email_failed',
    sentEvent: 'account_already_exists_email_sent',
  });
}

interface EmailRequest {
  to: string;
  subject: string;
  html: string;
  requestId: string;
  skippedEvent: string;
  failedEvent: string;
  sentEvent: string;
}

interface ThemedEmailContent {
  title: string;
  body: string;
  actionLabel: string;
  actionUrl: string;
  note: string;
}

async function sendEmail(config: AppConfig, request: EmailRequest): Promise<void> {
  if (!config.resendApiKey) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: request.skippedEvent,
        requestId: request.requestId,
        reason: 'RESEND_API_KEY not configured',
      }),
    );
    return;
  }

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `Desk <${config.emailFrom}>`,
      to: [request.to],
      subject: request.subject,
      html: request.html,
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    console.error(
      JSON.stringify({
        level: 'error',
        event: request.failedEvent,
        requestId: request.requestId,
        status: resp.status,
        detail: detail.substring(0, 300),
      }),
    );
    return;
  }

  // Audit-level success log, paired with the console.error failure path
  // above -- genuinely informational, not a warning.
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      level: 'audit',
      event: request.sentEvent,
      requestId: request.requestId,
    }),
  );
}

function themedEmailHtml(content: ThemedEmailContent): string {
  const logoUrl = `${content.actionUrl.startsWith('http') ? new URL(content.actionUrl).origin : ''}/assets/assets/desk_logo.png`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="supported-color-schemes" content="dark">
</head>
<body style="margin:0;padding:0;background:#070D1A;font-family:Inter,'Segoe UI',Arial,sans-serif;color:#FFFFFF">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="width:100%;background:#070D1A;border-collapse:collapse">
    <tr>
      <td style="padding:0">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="width:100%;background:#0E1626;border-bottom:1px solid #22304A;border-collapse:collapse">
          <tr>
            <td style="padding:8px 24px">
              <a href="https://www.deskbusiness.co" style="display:inline-block;text-decoration:none;color:#FFFFFF">
                <img src="${logoUrl}" width="32" height="32" alt="Desk" style="width:32px;height:32px;vertical-align:middle;border:0;display:inline-block;margin-right:12px">
                <span style="font-size:20px;line-height:32px;font-weight:700;color:#FFFFFF;vertical-align:middle">Desk</span>
              </a>
            </td>
          </tr>
        </table>
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="width:100%;border-collapse:collapse">
          <tr>
            <td align="center" style="padding:48px 24px">
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:440px;background:#0E1626;border:1px solid #22304A;border-radius:16px;border-collapse:separate;overflow:hidden">
                <tr>
                  <td style="padding:24px 24px 0">
                    <img src="${logoUrl}" width="44" height="44" alt="Desk" style="width:44px;height:44px;border:0;display:block">
                  </td>
                </tr>
                <tr>
                  <td style="padding:20px 24px 24px">
                    <h1 style="margin:0 0 8px;color:#FFFFFF;font-size:24px;line-height:1.2;font-weight:700;letter-spacing:0">${escapeHtml(content.title)}</h1>
                    <p style="margin:0 0 24px;color:#CBD5E1;font-size:14px;line-height:1.45;font-weight:500;letter-spacing:0">${escapeHtml(content.body)}</p>
                    <table cellpadding="0" cellspacing="0" role="presentation" style="width:100%;border-collapse:separate">
                      <tr>
                        <td align="center" bgcolor="#3B82F6" style="border-radius:12px;background:#3B82F6">
                          <a href="${content.actionUrl}" style="display:block;padding:14px 18px;color:#FFFFFF;text-decoration:none;font-size:15px;line-height:20px;font-weight:700;border-radius:12px">${escapeHtml(content.actionLabel)}</a>
                        </td>
                      </tr>
                    </table>
                    <p style="margin:24px 0 0;color:#94A3B8;font-size:14px;line-height:1.45;font-weight:500;letter-spacing:0">${escapeHtml(content.note)}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
