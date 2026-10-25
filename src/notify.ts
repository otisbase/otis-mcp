/**
 * Security notices to the account owner, so that nothing changes access silently, including a write an assistant
 * was tricked into by text in a document or email. Best effort: a failed email never blocks sign-in or a tool call.
 */
type Notice = { subject: string; lines: string[] };

async function send(env: Env, to: string, notice: Notice): Promise<void> {
  const footer = ["", "If this wasn’t you, reply to this email or write to support@otisbase.com, and we will disconnect it.", "", "Otis · otisbase.com"];
  try {
    await env.EMAIL.send({ to, from: env.EMAIL_FROM, subject: notice.subject, text: [...notice.lines, ...footer].join("\n"), replyTo: env.FEEDBACK_TO });
  } catch {
    // The action already succeeded; the notice is informational.
  }
}

/** After a successful sign-in: which assistant now has access to the person's business records. */
export function notifyConnection(env: Env, email: string, clientName: string): Promise<void> {
  return send(env, email, {
    subject: "New assistant connected to Otis",
    lines: [`${clientName} can now read and change your Otis business records.`, `Signed in with ${email} on ${new Date().toUTCString()}.`],
  });
}

/** After an owner invites someone: who was invited and with which role, through which assistant. */
export function notifyInvite(env: Env, ownerEmail: string, invitee: string, role: string): Promise<void> {
  return send(env, ownerEmail, {
    subject: "You invited someone to your Otis business",
    lines: [`${invitee} was invited as ${role === "editor" ? "an editor" : "a viewer"}. The invitation lasts seven days and works only when they sign in with that email.`,
      "To remove them, ask your assistant to remove this person from your team."],
  });
}
