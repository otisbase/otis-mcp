import { env } from "cloudflare:workers";
import { eu } from "../src/regions";
import { runInDurableObject } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { privateOperation } from "../src/mcp";
import { FEEDBACK_PER_DAY, type DomainResult } from "../src/models";
import { connected, localFetch, origin, rid } from "./auth-fixture";

type Sent = { to: string; from: string; subject: string; text: string; replyTo?: string };
function value<T = any>(r: DomainResult): T {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.data as T;
}
const today = () => new Date().toISOString().slice(0, 10);
const nextMidnight = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString(); };
// A mocked send_email binding, as in the sign-in tests; nothing leaves the test.
function mailer(failing = false) {
  const sent: Sent[] = [];
  const bindings: Env = { ...env, EMAIL: { send: async (message: unknown) => {
    if (failing) throw Object.assign(new Error("Simulated email outage"), { code: "E_DELIVERY_FAILED" });
    sent.push(message as Sent);
    return { messageId: "local-only" };
  } } as SendEmail };
  return { bindings, sent, fail: (on: boolean) => { failing = on; } };
}
const person = () => ({ userId: rid(), email: `${rid()}@example.com` });
const inbox = () => eu(env.FEEDBACK).getByName("inbox");
const stored = (accountId: string) => runInDurableObject(inbox(), (_instance, state) =>
  state.storage.sql.exec<{ data: string }>("SELECT data FROM feedback WHERE account_id = ? ORDER BY rowid", accountId).toArray().map(row => JSON.parse(row.data)));
const feature = (extra: Record<string, unknown> = {}) => ({ request_id: rid(), kind: "feature", message: "Please add recurring invoices.", ...extra });

describe("feedback_send", () => {
  it("saves the message and emails it to support without the person's email by default", async () => {
    const m = mailer(), who = person();
    const result = value(await privateOperation(m.bindings, who, "feedback_send", feature({ client: "Claude Code" })));
    expect(result).toMatchObject({ saved: true, delivery: "sent", kind: "feature", reply_email: null, remaining_today: FEEDBACK_PER_DAY - 1 });
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0]).toMatchObject({ to: "support@otisbase.com", from: env.EMAIL_FROM, subject: "Otis feedback: feature" });
    expect(m.sent[0].replyTo).toBeUndefined();
    expect(m.sent[0].text).toContain("Please add recurring invoices.");
    expect(m.sent[0].text).toContain("Sent from: Claude Code");
    expect(m.sent[0].text).toContain(result.feedback_id);
    expect(m.sent[0].text).not.toContain(who.email);
    const [saved] = await stored(who.userId);
    expect(saved).toMatchObject({ id: result.feedback_id, kind: "feature", message: "Please add recurring invoices.", client: "Claude Code", delivery: "sent", account_id: who.userId });
    expect(saved.business_id).toMatch(/^[a-f0-9]{64}$/);
    expect(saved.email).toBeUndefined();
    expect(saved.received_at).toBe(result.received_at);
  });

  it("includes the verified email only when reply_ok is true", async () => {
    const m = mailer(), who = person();
    const result = value(await privateOperation(m.bindings, who, "feedback_send", feature({ kind: "problem", message: "The export stopped at page two.", reply_ok: true })));
    expect(result.reply_email).toBe(who.email);
    expect(m.sent[0]).toMatchObject({ subject: "Otis feedback: problem", replyTo: who.email });
    expect(m.sent[0].text).toContain(`Reply to: ${who.email}`);
    expect((await stored(who.userId))[0].email).toBe(who.email);
  });

  it("refuses reply_ok when the connection carries no verified email, and saves nothing", async () => {
    const m = mailer(), who = { userId: rid() };
    expect(await privateOperation(m.bindings, who, "feedback_send", feature({ reply_ok: true }))).toMatchObject({ ok: false, code: "REPLY_EMAIL_UNAVAILABLE" });
    expect(await stored(who.userId)).toHaveLength(0);
    expect(m.sent).toHaveLength(0);
    // Without reply_ok the same connection can still send.
    value(await privateOperation(m.bindings, who, "feedback_send", feature()));
  });

  it("keeps the saved message when email fails, and a retry with the same request_id sends it, counted once", async () => {
    const m = mailer(true), who = person(), input = feature();
    const failed = value(await privateOperation(m.bindings, who, "feedback_send", input));
    expect(failed).toMatchObject({ saved: true, delivery: "failed" });
    expect(failed.notice).toContain("same request_id");
    expect(await stored(who.userId)).toMatchObject([{ id: failed.feedback_id, delivery: "failed", delivery_error: "E_DELIVERY_FAILED" }]);
    m.fail(false);
    const retried = value(await privateOperation(m.bindings, who, "feedback_send", input));
    expect(retried).toMatchObject({ feedback_id: failed.feedback_id, delivery: "sent", remaining_today: FEEDBACK_PER_DAY - 1 });
    expect(m.sent).toHaveLength(1);
    const saved = await stored(who.userId);
    expect(saved).toHaveLength(1);
    expect(saved[0].delivery).toBe("sent");
    expect(saved[0].delivery_error).toBeUndefined();
    // Once sent, another identical retry neither saves nor emails again.
    expect(value(await privateOperation(m.bindings, who, "feedback_send", input)).feedback_id).toBe(failed.feedback_id);
    expect(m.sent).toHaveLength(1);
  });

  it("rejects a different message under a request_id that was already used", async () => {
    const m = mailer(), who = person(), input = feature();
    value(await privateOperation(m.bindings, who, "feedback_send", input));
    expect(await privateOperation(m.bindings, who, "feedback_send", { ...input, message: "Something else" })).toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
    expect(await stored(who.userId)).toHaveLength(1);
  });

  it("allows 20 messages per person per UTC day, separately for each person, and resets at 00:00 UTC", async () => {
    const m = mailer(), who = person(), first = feature();
    value(await privateOperation(m.bindings, who, "feedback_send", first));
    for (let i = 1; i < FEEDBACK_PER_DAY; i++) value(await privateOperation(m.bindings, who, "feedback_send", feature()));
    const refused = await privateOperation(m.bindings, who, "feedback_send", feature());
    expect(refused).toMatchObject({ ok: false, code: "FEEDBACK_LIMIT",
      details: { limit: "feedback_per_day", allowed: 20, used: 20, resets_at: nextMidnight() } });
    expect(m.sent).toHaveLength(FEEDBACK_PER_DAY);
    // A retry of an earlier message returns its saved result instead of counting again.
    expect(value(await privateOperation(m.bindings, who, "feedback_send", first)).remaining_today).toBe(0);
    expect(m.sent).toHaveLength(FEEDBACK_PER_DAY);
    value(await privateOperation(m.bindings, person(), "feedback_send", feature()));
    // Yesterday's messages no longer count.
    await runInDurableObject(inbox(), (_instance, state) => { state.storage.sql.exec("UPDATE feedback SET day = '2000-01-01' WHERE account_id = ?", who.userId); });
    expect(value(await privateOperation(m.bindings, who, "feedback_send", feature())).remaining_today).toBe(FEEDBACK_PER_DAY - 1);
  });

  it("does not count toward the business plan limits or touch business records", async () => {
    const m = mailer(), who = person();
    const business_id = value(await privateOperation(m.bindings, who, "business_set", { request_id: rid(), name: "Feedback QA", currency: "AUD" })).business_id as string;
    const counters = () => runInDurableObject(eu(env.BUSINESSES).getByName(business_id), (_instance, state) =>
      state.storage.sql.exec<{ name: string; value: number }>("SELECT name, value FROM counters ORDER BY name").toArray());
    const before = await counters();
    value(await privateOperation(m.bindings, who, "feedback_send", feature()));
    expect(await counters()).toEqual(before);
    expect(before.find(c => c.name === `requests:${today()}`)?.value).toBe(1);
    expect((await stored(who.userId))[0].business_id).toBe(business_id);
  });

  it("validates kind and message length", async () => {
    const m = mailer(), who = person();
    await expect(privateOperation(m.bindings, who, "feedback_send", feature({ kind: "praise" }))).rejects.toThrow();
    await expect(privateOperation(m.bindings, who, "feedback_send", feature({ message: "   " }))).rejects.toThrow();
    await expect(privateOperation(m.bindings, who, "feedback_send", feature({ message: "x".repeat(4001) }))).rejects.toThrow();
    value(await privateOperation(m.bindings, who, "feedback_send", feature({ message: "x".repeat(4000) })));
    expect(m.sent).toHaveLength(1);
  });

  it("is offered on the private endpoint with approval-first guidance and sends the verified email when asked", async () => {
    const email = `${rid()}@example.com`, a = await connected(email);
    try {
      expect(a.client.getInstructions()).toContain("feedback_send");
      const tool = (await a.client.listTools()).tools.find(t => t.name === "feedback_send")!;
      expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
      expect(tool.description).toContain("never send unprompted");
      expect(tool.description).toContain("Ask before setting reply_ok");
      const result = await a.client.callTool({ name: "feedback_send", arguments: { request_id: rid(), kind: "other", message: "Transport feedback", reply_ok: true } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ ok: true, data: { delivery: "sent", reply_email: email } });
      const sent = (a.deliveries as Sent[]).filter(d => d.to === "support@otisbase.com");
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ subject: "Otis feedback: other", replyTo: email });
    } finally { await a.client.close(); }
  });

  it("is not available on the read-only sample", async () => {
    const client = new Client({ name: "feedback-demo", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/demo/mcp`), { fetch: localFetch() }));
    try {
      expect((await client.listTools()).tools.map(t => t.name)).not.toContain("feedback_send");
      expect(client.getInstructions()).not.toContain("feedback_send");
      await expect(client.callTool({ name: "feedback_send", arguments: feature() })).rejects.toThrow();
    } finally { await client.close(); }
  });

  it("publishes its schema in /docs/tools.json and guidance in /llms.txt and the workflows", async () => {
    const fetcher = localFetch();
    const tools = await (await fetcher(`${origin}/docs/tools.json`)).json() as Record<string, { required: string[]; properties: Record<string, unknown> }>;
    expect(tools.feedback_send.required).toEqual(expect.arrayContaining(["request_id", "kind", "message"]));
    expect(Object.keys(tools.feedback_send.properties).sort()).toEqual(["client", "kind", "message", "reply_ok", "request_id"]);
    const llms = await (await fetcher(`${origin}/llms.txt`)).text();
    expect(llms).toContain("feedback_send");
    expect(llms).toContain("Never send feedback unprompted.");
    expect(llms).toContain(`${FEEDBACK_PER_DAY} a day per person`);
    expect(await (await fetcher(`${origin}/docs/workflows.md`)).text()).toContain("feedback_send");
  });
});
