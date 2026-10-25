import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { authorizationServer, digest, type Identity } from "./auth";
import { eu } from "./regions";
import { registry, type Person } from "./registry";
import { emailList } from "./tracking";
import { notifyRestored, notifySuspended } from "./notify";
import { FREE_PLAN, READ_OPERATIONS, type Business, type DomainResult, type Operation } from "./models";
import { queryUsage, usageQueries } from "./usage";

/**
 * Admin tools (roadmap/admin.md) for the verified emails in the ADMIN_EMAILS secret. They are registered only for an
 * admin's connection, never listed in the public docs, menu or plugins, and every handler checks again.
 * Everything is read-only except suspend, unsuspend and delete. Tools that show a person write the access log first.
 */
export function isAdmin(env: Env, identity?: Identity): boolean {
  return !!identity?.email && emailList(env.ADMIN_EMAILS).includes(identity.email.trim().toLowerCase());
}

/** The IDs Otis derives from a sign-in email (src/auth.ts, src/mcp.ts), whether or not the person is in the registry. */
export async function adminTarget(email: string): Promise<{ email: string; userId: string; businessId: string }> {
  const address = email.trim().toLowerCase();
  const userId = await digest(`otis-user:${address}`);
  return { email: address, userId, businessId: await digest(`otis-business:${userId}`) };
}

const reason = z.string().trim().min(3).max(500).describe("Why you need this person's data. Written to the access log.");
const email = z.string().trim().email().max(254);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ADMIN_READS = [...READ_OPERATIONS].filter(op => !["businesses_list", "otis_menu", "tax_guide", "team_list"].includes(op)) as [Operation, ...Operation[]];
const day = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

// Registry results arrive over RPC; they are plain JSON, typed loosely here.
type AdminResult = { ok: true; data: unknown } | Extract<DomainResult, { ok: false }>;
type Handler = (input: any, admin: Identity) => Promise<AdminResult>;
type Tool = { title: string; description: string; input: Record<string, z.ZodType>; destructive?: boolean; handler: Handler };

export const adminTools = (env: Env): Record<string, Tool> => ({
  admin_stats: {
    title: "Admin: stats", description: "Otis-wide numbers for a date range: sign-up funnel, daily, weekly and monthly active people, return rates, weekly cohorts, sign-ups, dormant people, assistants, deletions and feedback. Numbers only. Internal accounts are excluded unless include_internal is true. Defaults to the last 30 days.",
    input: { from: date.optional(), to: date.optional(), include_internal: z.boolean().optional() },
    handler: async p => {
      const range = { from: p.from ?? day(-29), to: p.to ?? day(), includeInternal: p.include_internal ?? false };
      const stats = await registry(env).stats(range);
      return { ok: true, data: { ...stats, feedback: await eu(env.FEEDBACK).getByName("inbox").countsByKind(range.from, range.to) } };
    }
  },
  admin_usage: {
    title: "Admin: usage", description: "What people do in Otis for a date range (at most the last 90 days for events): tool calls and errors, assistants, records created by kind, issued invoices and totals per currency, plan-limit refusals and demo calls; plus all-time stored records by kind, businesses per currency and country, and how many businesses are at 80% of a monthly limit. Numbers only. business_email narrows events to one person.",
    input: { from: date.optional(), to: date.optional(), include_internal: z.boolean().optional(), business_email: email.optional() },
    handler: async p => {
      if (!env.ANALYTICS_API_TOKEN) return { ok: false, code: "NOT_CONFIGURED", message: "Usage queries need the ANALYTICS_API_TOKEN secret." };
      const to = p.to ?? day(), from = p.from ?? day(-29), includeInternal = p.include_internal ?? false;
      const people: Person[] = [];
      for (let offset: number | null = 0; offset !== null;) {
        const page = await registry(env).people({ limit: 100, offset }) as { records: Person[]; next_offset: number | null };
        people.push(...page.records); offset = page.next_offset;
      }
      const internal = people.filter(person => person.internal).map(person => person.user_id);
      const only = p.business_email ? (await adminTarget(p.business_email)).userId : undefined;
      const queries = usageQueries(from, to, includeInternal ? [] : internal, only);
      const events = Object.fromEntries(await Promise.all(Object.entries(queries).map(async ([name, sql]) => [name, await queryUsage(env, sql)])));
      // Events carry the OAuth client ID; the registry knows each client's name from sign-in.
      const names = new Map(people.flatMap(person => person.connections.map(c => [c.client_id, c.client_name] as const)));
      events.clients = (events.clients as Record<string, unknown>[]).map(row => ({ client: row.client, client_name: names.get(String(row.client)) ?? null, calls: row.calls }));
      const businesses = { count: 0, record_counts: {} as Record<string, number>, by_currency: {} as Record<string, number>, by_country: {} as Record<string, number> };
      const plan_pressure = { new_records: 0, issued_invoices: 0 };
      const bump = (map: Record<string, number>, key: string, by = 1) => { map[key] = (map[key] ?? 0) + by; };
      for (const person of people) {
        if (!person.business_id || (person.internal && !includeInternal)) continue;
        const summary = JSON.parse(await eu(env.BUSINESSES).getByName(person.business_id).adminSummary()) as { business: Business | null; record_counts: Record<string, number>; usage: { new_records_this_month: number; issued_invoices_this_month: number } };
        if (!summary.business) continue;
        businesses.count++;
        for (const [kind, n] of Object.entries(summary.record_counts)) if (kind !== "audit") bump(businesses.record_counts, kind, n);
        bump(businesses.by_currency, summary.business.currency);
        if (summary.business.tax_profile?.country) bump(businesses.by_country, summary.business.tax_profile.country);
        if (summary.usage.new_records_this_month >= FREE_PLAN.new_records_per_month * 0.8) plan_pressure.new_records++;
        if (summary.usage.issued_invoices_this_month >= FREE_PLAN.issued_invoices_per_month * 0.8) plan_pressure.issued_invoices++;
      }
      return { ok: true, data: { range: { from, to }, include_internal: includeInternal, events, businesses, plan_pressure } };
    }
  },
  admin_feedback_list: {
    title: "Admin: feedback", description: "Feedback people sent with feedback_send, newest first: kind, message, assistant, date, delivery, and the reply email only when they agreed to a reply. internal marks admin and test accounts. To see who sent a message, call admin_account_get with its account_id.",
    input: { kind: z.enum(["feature", "problem", "other"]).optional(), from: date.optional(), to: date.optional(), limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).default(0) },
    handler: async p => {
      const page = JSON.parse(await eu(env.FEEDBACK).getByName("inbox").list(p)) as { records: { id: string; account_id: string; received_at: string; kind: string; message: string; client?: string; email?: string; delivery: string }[]; next_offset: number | null };
      const internal = new Map<string, boolean>();
      for (const id of new Set(page.records.map(r => r.account_id))) internal.set(id, ((await registry(env).person(id)) as Person | null)?.internal === 1);
      return { ok: true, data: { records: page.records.map(r => ({ feedback_id: r.id, received_at: r.received_at, kind: r.kind, message: r.message, client: r.client ?? null,
        delivery: r.delivery, reply_email: r.email ?? null, account_id: r.account_id, internal: internal.get(r.account_id) ?? false })), next_offset: page.next_offset } };
    }
  },
  admin_users_list: {
    title: "Admin: people", description: "List people with their email, sign-up date, last active day, milestones and status, newest first. Shows personal data: give a reason.",
    input: { reason, filter: z.enum(["active", "dormant", "internal", "suspended"]).optional(), limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).default(0) },
    handler: async (p, admin) => {
      await log(env, admin, "admin_users_list", p.reason, "ok");
      return { ok: true, data: await registry(env).people({ filter: p.filter, limit: p.limit, offset: p.offset }) };
    }
  },
  admin_account_get: {
    title: "Admin: one account", description: "One person's account by sign-in email, or by the account ID on a feedback message: registry facts, connected assistants, plan usage, stored records by kind and the feedback they sent. By email it works for people the registry has not seen. Give a reason.",
    input: { reason, email: email.optional(), user_id: z.string().regex(/^[0-9a-f]{64}$/).optional().describe("The account_id from admin_feedback_list.") },
    handler: async (p, admin) => {
      let address = p.email as string | undefined;
      if (!address && p.user_id) {
        address = ((await registry(env).person(p.user_id)) as Person | null)?.email ?? undefined;
        if (!address) return { ok: false, code: "NOT_FOUND", message: "The registry has no email for this account ID. Ask for the person's sign-in email." };
      }
      if (!address) return { ok: false, code: "INVALID_INPUT", message: "Give email or user_id." };
      const t = await adminTarget(address);
      await log(env, admin, "admin_account_get", p.reason, "ok", t);
      const person = await registry(env).person(t.userId) as Person | null;
      const summary = JSON.parse(await eu(env.BUSINESSES).getByName(t.businessId).adminSummary());
      const grants = (await authorizationServer(env).getOAuthApi(env).listUserGrants(t.userId)).items.map(g => ({ client_id: g.clientId, created_at: new Date(g.createdAt * 1000).toISOString() }));
      const feedback = JSON.parse(await eu(env.FEEDBACK).getByName("inbox").forAccount(t.userId));
      return { ok: true, data: { email: t.email, user_id: t.userId, business_id: t.businessId, registered: !!person, person, ...summary, grants, feedback } };
    }
  },
  admin_records_read: {
    title: "Admin: read records", description: "Run one read operation on a person's business, as its owner would see it, without counting toward their limits or entering their history. Read-only. Give a reason.",
    input: { reason, email, operation: z.enum(ADMIN_READS), input: z.record(z.string(), z.unknown()).optional().describe("The read operation's own input, such as invoice_id or limit.") },
    handler: async (p, admin) => {
      const t = await adminTarget(p.email);
      const result = JSON.parse(await eu(env.BUSINESSES).getByName(t.businessId).adminRead(p.operation, p.input ?? {})) as DomainResult;
      await log(env, admin, "admin_records_read", p.reason, result.ok ? "ok" : result.code, t);
      return result;
    }
  },
  admin_account_suspend: {
    title: "Admin: suspend account", description: "Suspend an account for abuse or a suspected takeover: disconnects every assistant, blocks new sign-ins and emails the person your message. Records are kept. reason stays internal in the access log; message is what the person receives.",
    input: { reason, email, message: z.string().trim().min(10).max(2000).describe("The explanation emailed to the person.") }, destructive: true,
    handler: async (p, admin) => {
      const target = await actionTarget(env, admin, "admin_account_suspend", p.reason, p.email);
      if ("ok" in target) return target;
      const { t } = target;
      // Logged before any side effect, so a suspension that fails midway is still on record.
      await log(env, admin, "admin_account_suspend", p.reason, "started", t);
      await registry(env).setStatus(t.userId, "suspended", admin.email!, p.reason, new Date().toISOString(), t.email, t.businessId);
      const grants_revoked = await revokeAll(env, t.userId);
      const notified = await notifySuspended(env, t.email, p.message);
      await log(env, admin, "admin_account_suspend", p.reason, "suspended", t);
      return { ok: true, data: { status: "suspended", grants_revoked, notified } };
    }
  },
  admin_account_unsuspend: {
    title: "Admin: lift suspension", description: "Lift a suspension. The person can sign in again and is emailed that access is restored, with your optional message.",
    input: { reason, email, message: z.string().trim().min(10).max(2000).optional() }, destructive: true,
    handler: async (p, admin) => {
      const t = await adminTarget(p.email);
      const person = await registry(env).person(t.userId) as Person | null;
      if (person?.status !== "suspended") { await log(env, admin, "admin_account_unsuspend", p.reason, "NOT_SUSPENDED", t); return { ok: false, code: "NOT_SUSPENDED", message: "This account is not suspended." }; }
      await registry(env).setStatus(t.userId, "active", admin.email!, p.reason, new Date().toISOString());
      const notified = await notifyRestored(env, t.email, p.message);
      await log(env, admin, "admin_account_unsuspend", p.reason, "active", t);
      return { ok: true, data: { status: "active", notified } };
    }
  },
  admin_account_delete: {
    title: "Admin: delete account", description: "Delete an account and all its records, for a deletion request. Call first without confirm: nothing changes and you get what will be deleted. Show it to the user, then call again with confirm set to the same email. This cannot be undone.",
    input: { reason, email, confirm: z.string().trim().max(254).optional().describe("The same email, to confirm the deletion.") }, destructive: true,
    handler: async (p, admin) => {
      const target = await actionTarget(env, admin, "admin_account_delete", p.reason, p.email);
      if ("ok" in target) return target;
      const { t, person } = target;
      if (p.confirm === undefined) {
        const summary = JSON.parse(await eu(env.BUSINESSES).getByName(t.businessId).adminSummary());
        await log(env, admin, "admin_account_delete", p.reason, "previewed", t);
        return { ok: true, data: { will_delete: { email: t.email, business_name: summary.business?.name ?? null, record_counts: summary.record_counts,
          issued_invoices: summary.issued_invoices, connections: person?.connections ?? [] }, next: "Call again with confirm set to the same email." } };
      }
      if (p.confirm.toLowerCase() !== t.email) {
        await log(env, admin, "admin_account_delete", p.reason, "CONFIRMATION_MISMATCH", t);
        return { ok: false, code: "CONFIRMATION_MISMATCH", message: "confirm must be the same email. Nothing was deleted." };
      }
      // Logged before any side effect, so a deletion that fails midway is still on record.
      await log(env, admin, "admin_account_delete", p.reason, "confirmed", t);
      await revokeAll(env, t.userId);
      // Objects made before the EU switch (2026-10-22) sit outside the jurisdiction under the same names; clear those too.
      const namespaces = <T extends Rpc.DurableObjectBranded>(ns: DurableObjectNamespace<T>) => env.DO_JURISDICTION === "eu" ? [eu(ns), ns] : [ns];
      for (const ns of namespaces(env.BUSINESSES)) await ns.getByName(t.businessId).erase();
      for (const ns of namespaces(env.ACCOUNTS)) await ns.getByName(t.userId).erase();
      for (const ns of namespaces(env.FEEDBACK)) await ns.getByName("inbox").eraseAccount(t.userId);
      await log(env, admin, "admin_account_delete", p.reason, "deleted", t);
      await registry(env).tombstone(t.userId, new Date().toISOString());
      return { ok: true, data: { deleted: true } };
    }
  },
  admin_access_log: {
    title: "Admin: access log", description: "Every admin lookup and action, newest first: who, which tool, which person, the reason and the outcome.",
    input: { limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).default(0) },
    handler: async p => ({ ok: true, data: await registry(env).accessLog(p.limit, p.offset) })
  }
});

/** Revokes every OAuth grant the person holds, page by page; returns how many. */
async function revokeAll(env: Env, userId: string): Promise<number> {
  const oauth = authorizationServer(env).getOAuthApi(env);
  let revoked = 0, cursor: string | undefined;
  do {
    const page = await oauth.listUserGrants(userId, { cursor });
    for (const grant of page.items) { await oauth.revokeGrant(grant.id, userId); revoked++; }
    cursor = page.cursor;
  } while (cursor);
  return revoked;
}

/** Account actions refuse admin addresses, and people Otis has neither registered nor stored a business for. */
async function actionTarget(env: Env, admin: Identity, tool: string, why: string, address: string): Promise<{ t: Awaited<ReturnType<typeof adminTarget>>; person: Person | null } | Extract<DomainResult, { ok: false }>> {
  const t = await adminTarget(address);
  const refuse = async (code: string, message: string) => { await log(env, admin, tool, why, code, t); return { ok: false as const, code, message }; };
  if (emailList(env.ADMIN_EMAILS).includes(t.email)) return refuse("ADMIN_PROTECTED", "Admin accounts cannot be suspended or deleted. Remove the address from ADMIN_EMAILS first.");
  const person = await registry(env).person(t.userId) as Person | null;
  if (!person && !JSON.parse(await eu(env.BUSINESSES).getByName(t.businessId).adminSummary()).business) return refuse("NOT_FOUND", "Otis has no account for this email.");
  return { t, person };
}

/** One access-log entry, written before the tool returns personal data. */
export async function log(env: Env, admin: Identity, tool: string, why: string, outcome: string, target?: { email: string; userId: string }): Promise<void> {
  await registry(env).log({ admin: admin.email!, tool, targetUserId: target?.userId, targetEmail: target?.email, reason: why, outcome, at: new Date().toISOString() });
}

export function registerAdminTools(server: McpServer, env: Env, identity: Identity): void {
  for (const [name, tool] of Object.entries(adminTools(env))) {
    server.registerTool(name, {
      title: tool.title, description: tool.description, inputSchema: tool.input,
      annotations: { readOnlyHint: !tool.destructive, destructiveHint: !!tool.destructive, idempotentHint: true, openWorldHint: false }
    }, async (input: unknown) => {
      let result: AdminResult;
      try {
        result = isAdmin(env, identity) ? await tool.handler(input, identity) : { ok: false, code: "FORBIDDEN", message: "Admin access is not available." };
      } catch (e) {
        result = { ok: false, code: e instanceof z.ZodError ? "INVALID_INPUT" : "RETRY", message: e instanceof z.ZodError ? z.prettifyError(e) : "Otis could not complete the request." };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown>, isError: !result.ok };
    });
  }
}
