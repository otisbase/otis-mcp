import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { digest } from "../src/auth";
import { eu } from "../src/regions";
import { privateOperation } from "../src/mcp";
import { isAdmin } from "../src/admin";
import { registry } from "../src/registry";
import type { DomainResult } from "../src/models";
import { authFlow, connected, localFetch, origin, rid, settle } from "./auth-fixture";

type Tool = { structuredContent?: DomainResult; isError?: boolean };
function value<T = any>(r: DomainResult | undefined): T {
  if (!r?.ok) throw new Error(`${r?.code}: ${r?.message}`);
  return r.data as T;
}
const today = () => new Date().toISOString().slice(0, 10);

/** An admin connection, plus a target person with a business created through the private tools. */
async function admin(bindings: Partial<Env> = {}) {
  const adminEmail = `admin-${rid()}@example.com`;
  const c = await connected(adminEmail, { ADMIN_EMAILS: `someone@example.com, ${adminEmail}`, ...bindings });
  const call = async (name: string, args: Record<string, unknown>) => await c.client.callTool({ name, arguments: args }) as Tool;
  return { ...c, adminEmail, call };
}
async function target() {
  const email = `${rid()}@example.com`;
  const who = { userId: await digest(`otis-user:${email}`), email };
  value(await privateOperation(env, who, "business_set", { request_id: rid(), name: "Target Studio", currency: "USD" }));
  value(await privateOperation(env, who, "client_save", { request_id: rid(), name: "Target Client" }));
  const businessId = await digest(`otis-business:${who.userId}`);
  const store = () => eu(env.BUSINESSES).getByName(businessId);
  const counter = (name: string) => runInDurableObject(store(), (_i, state) => state.storage.sql.exec<{ value: number }>("SELECT value FROM counters WHERE name = ?", name).toArray()[0]?.value ?? 0);
  const audits = () => runInDurableObject(store(), (_i, state) => state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM records WHERE kind = 'audit'").one().n);
  return { email, who, businessId, counter, audits };
}
const logFor = async (email: string) => (await registry(env).accessLog(1000, 0)).records.filter(r => r.target_email === email);

describe("admin access", () => {
  it("admins see admin tools and others do not", async () => {
    const a = await admin();
    expect((await a.client.listTools()).tools.map(t => t.name)).toEqual(expect.arrayContaining(["admin_stats", "admin_users_list", "admin_account_get", "admin_records_read", "admin_access_log"]));
    const other = await connected(undefined, { ADMIN_EMAILS: a.adminEmail });
    expect((await other.client.listTools()).tools.filter(t => t.name.startsWith("admin_"))).toEqual([]);
  });

  it("admin tools are not in public docs", async () => {
    const tools = await (await localFetch({ ...env, ADMIN_EMAILS: "a@example.com" } as Env)(`${origin}/docs/tools.json`)).json() as Record<string, unknown>;
    expect(Object.keys(tools).filter(name => name.startsWith("admin_"))).toEqual([]);
  });

  it("a connection without an email is never an admin", () => {
    const bindings = { ...env, ADMIN_EMAILS: "a@example.com" } as Env;
    expect(isAdmin(bindings, { userId: rid() })).toBe(false);
    expect(isAdmin(bindings, { userId: rid(), email: "A@Example.com" })).toBe(true);
    expect(isAdmin({ ...env, ADMIN_EMAILS: undefined } as Env, { userId: rid(), email: "a@example.com" })).toBe(false);
  });

  it("reason-required tools refuse without a reason", async () => {
    const a = await admin(), t = await target();
    const result = await a.call("admin_account_get", { email: t.email });
    expect(result.isError).toBe(true);
    expect(await logFor(t.email)).toEqual([]);
  });

  it("admin_records_read reads without counting or auditing", async () => {
    const a = await admin(), t = await target();
    const requests = await t.counter(`requests:${today()}`), audits = await t.audits();
    const read = value((await a.call("admin_records_read", { reason: "Support ticket 12", email: t.email, operation: "clients_list" })).structuredContent);
    expect(read.records.map((c: { name: string }) => c.name)).toEqual(["Target Client"]);
    expect(await t.counter(`requests:${today()}`)).toBe(requests);
    expect(await t.audits()).toBe(audits);
    expect(await logFor(t.email)).toEqual([expect.objectContaining({ admin: a.adminEmail, tool: "admin_records_read", reason: "Support ticket 12", outcome: "ok", target_user_id: t.who.userId })]);
  });

  it("admin_records_read refuses writes", async () => {
    const a = await admin(), t = await target();
    expect((await a.call("admin_records_read", { reason: "Support ticket 12", email: t.email, operation: "client_save", input: { request_id: rid(), name: "X" } })).isError).toBe(true);
  });

  it("admin_account_get works for someone not in the registry", async () => {
    const a = await admin(), t = await target();
    const account = value((await a.call("admin_account_get", { reason: "Bug report", email: t.email })).structuredContent);
    expect(account).toMatchObject({ email: t.email, user_id: t.who.userId, business_id: t.businessId, registered: false });
    expect(account.business.name).toBe("Target Studio");
    expect(account.record_counts).toMatchObject({ business: 1, client: 1 });
    expect(account.grants).toEqual([]);
  });

  it("admin_account_get shows the registry person and their grants", async () => {
    const a = await admin(), email = `${rid()}@example.com`;
    await connected(email);
    await settle();
    const account = value((await a.call("admin_account_get", { reason: "Bug report", email: email.toUpperCase() })).structuredContent);
    expect(account).toMatchObject({ email, registered: true, person: { first_seen: 0 } });
    expect(account.grants).toHaveLength(1);
  });

  it("admin_stats returns numbers only", async () => {
    const a = await admin();
    await settle();
    const result = await a.call("admin_stats", { include_internal: true });
    const stats = value(result.structuredContent);
    expect(stats.funnel.signed_in).toBeGreaterThan(0);
    expect(stats.feedback).toEqual(expect.any(Object));
    expect(JSON.stringify(stats)).not.toContain("@");
  });

  it("admin_users_list and admin_access_log show people and lookups", async () => {
    const a = await admin();
    await settle();
    const people = value((await a.call("admin_users_list", { reason: "Weekly review", filter: "internal", limit: 100 })).structuredContent);
    expect(people.records.map((p: { email: string }) => p.email)).toContain(a.adminEmail);
    const log = value((await a.call("admin_access_log", {})).structuredContent);
    expect(log.records[0]).toMatchObject({ admin: a.adminEmail, tool: "admin_users_list", reason: "Weekly review" });
  });
});

describe("admin suspend", () => {
  const mcpStatus = async (c: Awaited<ReturnType<typeof connected>>) => (await c.fetcher(`${origin}/mcp`, { method: "POST",
    headers: { Authorization: `Bearer ${c.tokens.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).status;
  const signIn = async (email: string) => {
    const flow = await authFlow({ email });
    expect((await flow.send()).status).toBe(200);
    return (await flow.post("/authorize/verify", { code: flow.code() })).status;
  };

  it("suspend disconnects, blocks sign-in and emails the reason", async () => {
    const a = await admin(), email = `${rid()}@example.com`, t = await connected(email);
    expect(await mcpStatus(t)).toBe(200);
    const result = value((await a.call("admin_account_suspend", { reason: "Spam reports from three clients", email, message: "We received reports that this account sent spam invoices." })).structuredContent);
    expect(result).toEqual({ status: "suspended", grants_revoked: 1, notified: true });
    expect(await mcpStatus(t)).toBe(401);
    expect(await signIn(email)).toBe(403);
    const notice = a.deliveries.find(d => d.to === email)!;
    expect(notice.text).toContain("We received reports that this account sent spam invoices.");
    expect((await registry(env).personByEmail(email))!).toMatchObject({ status: "suspended", status_by: a.adminEmail, status_reason: "Spam reports from three clients" });
  });

  it("unsuspend allows sign-in again", async () => {
    const a = await admin(), email = `${rid()}@example.com`;
    await connected(email);
    value((await a.call("admin_account_suspend", { reason: "Suspected takeover", email, message: "We saw sign-ins we could not explain." })).structuredContent);
    expect(value((await a.call("admin_account_unsuspend", { reason: "Owner confirmed", email })).structuredContent)).toMatchObject({ status: "active", notified: true });
    expect(await signIn(email)).toBe(303);
    expect(a.deliveries.filter(d => d.to === email).map(d => (d as { subject?: string }).subject)).toContain("Your Otis account is active again");
  });

  it("a suspension that fails midway is still in the access log", async () => {
    const failingKv = new Proxy(env.OAUTH_KV, { get: (kv, key) => key === "list" ? async () => { throw new Error("KV list failed"); } : (kv as any)[key].bind(kv) });
    const a = await admin({ OAUTH_KV: failingKv as KVNamespace }), email = `${rid()}@example.com`;
    await connected(email);
    expect((await a.call("admin_account_suspend", { reason: "Abuse report", email, message: "We received reports about this account." })).structuredContent).toMatchObject({ ok: false, code: "RETRY" });
    expect((await logFor(email)).map(r => r.outcome)).toEqual(["started"]);
  });

  it("admins cannot be suspended", async () => {
    const a = await admin();
    expect((await a.call("admin_account_suspend", { reason: "Testing", email: "someone@example.com", message: "This should never be sent." })).structuredContent).toMatchObject({ ok: false, code: "ADMIN_PROTECTED" });
  });

  it("suspend refuses people Otis has never seen", async () => {
    const a = await admin();
    expect((await a.call("admin_account_suspend", { reason: "Testing", email: `${rid()}@example.com`, message: "This should never be sent." })).structuredContent).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("suspend writes the access log with the internal reason, not the message", async () => {
    const a = await admin(), email = `${rid()}@example.com`;
    await connected(email);
    value((await a.call("admin_account_suspend", { reason: "Internal note: chargeback", email, message: "Your account broke the Terms of Service." })).structuredContent);
    expect(await logFor(email)).toEqual([
      expect.objectContaining({ tool: "admin_account_suspend", reason: "Internal note: chargeback", outcome: "suspended" }),
      expect.objectContaining({ tool: "admin_account_suspend", reason: "Internal note: chargeback", outcome: "started" })
    ]);
    expect(JSON.stringify(await logFor(email))).not.toContain("broke the Terms");
  });
});

describe("admin delete", () => {
  const feedbackRows = (accountId: string) => runInDurableObject(eu(env.FEEDBACK).getByName("inbox"), (_i, state) =>
    state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM feedback WHERE account_id = ?", accountId).one().n);
  const confirmDelete = (a: Awaited<ReturnType<typeof admin>>, email: string, confirm?: string) =>
    a.call("admin_account_delete", { reason: "Privacy request 2026-10-25", email, ...(confirm === undefined ? {} : { confirm }) });

  it("delete previews first and changes nothing", async () => {
    const a = await admin(), t = await target();
    const preview = value((await confirmDelete(a, t.email)).structuredContent);
    expect(preview.will_delete).toMatchObject({ email: t.email, business_name: "Target Studio", record_counts: { business: 1, client: 1 }, issued_invoices: 0 });
    expect(preview.next).toBe("Call again with confirm set to the same email.");
    expect(await t.audits()).toBeGreaterThan(0);
    expect(await logFor(t.email)).toEqual([expect.objectContaining({ tool: "admin_account_delete", outcome: "previewed" })]);
  });

  it("delete removes records, index, feedback, grants and identity", async () => {
    const a = await admin(), email = `${rid()}@example.com`;
    const c = await connected(email);
    await c.client.callTool({ name: "business_set", arguments: { request_id: rid(), name: "Doomed", currency: "USD" } });
    const userId = await digest(`otis-user:${email}`);
    await privateOperation(env, { userId, email }, "feedback_send", { request_id: rid(), kind: "feature", message: "Please add recurring invoices." });
    await settle();
    expect(await feedbackRows(userId)).toBe(1);
    const before = (await registry(env).stats({ from: today(), to: today(), includeInternal: true })).deleted;
    expect(value((await confirmDelete(a, email, email.toUpperCase())).structuredContent)).toEqual({ deleted: true });
    expect(await feedbackRows(userId)).toBe(0);
    expect(await registry(env).personByEmail(email)).toBeNull();
    expect((await registry(env).stats({ from: today(), to: today(), includeInternal: true })).deleted).toBe(before + 1);
    expect((await c.client.callTool({ name: "business_get", arguments: {} }).catch(() => ({ revoked: true })))).toEqual({ revoked: true });
    const again = await connected(email);
    expect((await again.client.callTool({ name: "business_get", arguments: {} }) as Tool).structuredContent).toMatchObject({ ok: true, data: { setup_required: true } });
    expect((await logFor(email)).map(r => r.outcome)).toEqual([]);
    expect((await registry(env).accessLog(1000, 0)).records.find(r => r.target_user_id === userId && r.outcome === "deleted")).toMatchObject({ target_email: null });
  });

  it("a deletion that fails midway is still in the access log", async () => {
    const failingKv = new Proxy(env.OAUTH_KV, { get: (kv, key) => key === "list" ? async () => { throw new Error("KV list failed"); } : (kv as any)[key].bind(kv) });
    const a = await admin({ OAUTH_KV: failingKv as KVNamespace }), t = await target();
    expect((await confirmDelete(a, t.email, t.email)).structuredContent).toMatchObject({ ok: false, code: "RETRY" });
    expect((await logFor(t.email)).map(r => r.outcome)).toEqual(["confirmed"]);
  });

  it("a mismatched confirmation deletes nothing", async () => {
    const a = await admin(), t = await target();
    expect((await confirmDelete(a, t.email, "someone-else@example.com")).structuredContent).toMatchObject({ ok: false, code: "CONFIRMATION_MISMATCH" });
    expect(await t.audits()).toBeGreaterThan(0);
  });

  it("deleting twice returns NOT_FOUND", async () => {
    const a = await admin(), t = await target();
    value((await confirmDelete(a, t.email, t.email)).structuredContent);
    expect((await confirmDelete(a, t.email, t.email)).structuredContent).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("admins cannot be deleted", async () => {
    const a = await admin();
    expect((await confirmDelete(a, a.adminEmail, a.adminEmail)).structuredContent).toMatchObject({ ok: false, code: "ADMIN_PROTECTED" });
  });
});

describe("admin feedback", () => {
  const send = (who: { userId: string; email: string }, kind: string, message: string, reply_ok = false) =>
    privateOperation(env, who, "feedback_send", { request_id: rid(), kind, message, reply_ok });
  const someone = async () => { const email = `${rid()}@example.com`; return { userId: await digest(`otis-user:${email}`), email }; };

  it("admin_feedback_list shows every message newest first, with the reply email only when agreed", async () => {
    const a = await admin(), quiet = await someone(), chatty = await someone();
    value(await send(quiet, "problem", "The invoice total looked wrong."));
    value(await send(chatty, "feature", "Please add recurring invoices.", true));
    const { records } = value((await a.call("admin_feedback_list", { limit: 100 })).structuredContent);
    const ours = records.filter((r: { account_id: string }) => [quiet.userId, chatty.userId].includes(r.account_id));
    expect(ours.map((r: { message: string }) => r.message)).toEqual(["Please add recurring invoices.", "The invoice total looked wrong."]);
    expect(ours[0]).toMatchObject({ kind: "feature", reply_email: chatty.email, internal: false });
    expect(ours[1]).toMatchObject({ kind: "problem", reply_email: null });
    expect(JSON.stringify(ours[1])).not.toContain(quiet.email);
  });

  it("admin_feedback_list filters by kind and marks internal accounts", async () => {
    const a = await admin();
    value(await send({ userId: await digest(`otis-user:${a.adminEmail}`), email: a.adminEmail }, "other", "Testing feedback from the admin account."));
    await settle();
    const { records } = value((await a.call("admin_feedback_list", { kind: "other", limit: 100 })).structuredContent);
    expect(records.every((r: { kind: string }) => r.kind === "other")).toBe(true);
    expect(records.find((r: { message: string }) => r.message === "Testing feedback from the admin account.")).toMatchObject({ internal: true });
  });

  it("admin_account_get finds the sender of a feedback message by account ID", async () => {
    const a = await admin(), email = `${rid()}@example.com`;
    await connected(email);
    await settle();
    const userId = await digest(`otis-user:${email}`);
    const account = value((await a.call("admin_account_get", { reason: "Reply to feedback", user_id: userId })).structuredContent);
    expect(account).toMatchObject({ email, user_id: userId, registered: true });
    expect(await logFor(email)).toEqual([expect.objectContaining({ tool: "admin_account_get", reason: "Reply to feedback" })]);
  });

  it("admin_account_get needs an email or a known account ID", async () => {
    const a = await admin();
    expect((await a.call("admin_account_get", { reason: "Lookup" })).structuredContent).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect((await a.call("admin_account_get", { reason: "Lookup", user_id: "f".repeat(64) })).structuredContent).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});
