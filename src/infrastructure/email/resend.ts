// Ported unchanged from the original (see git history) — same Resend
// integration, same themed HTML email, same "click a link to
// {appBaseUrl}/reset-password?token=..." design. Kept deliberately
// different from the sibling API-only services (registry-api,
// market-validation-api), which switched to a raw-token pattern since they
// have no web frontend of their own — desk-api's Flutter app (moving to
// Cloudflare Pages) DOES have a real frontend that serves /reset-password
// and /confirm-email, so the link-based design stays.
import { isSuppressed } from '../../domain/email/suppressions';
import { deliverViaProvider, queueForRetry } from '../../domain/email/outbox';
import { htmlToText } from './text';

export { htmlToText };
import type { AppConfig } from '../../config';

export async function sendPasswordResetEmail(
  config: AppConfig,
  to: string,
  token: string,
  requestId: string,
  linkBase: string = config.appBaseUrl,
): Promise<void> {
  // The token is in the #fragment: browsers never send it to a server, so it stays out of every log and Referer.
  const resetUrl = `${linkBase}/reset-password#token=${encodeURIComponent(token)}`;
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
  linkBase: string = config.appBaseUrl,
): Promise<void> {
  const confirmationUrl = `${linkBase}/confirm-email#token=${encodeURIComponent(token)}`;
  await sendEmail(config, {
    to,
    subject: 'Confirm your Desk email',
    html: themedEmailHtml({
      title: 'Confirm your email',
      body: "Welcome to Desk. Confirm this email address to continue with Desk's products.",
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

/** A heads-up about something that happened on the account (new sign-in, password change, new API key). */
export async function sendSecurityNoticeEmail(
  config: AppConfig,
  to: string,
  title: string,
  body: string,
  requestId: string,
  showAction: boolean = true,
): Promise<void> {
  await sendEmail(config, {
    to,
    subject: `Desk security notice: ${title}`,
    html: themedEmailHtml({
      title,
      body,
      showAction,
      actionLabel: 'Review your account activity',
      actionUrl: `${config.appBaseUrl}/account/sessions`,
      note: 'If this was not you, reset your password right away and sign out all devices from the page above. You cannot unsubscribe from security notices.',
    }),
    requestId,
    skippedEvent: 'security_notice_email_skipped',
    failedEvent: 'security_notice_email_failed',
    sentEvent: 'security_notice_email_sent',
  });
}

/** For an address with no Desk account yet: says who invited them and how to join. */
export async function sendBusinessInviteSignupEmail(
  config: AppConfig,
  to: string,
  businessName: string,
  inviterEmail: string,
  requestId: string,
): Promise<void> {
  const signUpUrl = `${config.appBaseUrl}/login`;
  await sendEmail(config, {
    to,
    subject: `You've been invited to ${businessName} on Desk`,
    html: themedEmailHtml({
      title: `You've been invited to ${businessName}`,
      body: `${inviterEmail} invited you to ${businessName} on Desk. Create an account with this email address and confirm it, then open your pending invites to accept or decline.`,
      actionLabel: 'Create your account',
      actionUrl: signUpUrl,
      note: 'If you were not expecting this, you can ignore this email — nothing happens unless you sign up with this address.',
    }),
    requestId,
    skippedEvent: 'business_invite_email_skipped',
    failedEvent: 'business_invite_email_failed',
    sentEvent: 'business_invite_email_sent',
  });
}

/** An existing account was invited to a team: says who and where to accept. */
export async function sendTeamInviteEmail(config: AppConfig, to: string, teamName: string, inviterEmail: string, requestId: string): Promise<void> {
  await sendEmail(config, {
    to,
    subject: `You've been invited to the team ${teamName} on Desk`,
    html: themedEmailHtml({
      title: `You've been invited to ${teamName}`,
      body: `${inviterEmail} invited you to the team ${teamName} in the Desk API Library. Sign in and open Teams to accept or decline.`,
      actionLabel: 'Open your invitations',
      actionUrl: `${libraryBase()}/developer/teams`,
      note: 'If you were not expecting this, you can decline it once signed in, or ignore this email: nothing happens until you accept.',
    }),
    requestId,
    skippedEvent: 'team_invite_email_skipped',
    failedEvent: 'team_invite_email_failed',
    sentEvent: 'team_invite_email_sent',
  });
}

/** For an address with no Desk account yet: says who invited them to which team and how to join. */
export async function sendTeamInviteSignupEmail(config: AppConfig, to: string, teamName: string, inviterEmail: string, requestId: string): Promise<void> {
  await sendEmail(config, {
    to,
    subject: `You've been invited to the team ${teamName} on Desk`,
    html: themedEmailHtml({
      title: `You've been invited to ${teamName}`,
      body: `${inviterEmail} invited you to the team ${teamName} in the Desk API Library. Create an account with this email address and confirm it, then open Teams to accept or decline.`,
      actionLabel: 'Create your account',
      actionUrl: `${libraryBase()}/login`,
      note: 'If you were not expecting this, you can ignore this email: nothing happens unless you sign up with this address. The invitation expires after 30 days.',
    }),
    requestId,
    skippedEvent: 'team_invite_email_skipped',
    failedEvent: 'team_invite_email_failed',
    sentEvent: 'team_invite_email_sent',
  });
}

/** The API Library's own address (team invitations are answered there, not in the Desk app). */
function libraryBase(): string {
  return (process.env.API_PUBLIC_URL || 'https://api.deskbusiness.co').replace(/\/+$/, '');
}

/** This month's metered use just crossed 80% or 100% of the plan's included amount. */
export async function sendUsageThresholdEmail(config: AppConfig, to: string, percent: number, used: number, included: number, requestId = 'usage-threshold'): Promise<void> {
  const atCap = percent >= 100;
  await sendEmail(config, {
    to,
    subject: atCap ? "You've used this month's included analyses" : "You're near this month's included analyses",
    html: themedEmailHtml({
      title: atCap ? "You've reached this month's included amount" : `You've used ${percent}% of this month's included amount`,
      body: `${used.toLocaleString('en-US')} of ${included.toLocaleString('en-US')} included market analyses used this month.${atCap ? ' Further analyses may cost extra or be refused, depending on your plan.' : ''}`,
      actionLabel: 'View your plan and usage',
      actionUrl: `${libraryBase()}/developer/billing`,
      note: 'This is sent once per threshold each month, not on every call.',
    }),
    requestId,
    skippedEvent: 'usage_threshold_email_skipped',
    failedEvent: 'usage_threshold_email_failed',
    sentEvent: 'usage_threshold_email_sent',
  });
}

/** Confirms an address wants status-page updates (double opt-in: nobody is subscribed, or e-mailed again, without clicking this). */
export async function sendStatusSubscribeConfirmEmail(config: AppConfig, to: string, confirmToken: string, requestId = 'status-subscribe'): Promise<void> {
  await sendEmail(config, {
    to,
    subject: 'Confirm: Desk status updates',
    html: themedEmailHtml({
      title: 'Confirm you want Desk status updates',
      body: 'Click below to start getting an e-mail when something changes on the Desk status page. If you did not ask for this, ignore it: nothing happens unless you confirm.',
      actionLabel: 'Confirm subscription',
      actionUrl: `${libraryBase()}/status/subscribe/confirm?token=${encodeURIComponent(confirmToken)}`,
      note: 'This link expires in 7 days.',
    }),
    requestId,
    skippedEvent: 'status_subscribe_email_skipped',
    failedEvent: 'status_subscribe_email_failed',
    sentEvent: 'status_subscribe_email_sent',
  });
}

/** One incident update, to one confirmed subscriber (their own unsubscribe link at the bottom). */
export async function sendIncidentNoticeEmail(config: AppConfig, to: string, unsubscribeToken: string, title: string, status: string, message: string, requestId = 'status-incident'): Promise<void> {
  await sendEmail(config, {
    to,
    subject: `Desk status: ${title} (${status})`,
    html: themedEmailHtml({
      title,
      body: `${status[0].toUpperCase()}${status.slice(1)}: ${message}`,
      actionLabel: 'View the status page',
      actionUrl: `${libraryBase()}/status`,
      note: `You get this because you subscribed to Desk status updates. <a href="${libraryBase()}/status/subscribe/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}">Unsubscribe</a>.`,
    }),
    requestId,
    skippedEvent: 'status_incident_email_skipped',
    failedEvent: 'status_incident_email_failed',
    sentEvent: 'status_incident_email_sent',
  });
}

export async function sendAccountAlreadyExistsEmail(
  config: AppConfig,
  to: string,
  requestId: string,
  linkBase: string = config.appBaseUrl,
): Promise<void> {
  const signInUrl = `${linkBase}/login`;
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
  /** false hides the button entirely; actionUrl is still used to resolve the logo's origin either way. */
  showAction?: boolean;
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

  // An address that bounced for good, or whose owner marked us as spam, is not written to again.
  if (await isSuppressed(request.to)) {
    console.warn(JSON.stringify({ level: 'warn', event: 'email_suppressed_skipped', requestId: request.requestId, reason: 'address bounced or complained before' }));
    return;
  }

  const result = await deliverViaProvider(config, { to: request.to, subject: request.subject, html: request.html });
  if (!result.ok) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: request.failedEvent,
        requestId: request.requestId,
        status: result.status,
        detail: result.detail,
      }),
    );
    // A provider that is down or busy (or unreachable) is tried again a few times; a refusal that will not change
    // (a rejected address, a bad request) is not.
    if (result.transient) await queueForRetry({ to: request.to, subject: request.subject, html: request.html, kind: request.sentEvent, error: `${result.status} ${result.detail}` });
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
  // The live frontend at appBaseUrl is the web_app static site (web_app/public),
  // not the Flutter web build, so the logo lives at the site root -- not under
  // Flutter's /assets/assets/ web-build convention (which 404s here, silently
  // falling back to the SPA's index.html shell instead of an image).
  const logoUrl = `${content.actionUrl.startsWith('http') ? new URL(content.actionUrl).origin : ''}/desk_logo.png`;
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
                    ${content.showAction === false ? '' : `<table cellpadding="0" cellspacing="0" role="presentation" style="width:100%;border-collapse:separate">
                      <tr>
                        <td align="center" bgcolor="#3B82F6" style="border-radius:12px;background:#3B82F6">
                          <a href="${content.actionUrl}" style="display:block;padding:14px 18px;color:#FFFFFF;text-decoration:none;font-size:15px;line-height:20px;font-weight:700;border-radius:12px">${escapeHtml(content.actionLabel)}</a>
                        </td>
                      </tr>
                    </table>`}
                    <p style="margin:${content.showAction === false ? '0' : '24px'} 0 0;color:#94A3B8;font-size:14px;line-height:1.45;font-weight:500;letter-spacing:0">${escapeHtml(content.note)}</p>
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
