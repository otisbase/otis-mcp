import { DurableObject } from "cloudflare:workers";
import { eu } from "./regions";
import { schemas, FEEDBACK_PER_DAY, canonical, type DomainResult } from "./models";
import type { Identity } from "./auth";
import type { z } from "zod";

type FeedbackInput = z.infer<typeof schemas.feedback_send>;
type Delivery = "pending" | "sent" | "failed";
type Feedback = {
  id: string; account_id: string; business_id: string; received_at: string;
  kind: FeedbackInput["kind"]; message: string; client?: string; email?: string;
  delivery: Delivery; delivery_error?: string;
};

/** One inbox for every feedback message, so the team can read them in one place if email fails. Never touches business records. */
export class FeedbackStore extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, request_id TEXT NOT NULL, input TEXT NOT NULL,
        day TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(account_id, request_id));
      CREATE INDEX IF NOT EXISTS feedback_by_day ON feedback(account_id, day);
    `);
  }
  // Saved messages are the daily count, so a retry under the same request_id is counted once.
  // Returns serialized JSON, like BusinessStore.execute, to keep RPC types shallow.
  submit(entry: Omit<Feedback, "id" | "received_at" | "delivery">, requestId: string, input: string): string {
    return JSON.stringify(this.ctx.storage.transactionSync((): DomainResult => {
      const previous = this.ctx.storage.sql.exec<{ input: string; data: string }>("SELECT input, data FROM feedback WHERE account_id = ? AND request_id = ?", entry.account_id, requestId).toArray()[0];
      if (previous) {
        if (previous.input !== input) return { ok: false, code: "IDEMPOTENCY_CONFLICT", message: "This request_id was used for a different message. Use a new ID." };
        return { ok: true, data: JSON.parse(previous.data) as Feedback };
      }
      const now = new Date(), day = now.toISOString().slice(0, 10);
      const used = this.ctx.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM feedback WHERE account_id = ? AND day = ?", entry.account_id, day).one().count;
      if (used >= FEEDBACK_PER_DAY) {
        const resets_at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
        return { ok: false, code: "FEEDBACK_LIMIT", message: `You have sent ${FEEDBACK_PER_DAY} feedback messages today. Otis accepts feedback again after 00:00 UTC. This limit does not affect your business records.`,
          details: { limit: "feedback_per_day", allowed: FEEDBACK_PER_DAY, used, resets_at } };
      }
      const feedback: Feedback = { id: crypto.randomUUID(), received_at: now.toISOString(), ...entry, delivery: "pending" };
      this.ctx.storage.sql.exec("INSERT INTO feedback(id, account_id, request_id, input, day, data) VALUES (?, ?, ?, ?, ?, ?)", feedback.id, entry.account_id, requestId, input, day, JSON.stringify(feedback));
      return { ok: true, data: feedback };
    }));
  }
  delivered(id: string, delivery: Delivery, error?: string): void {
    this.ctx.storage.sql.exec("UPDATE feedback SET data = json_patch(data, ?) WHERE id = ?", JSON.stringify({ delivery, delivery_error: error ?? null }), id);
  }
  sentToday(accountId: string): number {
    return this.ctx.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM feedback WHERE account_id = ? AND day = ?", accountId, new Date().toISOString().slice(0, 10)).one().count;
  }
}

function emailText(feedback: Feedback): string {
  return [
    `Kind: ${feedback.kind}`,
    `Sent from: ${feedback.client ?? "not stated"}`,
    `Reply to: ${feedback.email ?? "not requested; do not contact"}`,
    `Received: ${feedback.received_at}`,
    `Feedback ID: ${feedback.id}`,
    `Account: ${feedback.account_id}`,
    "", feedback.message
  ].join("\n");
}

/** Saves first, then emails the team. A failed email leaves the saved copy and is retried by repeating the same request_id. */
export async function sendFeedback(env: Env, identity: Identity, businessId: string, input: FeedbackInput): Promise<DomainResult> {
  if (input.reply_ok && !identity.email) return { ok: false, code: "REPLY_EMAIL_UNAVAILABLE", message: "This connection does not carry your verified email. Reconnect Otis to allow a reply, or send without reply_ok. Nothing was saved." };
  const store = eu(env.FEEDBACK).getByName("inbox");
  const saved = JSON.parse(await store.submit({ account_id: identity.userId, business_id: businessId, kind: input.kind, message: input.message, client: input.client,
    ...(input.reply_ok ? { email: identity.email } : {}) }, input.request_id, canonical(input))) as DomainResult;
  if (!saved.ok) return saved;
  const feedback = saved.data as Feedback;
  if (feedback.delivery !== "sent") {
    try {
      await env.EMAIL.send({ to: env.FEEDBACK_TO, from: env.EMAIL_FROM, subject: `Otis feedback: ${feedback.kind}`, text: emailText(feedback),
        ...(feedback.email ? { replyTo: feedback.email } : {}) });
      feedback.delivery = "sent"; delete feedback.delivery_error;
    } catch (e) {
      feedback.delivery = "failed"; feedback.delivery_error = (e as { code?: string }).code ?? "SEND_FAILED";
    }
    await store.delivered(feedback.id, feedback.delivery, feedback.delivery_error);
  }
  return { ok: true, data: {
    feedback_id: feedback.id, kind: feedback.kind, received_at: feedback.received_at, saved: true, delivery: feedback.delivery,
    reply_email: feedback.email ?? null, remaining_today: Math.max(0, FEEDBACK_PER_DAY - await store.sentToday(identity.userId)),
    notice: feedback.delivery === "sent"
      ? `Saved and emailed to the Otis team.${feedback.email ? " They may reply to your verified email." : " Your email was not shared, so no reply will come."}`
      : "Saved, but the email to the Otis team failed. The saved copy stays. Retry with the same request_id to try the email again; it is counted once."
  } };
}
