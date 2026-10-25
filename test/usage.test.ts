import { env } from "cloudflare:workers";
import { eu } from "../src/regions";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { privateOperation } from "../src/mcp";
import { recordUsage, usageQueries } from "../src/usage";
import { registry } from "../src/registry";
import { FREE_PLAN, type Operation, type DomainResult } from "../src/models";
import { connected, rid, settle } from "./auth-fixture";

type Point = { indexes: string[]; blobs: string[]; doubles: number[] };
function value<T = any>(r: DomainResult): T {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.data as T;
}
const month = () => new Date().toISOString().slice(0, 7);
const noTax = { treatment: "not_registered", jurisdiction: "US-NY", reason: "User confirmed no collection obligation for this example", service_category: "consulting" };

// A recording Analytics Engine binding; nothing leaves the test.
async function setup() {
  const points: Point[] = [];
  const bindings: Env = { ...env, USAGE: { writeDataPoint: (point: Point) => { points.push(point); } } as unknown as AnalyticsEngineDataset };
  const owner = { userId: rid() };
  const call = (op: Operation, input: unknown) => privateOperation(bindings, owner, op, input);
  const business_id = value(await call("business_set", { request_id: rid(), name: "Usage QA", currency: "USD", billing_address: "Business address" })).business_id as string;
  value(await call("tax_profile_set", { request_id: rid(), profile: { country: "US", region: "NY", registration_status: "not_registered", reviewed_on: "2026-10-20", notes: "User confirmed" } }));
  const of = (event: string) => points.filter(p => p.blobs[0] === event);
  return { points, owner, call, business_id, of };
}
async function draftOf(b: Awaited<ReturnType<typeof setup>>, amount_minor: number) {
  const client = value(await b.call("client_save", { request_id: rid(), name: "Client", country: "US", region: "NY", customer_type: "business", billing_address: "Client address" }));
  const item = value(await b.call("billable_record", { request_id: rid(), client_id: client.id, kind: "time", description: "Project", quantity: "10", unit: "hour", amount_minor: 100000, rate_minor: 10000 }));
  return value(await b.call("invoice_draft", { request_id: rid(), client_id: client.id, lines: [{ item_id: item.id, amount_minor, tax: noTax }], due_date: "2026-11-20", supply_date: "2026-10-20" }));
}

describe("usage events", () => {
  it("records a created client by kind", async () => {
    const b = await setup();
    value(await b.call("client_save", { request_id: rid(), name: "Client" }));
    const created = b.of("record_created").filter(p => p.blobs[5] === "client");
    expect(created).toHaveLength(1);
    expect(created[0].blobs).toEqual(["record_created", "client_save", "ok", "", b.business_id, "client", ""]);
    expect(created[0].indexes).toEqual([b.owner.userId]);
    expect(created[0].doubles[1]).toBe(1);
  });

  it("records an issued invoice with currency and total", async () => {
    const b = await setup();
    const draft = await draftOf(b, 12000);
    value(await b.call("invoice_issue", { request_id: rid(), invoice_id: draft.id, expected_total_minor: draft.total_minor, confirmed: true }));
    const issued = b.of("invoice_issued");
    expect(issued).toHaveLength(1);
    expect(issued[0].blobs[6]).toBe("USD");
    expect(issued[0].doubles[0]).toBe(12000);
  });

  it("records a plan-limit refusal", async () => {
    const b = await setup();
    const draft = await draftOf(b, 12000);
    await runInDurableObject(eu(env.BUSINESSES).getByName(b.business_id), (_instance, state) => {
      state.storage.sql.exec("INSERT INTO counters(name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value", `issued:${month()}`, FREE_PLAN.issued_invoices_per_month);
    });
    const refused = await b.call("invoice_issue", { request_id: rid(), invoice_id: draft.id, expected_total_minor: draft.total_minor, confirmed: true });
    expect(refused).toMatchObject({ ok: false, code: "PLAN_LIMIT" });
    const limits = b.of("plan_limit");
    expect(limits).toHaveLength(1);
    expect(limits[0].blobs[5]).toBe("issued_invoices_per_month");
  });

  it("a write refused at the monthly limit records nothing created", async () => {
    const b = await setup();
    await runInDurableObject(eu(env.BUSINESSES).getByName(b.business_id), (_instance, state) => {
      state.storage.sql.exec("INSERT INTO counters(name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value", `created:${month()}`, FREE_PLAN.new_records_per_month);
    });
    expect(await b.call("client_save", { request_id: rid(), name: "Client" })).toMatchObject({ ok: false, code: "PLAN_LIMIT" });
    expect(b.of("record_created").filter(p => p.blobs[5] === "client")).toEqual([]);
    expect(b.of("plan_limit").map(p => p.blobs[5])).toEqual(["new_records_per_month"]);
  });

  it("a replayed write records nothing new", async () => {
    const b = await setup();
    const input = { request_id: rid(), name: "Client" };
    value(await b.call("client_save", input));
    value(await b.call("client_save", input));
    expect(b.of("record_created").filter(p => p.blobs[5] === "client")).toHaveLength(1);
  });

  it("the tool wrapper records each call with its outcome and assistant", async () => {
    const points: Point[] = [];
    const usage = { writeDataPoint: (point: Point) => { points.push(point); } } as unknown as AnalyticsEngineDataset;
    const c = await connected(undefined, { USAGE: usage });
    await c.client.callTool({ name: "otis_menu", arguments: {} });
    // No business yet, so the read is refused inside Otis (input the SDK rejects never reaches the tool).
    await c.client.callTool({ name: "invoice_get", arguments: { invoice_id: "missing" } });
    const calls = points.filter(p => p.blobs[0] === "tool_call");
    expect(calls.map(p => [p.blobs[1], p.blobs[2]])).toEqual([["otis_menu", "ok"], ["invoice_get", "FORBIDDEN"]]);
    expect(calls[0].blobs[3]).toBe(c.client_id);
    expect(calls[0].indexes[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("recordUsage never throws without a binding", () => {
    expect(() => recordUsage({ ...env, USAGE: undefined } as unknown as Env, { event: "tool_call", user: "demo", tool: "otis_menu", outcome: "ok" })).not.toThrow();
  });
});

describe("usage queries", () => {
  const someone = "a".repeat(64);
  it("queries exclude internal users and clamp to 90 days", () => {
    const queries = usageQueries("2026-01-01", "2026-10-25", [someone]);
    expect(Object.keys(queries).sort()).toEqual(["clients", "demo_calls", "invoices", "plan_limits", "records_created", "tool_calls"]);
    expect(queries.tool_calls).toContain(`index1 NOT IN ('${someone}')`);
    expect(queries.tool_calls).toContain("timestamp >= toDateTime('2026-07-28 00:00:00')");
    expect(queries.tool_calls).toContain("timestamp < toDateTime('2026-10-26 00:00:00')");
    expect(queries.invoices).toContain("SUM(_sample_interval * double1)");
    expect(queries.demo_calls).toContain("index1 = 'demo'");
  });

  it("queries refuse anything but opaque IDs", () => {
    expect(() => usageQueries("2026-10-01", "2026-10-25", ["x' OR '1'='1"])).toThrow();
    expect(usageQueries("2026-10-01", "2026-10-25", [], someone).records_created).toContain(`index1 = '${someone}'`);
  });
});

describe("admin_usage", () => {
  const adminEmail = () => `admin-${rid()}@example.com`;
  it("admin_usage without a token says it is not configured", async () => {
    const email = adminEmail();
    const c = await connected(email, { ADMIN_EMAILS: email, ANALYTICS_API_TOKEN: undefined });
    expect((await c.client.callTool({ name: "admin_usage", arguments: {} })).structuredContent).toMatchObject({ ok: false, code: "NOT_CONFIGURED" });
  });

  it("plan pressure counts businesses at 80 percent, and business totals count currencies and countries", async () => {
    const sql: string[] = [];
    let clientIdOf = () => "";
    const real = globalThis.fetch;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith("https://api.cloudflare.com/")) return real(input, init);
      sql.push(String(init?.body));
      if (String(init?.body).includes("AS client,")) return Response.json({ data: [{ client: clientIdOf(), calls: "2" }], rows: 1 });
      return Response.json({ data: [{ tool: "otis_menu", outcome: "ok", calls: "3" }], rows: 1 });
    });
    try {
      const email = adminEmail();
      const c = await connected(email, { ADMIN_EMAILS: email, ANALYTICS_API_TOKEN: "test-token" });
      clientIdOf = () => c.client_id;
      await settle();
      const usage = async () => (await c.client.callTool({ name: "admin_usage", arguments: { include_internal: true } })).structuredContent as DomainResult;
      const before = value(await usage());
      const owner = { userId: rid(), email: `${rid()}@example.com` };
      const business_id = value(await privateOperation(env, owner, "business_set", { request_id: rid(), name: "Busy", currency: "EUR" })).business_id as string;
      value(await privateOperation(env, owner, "tax_profile_set", { request_id: rid(), profile: { country: "GB", registration_status: "not_registered", reviewed_on: "2026-10-20", notes: "User confirmed" } }));
      await registry(env).activity({ userId: owner.userId, email: owner.email, businessId: business_id, day: "2026-10-25", milestones: [], internal: false, at: new Date().toISOString() });
      await runInDurableObject(eu(env.BUSINESSES).getByName(business_id), (_instance, state) => {
        state.storage.sql.exec("INSERT INTO counters(name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value", `created:${month()}`, FREE_PLAN.new_records_per_month * 0.8);
      });
      const after = value(await usage());
      expect(after.plan_pressure.new_records - before.plan_pressure.new_records).toBe(1);
      expect(after.plan_pressure.issued_invoices - before.plan_pressure.issued_invoices).toBe(0);
      expect((after.businesses.by_currency.EUR ?? 0) - (before.businesses.by_currency.EUR ?? 0)).toBe(1);
      expect((after.businesses.by_country.GB ?? 0) - (before.businesses.by_country.GB ?? 0)).toBe(1);
      expect(after.events.tool_calls).toEqual([{ tool: "otis_menu", outcome: "ok", calls: 3 }]);
      expect(after.events.clients).toEqual([{ client: c.client_id, client_name: "Local security checks", calls: 2 }]);
      expect(sql).toHaveLength(12);
    } finally {
      spy.mockRestore();
    }
  });
});
