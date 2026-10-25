import { digest, type Identity } from "./auth";
import { eu } from "./regions";
import { registry, type Milestone } from "./registry";

/** Addresses in a comma-separated secret, trimmed and lowercased. */
export const emailList = (value?: string) => (value ?? "").split(",").map(email => email.trim().toLowerCase()).filter(Boolean);

/** Admin, reviewer and QA accounts: left out of every stat unless an admin asks for them. */
export function isInternal(env: Env, email?: string): boolean {
  if (!email) return false;
  const address = email.trim().toLowerCase();
  return [...emailList(env.ADMIN_EMAILS), ...emailList(env.INTERNAL_EMAILS), ...emailList(env.REVIEW_EMAIL)].includes(address);
}

const REACHED: Partial<Record<string, Milestone>> = {
  business_set: "business", client_save: "client", billable_record: "work", expense_record: "work", timer_start: "work",
  invoice_draft: "draft", invoice_issue: "issued", payment_record: "payment"
};
/** Every call counts as activity; a successful write can also reach a funnel step. */
export function milestonesFor(operation: string, ok: boolean): Milestone[] {
  const reached = ok ? REACHED[operation] : undefined;
  return reached ? ["first_call", reached] : ["first_call"];
}

// Per isolate: what this person already reported today, so repeat calls skip even the AccountStore round trip.
const seen = new Map<string, { day: string; milestones: Set<Milestone> }>();

/**
 * Runs after the response (ctx.waitUntil). The person's AccountStore says what is new; the registry hears only that,
 * at most once per person per day plus once per milestone.
 */
export async function trackCall(env: Env, identity: Identity, operation: string, ok: boolean): Promise<void> {
  const now = new Date(), day = now.toISOString().slice(0, 10);
  const milestones = milestonesFor(operation, ok);
  const known = seen.get(identity.userId);
  if (known?.day === day && milestones.every(m => known.milestones.has(m))) return;
  const { newDay, newMilestones } = await eu(env.ACCOUNTS).getByName(identity.userId).touch(day, milestones);
  seen.set(identity.userId, { day, milestones: new Set([...(known?.day === day ? known.milestones : []), ...milestones]) });
  if (!newDay && !newMilestones.length) return;
  await registry(env).activity({ userId: identity.userId, email: identity.email, businessId: await digest(`otis-business:${identity.userId}`),
    day, milestones: newMilestones, internal: isInternal(env, identity.email), at: now.toISOString() });
}
