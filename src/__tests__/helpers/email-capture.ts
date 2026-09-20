// Only a hash of an emailed token is stored, so tests that must follow an email link capture the token as it is
// handed to the mail sender (exactly what a person would receive), instead of reading it back from the database.
export const emailed = {
  confirm: new Map<string, string>(),
  reset: new Map<string, string>(),
  /** Business invitation emails by recipient: which kind of email they got. */
  invite: new Map<string, 'existing-account' | 'sign-up'>(),
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
    sendAccountAlreadyExistsEmail: async () => {},
  };
}
