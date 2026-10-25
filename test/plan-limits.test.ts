import { env } from "cloudflare:workers";
import { eu } from "../src/regions";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { privateOperation } from "../src/mcp";
import { FREE_PLAN, type Operation, type DomainResult } from "../src/models";
import { connected, rid } from "./auth-fixture";

function value<T = any>(r: DomainResult): T {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.data as T;
}
const today = () => new Date().toISOString().slice(0, 10);
const month = () => today().slice(0, 7);
const yesterday = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const lastMonth = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7); };
const nextMidnight = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString(); };
const nextMonth = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString(); };
const noTax = { treatment: "not_registered", jurisdiction: "US-NY", reason: "User confirmed no collection obligation for this example", service_category: "consulting" };

async function setup() {
  const owner = { userId: rid() };
  const call = (op: Operation, input: unknown, who = owner) => privateOperation(env, who, op, input);
  const business_id = value(await call("business_set", { request_id: rid(), name: "Plan limits QA", currency: "USD", billing_address: "Business address" })).business_id as string;
  const store = () => eu(env.BUSINESSES).getByName(business_id);
  const setCounter = (name: string, count: number) => runInDurableObject(store(), (_instance, state) => {
    state.storage.sql.exec("INSERT INTO counters(name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value", name, count);
  });
  const counter = (name: string) => runInDurableObject(store(), (_instance, state) =>
    state.storage.sql.exec<{ value: number }>("SELECT value FROM counters WHERE name = ?", name).toArray()[0]?.value ?? 0);
  const stored = (kind: string) => runInDurableObject(store(), (_instance, state) =>
    state.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM records WHERE kind = ?", kind).one().count);
  const newClient = (request_id = rid()) => call("client_save", { request_id, name: "Client", country: "US", region: "NY", customer_type: "business", billing_address: "Client address" });
  return { owner, call, business_id, setCounter, counter, stored, newClient };
}

// A business ready to invoice: tax profile, client and $1,000 of work. draft() reserves part of it.
async function invoicing() {
  const b = await setup();
  value(await b.call("tax_profile_set", { request_id: rid(), profile: { country: "US", region: "NY", registration_status: "not_registered", reviewed_on: "2026-10-20", notes: "User confirmed" } }));
  const client = value(await b.newClient());
  const item = value(await b.call("billable_record", { request_id: rid(), client_id: client.id, kind: "time", description: "Project", quantity: "10", unit: "hour", amount_minor: 100000, rate_minor: 10000 }));
  const draft = async (amount_minor = 10000) => value(await b.call("invoice_draft", { request_id: rid(), client_id: client.id, lines: [{ item_id: item.id, amount_minor, tax: noTax }], due_date: "2026-11-20", supply_date: "2026-10-20" }));
  const issue = (invoice: { id: string; total_minor: number }) => b.call("invoice_issue", { request_id: rid(), invoice_id: invoice.id, expected_total_minor: invoice.total_minor, confirmed: true });
  return { ...b, draft, issue };
}

describe("free plan limits per business", () => {
  it("counts every authorized request and new business records, but not edits, reads or the audit trail", async () => {
    const b = await setup();
    const client = value(await b.newClient());
    value(await b.call("client_save", { request_id: rid(), client_id: client.id, name: "Renamed", country: "US", region: "NY", customer_type: "business" }));
    value(await b.call("clients_list", {}));
    await expect(b.call("client_save", { request_id: rid(), name: "" })).rejects.toThrow();
    // business_set, client_save, client_save (edit) and clients_list; invalid input never reaches the business.
    expect(await b.counter(`requests:${today()}`)).toBe(4);
    // The business, its owner membership and one client; the edit and the audit entries are not new records.
    expect(await b.counter(`created:${month()}`)).toBe(3);
    expect(await b.stored("audit")).toBe(3);
  });

  it("does not let outsiders spend a business's request allowance", async () => {
    const b = await setup(), before = await b.counter(`requests:${today()}`);
    expect(await b.call("clients_list", { business_id: b.business_id }, { userId: rid() })).toMatchObject({ code: "FORBIDDEN" });
    expect(await b.counter(`requests:${today()}`)).toBe(before);
  });

  it("refuses every request, reads included, after 10,000 requests in a UTC day", async () => {
    const b = await setup();
    await b.setCounter(`requests:${today()}`, FREE_PLAN.requests_per_day - 1);
    value(await b.call("business_get", {}));
    const refused = await b.call("business_get", {});
    expect(refused).toMatchObject({ ok: false, code: "PLAN_LIMIT",
      details: { limit: "requests_per_day", allowed: 10_000, used: 10_000, resets_at: nextMidnight() } });
    expect(await b.newClient()).toMatchObject({ code: "PLAN_LIMIT", details: { limit: "requests_per_day" } });
    expect(await b.stored("client")).toBe(0);
    // Refused requests do not add to the count.
    expect(await b.counter(`requests:${today()}`)).toBe(FREE_PLAN.requests_per_day);
  });

  it("refuses new records after 1,000 in a UTC month while reads and edits keep working", async () => {
    const b = await setup();
    const client = value(await b.newClient());
    await b.setCounter(`created:${month()}`, FREE_PLAN.new_records_per_month - 1);
    value(await b.newClient());
    const requestId = rid();
    const refused = await b.newClient(requestId);
    expect(refused).toMatchObject({ ok: false, code: "PLAN_LIMIT",
      details: { limit: "new_records_per_month", allowed: 1_000, used: 1_000, resets_at: nextMonth() } });
    expect((refused as { message: string }).message).toContain("Reads, edits and invoices still work");
    expect(await b.stored("client")).toBe(2);
    expect(value(await b.call("clients_list", {})).records).toHaveLength(2);
    value(await b.call("client_save", { request_id: rid(), client_id: client.id, name: "Edited", country: "US", region: "NY", customer_type: "business" }));
    // A refused request is not recorded, so its request_id works once the limit allows it.
    await b.setCounter(`created:${month()}`, 0);
    value(await b.newClient(requestId));
  });

  it("refuses the whole operation when it would create more records than remain", async () => {
    const b = await setup();
    const client = value(await b.newClient());
    await b.setCounter(`created:${month()}`, FREE_PLAN.new_records_per_month - 1);
    // A billable expense creates two records: the expense and its linked billable.
    const refused = await b.call("expense_record", { request_id: rid(), vendor: "QA", category: "test", description: "QA", cost_minor: 100, incurred_on: "2026-10-21", client_id: client.id, billable_amount_minor: 100 });
    expect(refused).toMatchObject({ code: "PLAN_LIMIT", details: { limit: "new_records_per_month", used: FREE_PLAN.new_records_per_month - 1 } });
    expect(await b.stored("expense")).toBe(0);
    expect(await b.stored("billable")).toBe(0);
    value(await b.call("expense_record", { request_id: rid(), vendor: "QA", category: "test", description: "QA", cost_minor: 100, incurred_on: "2026-10-21" }));
    expect(await b.counter(`created:${month()}`)).toBe(FREE_PLAN.new_records_per_month);
  });

  it("does not count invoices as new records, so drafts and issues work at the record limit", async () => {
    const b = await invoicing();
    await b.setCounter(`created:${month()}`, FREE_PLAN.new_records_per_month);
    const invoice = await b.draft();
    expect(value(await b.issue(invoice)).status).toBe("issued");
    expect(await b.counter(`created:${month()}`)).toBe(FREE_PLAN.new_records_per_month);
    expect(await b.counter(`issued:${month()}`)).toBe(1);
  });

  it("refuses to issue more than 50 invoices in a UTC month and keeps the draft", async () => {
    const b = await invoicing();
    await b.setCounter(`issued:${month()}`, FREE_PLAN.issued_invoices_per_month - 1);
    value(await b.issue(await b.draft()));
    const draft = await b.draft();
    const refused = await b.issue(draft);
    expect(refused).toMatchObject({ ok: false, code: "PLAN_LIMIT",
      details: { limit: "issued_invoices_per_month", allowed: 50, used: 50, resets_at: nextMonth() } });
    expect(value(await b.call("invoice_get", { invoice_id: draft.id })).status).toBe("draft");
    // New drafts are still allowed; only issuing waits for the reset.
    await b.draft();
    await b.setCounter(`issued:${month()}`, 0);
    expect(value(await b.issue(draft)).status).toBe("issued");
  });

  it("does not count an issue that fails for another reason", async () => {
    const b = await invoicing();
    const draft = await b.draft();
    expect(await b.call("invoice_issue", { request_id: rid(), invoice_id: draft.id, expected_total_minor: draft.total_minor + 1, confirmed: true })).toMatchObject({ code: "TOTAL_CHANGED" });
    expect(await b.counter(`issued:${month()}`)).toBe(0);
  });

  it("resets the daily request limit each UTC day and the monthly limits each UTC month, discarding earlier periods", async () => {
    const b = await setup();
    await b.setCounter(`requests:${yesterday()}`, FREE_PLAN.requests_per_day);
    await b.setCounter(`created:${lastMonth()}`, FREE_PLAN.new_records_per_month);
    await b.setCounter(`issued:${lastMonth()}`, FREE_PLAN.issued_invoices_per_month);
    value(await b.newClient());
    expect(await b.counter(`requests:${yesterday()}`)).toBe(0);
    expect(await b.counter(`created:${lastMonth()}`)).toBe(0);
    expect(await b.counter(`issued:${lastMonth()}`)).toBe(0);
    expect(await b.counter(`created:${month()}`)).toBe(3);
  });

  it("returns a structured tool error through the MCP transport", async () => {
    const a = await connected();
    try {
      const set = await a.client.callTool({ name: "business_set", arguments: { request_id: rid(), name: "Transport plan limits", currency: "AUD" } });
      const business_id = value(set.structuredContent as DomainResult).business_id as string;
      await runInDurableObject(eu(env.BUSINESSES).getByName(business_id), (_instance, state) => {
        state.storage.sql.exec("INSERT INTO counters(name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value", `requests:${today()}`, FREE_PLAN.requests_per_day);
      });
      const result = await a.client.callTool({ name: "clients_list", arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ ok: false, code: "PLAN_LIMIT", details: { limit: "requests_per_day", resets_at: nextMidnight() } });
    } finally {
      await a.client.close();
    }
  });
});
