/**
 * Security notices to the account owner, so that nothing changes access silently, including a write an assistant
 * was tricked into by text in a document or email. Best effort: a failed email never blocks sign-in or a tool call.
 */
type Notice = { subject: string; lines: string[]; footer?: string[] };

/** Returns whether the email was handed to Cloudflare; a failure never undoes the action. */
async function send(env: Env, to: string, notice: Notice): Promise<boolean> {
  const footer = notice.footer ?? ["", "If this wasn’t you, reply to this email or write to support@otisbase.com, and we will disconnect it.", "", "Otis · otisbase.com"];
  try {
    await env.EMAIL.send({ to, from: env.EMAIL_FROM, subject: notice.subject, text: [...notice.lines, ...footer].join("\n"), replyTo: env.FEEDBACK_TO });
    return true;
  } catch {
    // The action already succeeded; the notice is informational.
    return false;
  }
}

/** After a successful sign-in: which assistant now has access to the person's business records. */
export async function notifyConnection(env: Env, email: string, clientName: string): Promise<void> {
  await send(env, email, {
    subject: "New assistant connected to Otis",
    lines: [`${clientName} can now read and change your Otis business records.`, `Signed in with ${email} on ${new Date().toUTCString()}.`],
  });
}

/** After an owner invites someone: who was invited and with which role, through which assistant. */
export async function notifyInvite(env: Env, ownerEmail: string, invitee: string, role: string): Promise<void> {
  await send(env, ownerEmail, {
    subject: "You invited someone to your Otis business",
    lines: [`${invitee} was invited as ${role === "editor" ? "an editor" : "a viewer"}. The invitation lasts seven days and works only when they sign in with that email.`,
      "To remove them, ask your assistant to remove this person from your team."],
  });
}

const accountFooter = ["", "Reply to this email or write to support@otisbase.com with any questions.", "", "Otis · otisbase.com"];

/** After an admin suspends an account. The Terms promise to tell the person why; message is that explanation. */
export function notifySuspended(env: Env, email: string, message: string): Promise<boolean> {
  return send(env, email, { subject: "Your Otis account is suspended", footer: accountFooter,
    lines: [message, "", "Your assistants are disconnected and you can’t sign in while the suspension lasts. Your records are kept."] });
}

/** After an admin lifts a suspension. */
export function notifyRestored(env: Env, email: string, message?: string): Promise<boolean> {
  return send(env, email, { subject: "Your Otis account is active again", footer: accountFooter,
    lines: [...(message ? [message, ""] : []), "You can sign in and connect your assistants again."] });
}

/** To SIGNUP_NOTICE_TO when someone signs in for the first time. Internal accounts never trigger it; no recipients, no email. */
export async function notifySignup(env: Env, recipients: string[], who: { email: string; clientName: string; people: number }): Promise<void> {
  for (const to of recipients) {
    await send(env, to, { subject: "New Otis sign-up", footer: ["", "Otis · otisbase.com"],
      lines: [`${who.email} signed up through ${who.clientName} on ${new Date().toUTCString()}.`,
        `${who.people} ${who.people === 1 ? "person has" : "people have"} signed up so far, not counting internal accounts.`] });
  }
}
