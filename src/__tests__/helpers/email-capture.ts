// Only a hash of an emailed token is stored, so tests that must follow an email link capture the token as it is
// handed to the mail sender (exactly what a person would receive), instead of reading it back from the database.
export const emailed = {
  confirm: new Map<string, string>(),
  reset: new Map<string, string>(),
  /** Business invitation emails by recipient: which kind of email they got. */
  invite: new Map<string, 'existing-account' | 'sign-up'>(),
  /** Security notices by recipient: the titles, in the order sent. */
  security: new Map<string, string[]>(),
  /** The confirm.unsubscribe token pair handed to a status-subscribe confirmation e-mail, by recipient. */
  statusSubscribe: new Map<string, string>(),
  /** Incident notice e-mails sent, in order: { to, title, status }. */
  incidentNotice: [] as Array<{ to: string; title: string; status: string }>,
  /** Usage-threshold e-mails sent, in order: { to, percent }. */
  usageThreshold: [] as Array<{ to: string; percent: number }>,
};

export function emailModuleMock() {
  return {
    sendEmailConfirmationEmail: async (_config: unknown, email: string, token: string) => {
      emailed.confirm.set(email, token);
    },
    sendPasswordResetEmail: async (_config: unknown, email: string, token: string) => {
      emailed.reset.set(email, token);
    },
    sendBusinessInviteEmail: async (_config: unknown, email: string) => {
      emailed.invite.set(email, 'existing-account');
    },
    sendBusinessInviteSignupEmail: async (_config: unknown, email: string) => {
      emailed.invite.set(email, 'sign-up');
    },
    sendSecurityNoticeEmail: async (_config: unknown, email: string, title: string) => {
      emailed.security.set(email, [...(emailed.security.get(email) ?? []), title]);
    },
    sendAccountAlreadyExistsEmail: async () => {},
    sendTeamInviteEmail: async () => {},
    sendTeamInviteSignupEmail: async () => {},
    sendStatusSubscribeConfirmEmail: async (_config: unknown, email: string, token: string) => {
      emailed.statusSubscribe.set(email, token);
    },
    sendIncidentNoticeEmail: async (_config: unknown, to: string, _unsubscribeToken: string, title: string, status: string) => {
      emailed.incidentNotice.push({ to, title, status });
    },
    sendUsageThresholdEmail: async (_config: unknown, to: string, percent: number) => {
      emailed.usageThreshold.push({ to, percent });
    },
  };
}
