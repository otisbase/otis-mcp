import { env } from "cloudflare:workers";
import { eu } from "../src/regions";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { privateOperation } from "../src/mcp";
import { FAIR_USE, type Operation, type DomainResult } from "../src/models";
import { connected, rid } from "./auth-fixture";

function value<T = any>(r: DomainResult): T {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.data as T;
}
const today = () => new Date().toISOString().slice(0, 10);
const yesterday = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const nextMidnight = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString(); };

async function setup() {
  const owner = { userId: rid() };
  const call = (op: Operation, input: unknown, who = owner) => privateOperation(env, who, op, input);
  const business_id = value(await call("business_set", { request_id: rid(), name: "Fair use QA", currency: "AUD" })).business_id as string;
  const store = () => eu(env.BUSINESSES).getByName(business_id);
  const setCounter = (name: string, count: number) => runInDurableObject(store(), (_instance, state) => {
    state.storage.sql.exec("INSERT INTO counters(name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value", name, count);
  });
  const counter = (name: string) => runInDurableObject(store(), (_instance, state) =>
    state.storage.sql.exec<{ value: number }>("SELECT value FROM counters WHERE name = ?", name).toArray()[0]?.value ?? 0);
  const stored = (kind: string) => runInDurableObject(store(), (_instance, state) =>
    state.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM records WHERE kind = ?", kind).one().count);
  const newClient = (request_id = rid()) => call("client_save", { request_id, name: "Client", country: "AU", customer_type: "business" });
  return { owner, call, business_id, setCounter, counter, stored, newClient };
}

describe("fair-use limits per business", () => {
  it("counts every authorized request and new business records, but not edits, reads or the audit trail", async () => {
    const b = await setup();
    const client = value(await b.newClient());
    value(await b.call("client_save", { request_id: rid(), client_id: client.id, name: "Renamed", country: "AU", customer_type: "business" }));
    value(await b.call("clients_list", {}));
    await expect(b.call("client_save", { request_id: rid(), name: "" })).rejects.toThrow();
    // business_set, client_save, client_save (edit) and clients_list; invalid input never reaches the business.
    expect(await b.counter(`requests:${today()}`)).toBe(4);
    // The business, its owner membership and one client; the edit and the audit entries are not new records.
    expect(await b.counter(`created:${today()}`)).toBe(3);
    expect(await b.counter("records")).toBe(3);
    expect(await b.stored("audit")).toBe(3);
  });

  it("does not let outsiders spend a business's request allowance", async () => {
    const b = await setup(), before = await b.counter(`requests:${today()}`);
    expect(await b.call("clients_list", { business_id: b.business_id }, { userId: rid() })).toMatchObject({ code: "FORBIDDEN" });
    expect(await b.counter(`requests:${today()}`)).toBe(before);
  });

  it("refuses every request, reads included, after 10,000 requests in a UTC day", async () => {
    const b = await setup();
    await b.setCounter(`requests:${today()}`, FAIR_USE.requests_per_day - 1);
    value(await b.call("business_get", {}));
    const refused = await b.call("business_get", {});
    expect(refused).toMatchObject({ ok: false, code: "FAIR_USE_LIMIT",
      details: { limit: "requests_per_day", allowed: 10_000, used: 10_000, resets_at: nextMidnight() } });
    expect(await b.newClient()).toMatchObject({ code: "FAIR_USE_LIMIT", details: { limit: "requests_per_day" } });
    expect(await b.stored("client")).toBe(0);
    // Refused requests do not add to the count.
    expect(await b.counter(`requests:${today()}`)).toBe(FAIR_USE.requests_per_day);
  });

  it("refuses new records after 1,000 in a UTC day while reads and edits keep working", async () => {
    const b = await setup();
    const client = value(await b.newClient());
    await b.setCounter(`created:${today()}`, FAIR_USE.new_records_per_day - 1);
    value(await b.newClient());
    const requestId = rid();
    const refused = await b.newClient(requestId);
    expect(refused).toMatchObject({ ok: false, code: "FAIR_USE_LIMIT",
      details: { limit: "new_records_per_day", allowed: 1_000, used: 1_000, resets_at: nextMidnight() } });
    expect((refused as { message: string }).message).toContain("Reads and edits still work");
    expect(await b.stored("client")).toBe(2);
    expect(value(await b.call("clients_list", {})).records).toHaveLength(2);
    value(await b.call("client_save", { request_id: rid(), client_id: client.id, name: "Edited", country: "AU", customer_type: "business" }));
    // A refused request is not recorded, so its request_id works once the limit allows it.
    await b.setCounter(`created:${today()}`, 0);
    value(await b.newClient(requestId));
  });

  it("refuses new records once the business stores 100,000, without a daily reset, while reads and edits keep working", async () => {
    const b = await setup();
    const client = value(await b.newClient());
    await b.setCounter("records", FAIR_USE.records_total);
    const refused = await b.newClient();
    expect(refused).toMatchObject({ ok: false, code: "FAIR_USE_LIMIT",
      details: { limit: "records_total", allowed: 100_000, used: 100_000, resets_at: null } });
    expect(value(await b.call("clients_list", {})).records).toHaveLength(1);
    value(await b.call("client_save", { request_id: rid(), client_id: client.id, name: "Edited", country: "AU", customer_type: "business" }));
    value(await b.call("tax_profile_set", { request_id: rid(), profile: { country: "AU", registration_status: "not_registered", registrations: [], reviewed_on: "2026-10-21", notes: "Fictional tests only" } }));
    expect(await b.counter("records")).toBe(FAIR_USE.records_total);
  });

  it("refuses the whole operation when it would create more records than remain", async () => {
    const b = await setup();
    const client = value(await b.newClient());
    await b.setCounter("records", FAIR_USE.records_total - 1);
    // A billable expense creates two records: the expense and its linked billable.
    const refused = await b.call("expense_record", { request_id: rid(), vendor: "QA", category: "test", description: "QA", cost_minor: 100, incurred_on: "2026-10-21", client_id: client.id, billable_amount_minor: 100 });
    expect(refused).toMatchObject({ code: "FAIR_USE_LIMIT", details: { limit: "records_total", used: FAIR_USE.records_total - 1 } });
    expect(await b.stored("expense")).toBe(0);
    expect(await b.stored("billable")).toBe(0);
    value(await b.call("expense_record", { request_id: rid(), vendor: "QA", category: "test", description: "QA", cost_minor: 100, incurred_on: "2026-10-21" }));
    expect(await b.counter("records")).toBe(FAIR_USE.records_total);
  });

  it("resets the daily limits at the UTC day boundary and discards earlier days", async () => {
    const b = await setup();
    await b.setCounter(`requests:${yesterday()}`, FAIR_USE.requests_per_day);
    await b.setCounter(`created:${yesterday()}`, FAIR_USE.new_records_per_day);
    value(await b.newClient());
    expect(await b.counter(`requests:${yesterday()}`)).toBe(0);
    expect(await b.counter(`created:${yesterday()}`)).toBe(0);
    expect(await b.counter(`created:${today()}`)).toBe(3);
  });

  it("returns a structured tool error through the MCP transport", async () => {
    const a = await connected();
    try {
      const set = await a.client.callTool({ name: "business_set", arguments: { request_id: rid(), name: "Transport fair use", currency: "AUD" } });
      const business_id = value(set.structuredContent as DomainResult).business_id as string;
      await runInDurableObject(eu(env.BUSINESSES).getByName(business_id), (_instance, state) => {
        state.storage.sql.exec("INSERT INTO counters(name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value", `requests:${today()}`, FAIR_USE.requests_per_day);
      });
      const result = await a.client.callTool({ name: "clients_list", arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ ok: false, code: "FAIR_USE_LIMIT", details: { limit: "requests_per_day", resets_at: nextMidnight() } });
    } finally {
      await a.client.close();
    }
  });
});
