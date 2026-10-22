import { env } from "cloudflare:workers";
import { eu } from "../src/regions";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { calculate } from "../src/billing";
import { privateOperation } from "../src/mcp";
import { digest } from "../src/auth";
import { schemas, READ_OPERATIONS, taxSchema, type Operation, type DomainResult, type Billable, type Tax } from "../src/models";
import { connected, rid } from "./auth-fixture";

function value<T = any>(r: DomainResult): T {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.data as T;
}
const tax = { treatment: "not_registered", jurisdiction: "AU", reason: "Fictional test facts", service_category: "consulting" };
const profile = { country: "AU", registration_status: "not_registered", registrations: [], reviewed_on: "2026-10-21", notes: "Fictional tests only" };
async function setup() {
  const owner = { userId: rid() };
  const call = (op: Operation, input: unknown, who = owner) => privateOperation(env, who, op, input);
  const business = value(await call("business_set", { request_id: rid(), name: "Local QA", currency: "AUD", billing_address: "Fictional business address" }));
  value(await call("tax_profile_set", { request_id: rid(), profile }));
  const client = value(await call("client_save", { request_id: rid(), name: "Local client", country: "AU", customer_type: "business" }));
  const work = { client_id: client.id, kind: "time", quantity: "10", unit: "hour", amount_minor: 10000, rate_minor: 1000, description: "Test work" };
  const item = value<Billable>(await call("billable_record", { request_id: rid(), ...work }));
  const draft = (extras: object = {}) => call("invoice_draft", { request_id: rid(), client_id: client.id, supply_date: "2026-10-21", due_date: "2026-11-21", lines: [{ item_id: item.id, amount_minor: 10000, tax }], ...extras });
  const issue = (invoice: any) => call("invoice_issue", { request_id: rid(), invoice_id: invoice.id, expected_total_minor: invoice.total_minor, confirmed: true });
  return { call, owner, business, client, item, work, draft, issue };
}

describe("all private MCP tools through the authenticated transport", () => {
  it("covers the complete 26-tool contract, two identities, records and permission feedback", async () => {
    const email = `${rid()}@example.com`;
    const a = await connected(), b = await connected(email);
    const exercised = new Set<string>();
    const call = async (name: Operation, args: Record<string, unknown> = {}, client = a.client) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, `${name}: ${JSON.stringify(result.structuredContent)}`).not.toBe(true);
      exercised.add(name);
      return value(result.structuredContent as DomainResult);
    };
    try {
      expect((await a.client.listTools()).tools.map(t => t.name).sort()).toEqual(Object.keys(schemas).sort());
      for (const tool of (await a.client.listTools()).tools) expect(tool.annotations?.readOnlyHint).toBe(READ_OPERATIONS.has(tool.name as Operation));
      expect((await call("otis_menu")).options).toHaveLength(10);
      await call("businesses_list");
      expect((await call("business_get")).setup_required).toBe(true);
      const business = await call("business_set", { request_id: rid(), name: "Transport QA", currency: "AUD" });
      await call("tax_guide", { country: "AU" });
      await call("tax_profile_set", { request_id: rid(), profile });
      const customer = await call("client_save", { request_id: rid(), name: "QA client", country: "AU", customer_type: "business" });
      await call("clients_list");
      const item = await call("billable_record", { request_id: rid(), client_id: customer.id, kind: "time", quantity: "1", unit: "hour", amount_minor: 1000, description: "Work" });
      await call("billables_list");
      await call("expense_record", { request_id: rid(), vendor: "Test", category: "test", description: "Test expense", cost_minor: 10, incurred_on: "2026-10-21" });
      await call("expenses_list");
      const draftArgs = { client_id: customer.id, supply_date: "2026-10-21", due_date: "2026-11-21", lines: [{ item_id: item.id, amount_minor: 1000, tax }] };
      const cancelled = await call("invoice_draft", { request_id: rid(), ...draftArgs });
      await call("invoice_cancel_draft", { request_id: rid(), invoice_id: cancelled.id, reason: "Replace" });
      const invoice = await call("invoice_draft", { request_id: rid(), ...draftArgs });
      expect((await call("invoice_check", { invoice_id: invoice.id })).ready).toBe(true);
      await call("invoice_issue", { request_id: rid(), invoice_id: invoice.id, expected_total_minor: 1000, confirmed: true });
      await call("payment_record", { request_id: rid(), invoice_id: invoice.id, amount_minor: 1000, received_on: "2026-10-21", reference: rid() });
      expect((await call("invoice_get", { invoice_id: invoice.id })).balance_minor).toBe(0);
      await call("invoices_list"); await call("payments_list");
      for (const kind of ["business", "client", "billable", "expense", "invoice", "payment", "audit"]) {
        const ids = new Set(); let offset = 0;
        for (;;) {
          const page = await call("records_export", { kind, limit: 1, offset });
          expect(page.format).toBe("otis-records-v1");
          for (const record of page.records) { expect(ids.has(record.id)).toBe(false); ids.add(record.id); }
          if (page.next_offset === null) break;
          expect(page.next_offset).toBeGreaterThan(offset); offset = page.next_offset;
        }
        expect(ids.size).toBeGreaterThan(0);
      }
      const invite = await call("team_invite", { request_id: rid(), email, role: "viewer" });
      await call("team_list");
      const listing = await call("businesses_list", {}, b.client);
      expect(listing.records.some((r: any) => r.business_id === business.business_id && r.status === "invited")).toBe(true);
      await call("team_accept", { request_id: rid(), business_id: business.business_id, invitation_id: invite.invitation_id }, b.client);
      const denied = await b.client.callTool({ name: "client_save", arguments: { request_id: rid(), business_id: business.business_id, name: "Forbidden" } });
      expect(denied).toMatchObject({ isError: true, structuredContent: { ok: false, code: "FORBIDDEN" } });
      await call("team_member_set", { request_id: rid(), member_id: invite.id, role: "removed" });
      await call("feedback_send", { request_id: rid(), kind: "other", message: "Transport QA feedback", client: "otis-local-complete-coverage" });
      expect(exercised.size).toBe(26);
      expect([...exercised].sort()).toEqual(Object.keys(schemas).sort());
    } finally { await a.client.close(); await b.client.close(); }
  });
});

describe("business integrity boundaries", () => {
  it("rejects invalid currency and locks it even for a nonbillable expense", async () => {
    const identity = { userId: rid() };
    const call = (op: Operation, input: unknown) => privateOperation(env, identity, op, input);
    expect(await call("business_set", { request_id: rid(), name: "QA", currency: "ZZZ" })).toMatchObject({ code: "INVALID_CURRENCY" });
    value(await call("business_set", { request_id: rid(), name: "QA", currency: "USD" }));
    value(await call("business_set", { request_id: rid(), name: "QA", currency: "JPY" }));
    value(await call("expense_record", { request_id: rid(), vendor: "QA", category: "test", description: "Expense", cost_minor: 1, incurred_on: "2026-10-21" }));
    expect(await call("business_set", { request_id: rid(), name: "QA", currency: "USD" })).toMatchObject({ code: "CURRENCY_LOCKED" });
  });
  it("rolls back duplicate, wrong-client, invalid-tax and over-limit invoice attempts", async () => {
    const b = await setup();
    const other = value(await b.call("client_save", { request_id: rid(), name: "Other" }));
    const line = { item_id: b.item.id, amount_minor: 1000, tax };
    for (const [extras, code] of [
      [{ lines: [line, line] }, "DUPLICATE_ITEM"],
      [{ client_id: other.id }, "CLIENT_MISMATCH"],
      [{ lines: [{ ...line, tax: { ...tax, treatment: "taxable" } }] }, "TAX_COMPONENTS_INVALID"],
      [{ lines: [{ ...line, tax: { ...tax, components: [{ name: "Tax", rate_ppm: 1 }] } }] }, "TAX_COMPONENTS_INVALID"],
      [{ lines: [{ ...line, discount: { kind: "fixed", amount_minor: 1001 } }] }, "DISCOUNT_TOO_LARGE"]
    ] as [object, string][]) {
      expect(await b.draft(extras)).toMatchObject({ ok: false, code });
      expect(value(await b.call("billables_list", {})).records[0]).toMatchObject({ reserved_minor: 0, remaining_minor: 10000 });
    }
    const huge = value(await b.call("billable_record", { request_id: rid(), ...b.work, quantity: "1", rate_minor: 1e12, amount_minor: 1e12 }));
    expect(await b.draft({ lines: [{ item_id: huge.id, amount_minor: 1e12, tax: { ...tax, treatment: "taxable", components: [{ name: "Test", rate_ppm: 100000 }] } }] })).toMatchObject({ code: "AMOUNT_LIMIT" });
    expect(value(await b.call("invoices_list", {})).records).toHaveLength(0);
    expect(value(await b.call("billables_list", {})).records.every((r: any) => r.reserved_minor === 0)).toBe(true);
  });
  it("blocks payments on drafts/cancelled invoices and never double-releases reservations", async () => {
    const b = await setup(), invoice = value(await b.draft());
    const payment = { request_id: rid(), invoice_id: invoice.id, amount_minor: 1, received_on: "2026-10-21", reference: rid() };
    expect(await b.call("payment_record", payment)).toMatchObject({ code: "ISSUED_REQUIRED" });
    const cancel = { request_id: rid(), invoice_id: invoice.id, reason: "Test" };
    await Promise.all(Array.from({ length: 8 }, () => b.call("invoice_cancel_draft", cancel)));
    expect(await b.call("invoice_cancel_draft", { ...cancel, request_id: rid() })).toMatchObject({ code: "DRAFT_REQUIRED" });
    expect(await b.call("payment_record", payment)).toMatchObject({ code: "ISSUED_REQUIRED" });
    expect(await b.issue(invoice)).toMatchObject({ code: "INVOICE_NOT_READY" });
    expect(value(await b.call("billables_list", {})).records[0]).toMatchObject({ remaining_minor: 10000, reserved_minor: 0 });
    expect(value(await b.call("invoice_get", { invoice_id: invoice.id })).balance_minor).toBe(0);
  });
  it("makes issuance versus cancellation races atomic and numbers only issued invoices", async () => {
    const b = await setup(), invoice = value(await b.draft());
    const results = await Promise.all([b.issue(invoice), b.call("invoice_cancel_draft", { request_id: rid(), invoice_id: invoice.id, reason: "Race" })]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    const saved = value(await b.call("invoice_get", { invoice_id: invoice.id }));
    const source = value(await b.call("billables_list", {})).records[0];
    expect(source.reserved_minor).toBe(0);
    expect(source.invoiced_minor + source.remaining_minor).toBe(10000);
    if (saved.status === "issued") { expect(saved.number).toBe(1); expect(source.invoiced_minor).toBe(10000); }
    else { expect(saved.number).toBeUndefined(); expect(source.remaining_minor).toBe(10000); }
  });
  it("serializes distinct invoices into unique numbers and distinct payments into a bounded balance", async () => {
    const b = await setup();
    const invoices = await Promise.all(Array.from({ length: 5 }, () => b.draft({ lines: [{ item_id: b.item.id, amount_minor: 2000, tax }] })));
    const issued = await Promise.all(invoices.map(r => b.issue(value(r))));
    expect(issued.map(r => value(r).number).sort()).toEqual([1, 2, 3, 4, 5]);
    const invoice = value(issued[0]);
    const payments = await Promise.all(Array.from({ length: 8 }, () => b.call("payment_record", { request_id: rid(), invoice_id: invoice.id, amount_minor: 500, received_on: "2026-10-21", reference: rid() })));
    expect(payments.filter(r => r.ok)).toHaveLength(4);
    expect(payments.filter(r => !r.ok).every(r => !r.ok && r.code === "OVERPAYMENT")).toBe(true);
    expect(value(await b.call("invoice_get", { invoice_id: invoice.id })).balance_minor).toBe(0);
  });
  it("blocks stale business and tax snapshots and preserves issued contents", async () => {
    const b = await setup(), invoice = value(await b.draft());
    value(await b.call("tax_profile_set", { request_id: rid(), profile: { ...profile, notes: "Revised facts" } }));
    expect(value(await b.call("invoice_check", { invoice_id: invoice.id })).blockers).toEqual(expect.arrayContaining([expect.objectContaining({ field: "snapshot" })]));
    expect(await b.issue(invoice)).toMatchObject({ code: "INVOICE_NOT_READY" });
    value(await b.call("invoice_cancel_draft", { request_id: rid(), invoice_id: invoice.id, reason: "Rebuild" }));
    const issued = value(await b.issue(value(await b.draft())));
    value(await b.call("business_set", { request_id: rid(), name: "New name", currency: "AUD" }));
    expect(value(await b.call("invoice_get", { invoice_id: issued.id })).business_snapshot).toEqual(issued.business_snapshot);
  });
  it("supports zero-price source edits and full discounts without allowing zero payments or allocations", async () => {
    const b = await setup();
    const invoice = value(await b.draft({ discount: { kind: "percent", rate_ppm: 1000000 } }));
    expect(invoice.total_minor).toBe(0);
    value(await b.issue(invoice));
    expect(value(await b.call("billables_list", {})).records[0]).toMatchObject({ invoiced_minor: 10000, remaining_minor: 0 });
    expect(await b.call("payment_record", { request_id: rid(), invoice_id: invoice.id, amount_minor: 1, received_on: "2026-10-21", reference: rid() })).toMatchObject({ code: "OVERPAYMENT" });
    const zero = value(await b.call("billable_record", { request_id: rid(), ...b.work, amount_minor: 0, rate_minor: 0 }));
    expect(zero.remaining_minor).toBe(0);
    expect(schemas.invoice_draft.safeParse({ request_id: rid(), client_id: b.client.id, supply_date: "2026-10-21", due_date: "2026-11-21", lines: [{ item_id: zero.id, amount_minor: 0 }] }).success).toBe(false);
  });
  it("validates expense linkage and safely changes an unbilled expense into billable work", async () => {
    const b = await setup();
    const details = { vendor: "QA", category: "test", description: "Cost", incurred_on: "2026-10-21", cost_minor: 10 };
    expect(await b.call("expense_record", { request_id: rid(), ...details, billable_amount_minor: 20 })).toMatchObject({ code: "CLIENT_REQUIRED" });
    const initial = value(await b.call("expense_record", { request_id: rid(), ...details }));
    const input = { request_id: rid(), ...details, expense_id: initial.id, client_id: b.client.id, billable_amount_minor: 20 };
    const linked = value(await b.call("expense_record", input));
    expect(await b.call("expense_record", { ...input, request_id: rid(), billable_amount_minor: undefined })).toMatchObject({ code: "BILLABLE_AMOUNT_REQUIRED" });
    const zero = value(await b.call("expense_record", { ...input, request_id: rid(), billable_amount_minor: 0 }));
    expect(zero.billable_id).toBe(linked.billable_id);
    expect(value(await b.call("billables_list", {})).records.find((r: any) => r.id === linked.billable_id).remaining_minor).toBe(0);
  });
  it("paginates filtered records without duplicates and treats SQL-looking IDs as data", async () => {
    const b = await setup();
    for (let i = 0; i < 5; i++) value(await b.call("billable_record", { request_id: rid(), ...b.work }));
    const seen = new Set(); let offset = 0;
    for (;;) {
      const page = value(await b.call("billables_list", { client_id: b.client.id, state: "unbilled", limit: 2, offset }));
      for (const record of page.records) { expect(seen.has(record.id)).toBe(false); seen.add(record.id); }
      if (page.next_offset === null) break;
      offset = page.next_offset;
    }
    expect(seen.size).toBe(6);
    expect(value(await b.call("billables_list", { client_id: "' OR 1=1 --" })).records).toHaveLength(0);
    expect(value(await b.call("billables_list", { offset: 100 })).next_offset).toBeNull();
  });
});

describe("all explicit tax treatments and arithmetic boundaries", () => {
  it.each(["taxable", "zero_rated", "exempt", "out_of_scope", "reverse_charge", "not_registered"] as const)("stores and issues explicit %s treatment", async treatment => {
    const b = await setup();
    if (treatment === "taxable") value(await b.call("tax_profile_set", { request_id: rid(), profile: { ...profile, registration_status: "registered", registrations: [{ jurisdiction: "AU", number: "FICTIONAL", effective_from: "2026-01-01" }] } }));
    const lineTax = { ...tax, treatment, components: treatment === "taxable" ? [{ name: "Example", rate_ppm: 100000 }] : [] };
    const invoice = value(await b.draft({ lines: [{ item_id: b.item.id, amount_minor: 10000, tax: lineTax }] }));
    const issued = value(await b.issue(invoice));
    expect(issued.lines[0].tax.treatment).toBe(treatment);
    expect(issued.tax_minor).toBe(treatment === "taxable" ? 1000 : 0);
  });
  it.each([
    { country: "US", registration_status: "not_registered", field: "tax_profile.region" },
    { country: "CA", registration_status: "not_registered", field: "tax_profile.region" },
    { country: "AU", registration_status: "unknown", field: "tax_profile" },
    { country: "GB", registration_status: "registered", field: "tax_profile.registrations" }
  ])("blocks incomplete seller setup: $country/$registration_status", async ({ country, registration_status, field }) => {
    const b = await setup();
    value(await b.call("tax_profile_set", { request_id: rid(), profile: { ...profile, country, registration_status } }));
    const invoice = value(await b.draft());
    expect(value(await b.call("invoice_check", { invoice_id: invoice.id })).blockers).toEqual(expect.arrayContaining([expect.objectContaining({ field })]));
    expect(await b.issue(invoice)).toMatchObject({ code: "INVOICE_NOT_READY" });
  });
  it("conserves amounts across 500 deterministic discount/tax combinations", () => {
    let seed = 5381;
    const next = (max: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
    for (let iteration = 0; iteration < 500; iteration++) {
      const lines = Array.from({ length: 1 + next(12) }, (_, i) => ({ item_id: String(i), source_snapshot: {} as Billable,
        amount_minor: 100 + next(1000000), discount: { kind: "percent" as const, rate_ppm: next(1000001) },
        tax: taxSchema.parse({ ...tax, treatment: "taxable", mode: iteration % 2 ? "inclusive" : "exclusive", components: [{ name: "A", rate_ppm: 1 + next(200000), taxable_fraction_ppm: 1 + next(1000000) }, { name: "B", rate_ppm: 1 + next(200000) }] }) }));
      const result = calculate(lines, { kind: "percent", rate_ppm: next(1000001) });
      expect(result.net_minor + result.tax_minor).toBe(result.total_minor);
      expect(result.subtotal_minor - result.discount_minor + (iteration % 2 ? 0 : result.tax_minor)).toBe(result.total_minor);
      for (const line of result.lines) {
        expect(line.net_minor + line.tax_minor).toBe(line.total_minor);
        expect(line.taxes.reduce((sum, t) => sum + t.amount_minor, 0)).toBe(line.tax_minor);
        for (const amount of [line.net_minor, line.tax_minor, line.total_minor, line.line_discount_minor, line.invoice_discount_minor]) {
          expect(Number.isSafeInteger(amount) && amount >= 0).toBe(true);
        }
      }
    }
  });
  it("uses independent known rounding examples and supports maximal exact money", () => {
    const line = (amount_minor: number, overrides: object = {}) => ({ item_id: "item", source_snapshot: {} as Billable, amount_minor, ...overrides });
    const exclusive = taxSchema.parse({ ...tax, treatment: "taxable", components: [{ name: "A", rate_ppm: 50000 }, { name: "B", rate_ppm: 99750 }] });
    expect(calculate([line(10001, { tax: exclusive })])).toMatchObject({ net_minor: 10001, tax_minor: 1498, total_minor: 11499 });
    const inclusive: Tax = { ...exclusive, mode: "inclusive", components: [{ name: "VAT", rate_ppm: 200000, taxable_fraction_ppm: 1000000 }] };
    expect(calculate([line(11999, { tax: inclusive })])).toMatchObject({ net_minor: 9999, tax_minor: 2000, total_minor: 11999 });
    expect(calculate([line(1e12)]).total_minor).toBe(1e12);
    expect(() => calculate([line(1e12), line(1)])).toThrow();
    expect(calculate([line(1), line(1), line(1)], { kind: "percent", rate_ppm: 500000 }).lines.map(l => l.invoice_discount_minor)).toEqual([1, 1, 0]);
    const tiny = taxSchema.parse({ ...tax, treatment: "taxable", mode: "inclusive", components: Array.from({ length: 5 }, (_, i) => ({ name: String(i), rate_ppm: 1000000 })) });
    expect(() => calculate([line(3, { tax: tiny })])).toThrow(expect.objectContaining({ code: "TAX_ROUNDING_INVALID" }));
  });
});

describe("schema rejection before writes", () => {
  it.each([-1, 0.5, 1000000000001, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid money %s", amount_minor => {
    expect(schemas.billable_record.safeParse({ request_id: rid(), client_id: "c", kind: "time", description: "Test", quantity: "1", unit: "hour", amount_minor }).success).toBe(false);
  });
  it.each(["2026-02-29", "2026-04-31", "2026-13-01", "not-a-date"])("rejects invalid calendar date %s", received_on => {
    expect(schemas.payment_record.safeParse({ request_id: rid(), invoice_id: "i", reference: "r", amount_minor: 1, received_on }).success).toBe(false);
  });
  it.each(["0", "-1", "1.1234567", "1e3", "1000000000"])("rejects invalid quantity %s", quantity => {
    expect(schemas.billable_record.safeParse({ request_id: rid(), client_id: "c", kind: "time", description: "Test", quantity, unit: "hour", amount_minor: 1 }).success).toBe(false);
  });
  it("requires explicit confirmation and bounded pagination", () => {
    expect(schemas.invoice_issue.safeParse({ request_id: rid(), invoice_id: "i", expected_total_minor: 0, confirmed: false }).success).toBe(false);
    for (const fields of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: 0.5 }]) expect(schemas.clients_list.safeParse(fields).success).toBe(false);
    expect(schemas.payment_record.safeParse({ request_id: rid(), invoice_id: "i", reference: "r", amount_minor: 0, received_on: "2026-10-21" }).success).toBe(false);
  });
});

describe("tenant boundaries and invitation lifecycle", () => {
  it("enforces the full viewer write-denial matrix and owner-only settings for editors", async () => {
    const b = await setup(), email = `${rid()}@example.com`, teammate = { userId: await digest(`otis-user:${email}`) };
    const business_id = b.business.business_id;
    const invoice = value(await b.draft({ lines: [{ item_id: b.item.id, amount_minor: 5000, tax }] }));
    const invite = value(await b.call("team_invite", { request_id: rid(), email, role: "viewer" }));
    value(await b.call("team_accept", { request_id: rid(), business_id, invitation_id: invite.invitation_id }, teammate));
    const inputs: Partial<Record<Operation, object>> = {
      business_set: { name: "Hijack", currency: "AUD" }, tax_profile_set: { profile },
      team_invite: { email: "nobody@example.com", role: "viewer" }, team_member_set: { member_id: invite.id, role: "editor" },
      client_save: { name: "New client" }, billable_record: b.work,
      expense_record: { vendor: "QA", description: "QA", category: "test", incurred_on: "2026-10-21", cost_minor: 1 },
      invoice_draft: { client_id: b.client.id, supply_date: "2026-10-21", due_date: "2026-11-21", lines: [{ item_id: b.item.id, amount_minor: 1, tax }] },
      invoice_issue: { invoice_id: invoice.id, expected_total_minor: 5000, confirmed: true }, invoice_cancel_draft: { invoice_id: invoice.id, reason: "Test" },
      payment_record: { invoice_id: invoice.id, reference: "test", amount_minor: 1, received_on: "2026-10-21" }
    };
    expect(Object.keys(inputs).sort()).toEqual(Object.keys(schemas).filter(op => !READ_OPERATIONS.has(op as Operation) && !["team_accept", "feedback_send"].includes(op)).sort());
    for (const [op, input] of Object.entries(inputs)) expect(await b.call(op as Operation, { ...input, request_id: rid(), business_id }, teammate), op).toMatchObject({ code: "FORBIDDEN" });
    for (const op of READ_OPERATIONS) {
      const args = op === "records_export" ? { kind: "audit" } : ["invoice_get", "invoice_check"].includes(op) ? { invoice_id: invoice.id } : {};
      expect((await b.call(op, { ...args, business_id }, teammate)).ok, op).toBe(true);
    }
    value(await b.call("team_member_set", { request_id: rid(), member_id: invite.id, role: "editor" }));
    for (const op of ["business_set", "tax_profile_set", "team_invite", "team_member_set"] as const) expect(await b.call(op, { ...inputs[op], request_id: rid(), business_id }, teammate), op).toMatchObject({ code: "FORBIDDEN" });
    value(await b.call("invoice_issue", { ...inputs.invoice_issue, request_id: rid(), business_id }, teammate));
    value(await b.call("payment_record", { ...inputs.payment_record, request_id: rid(), business_id }, teammate));
    expect(value(await b.call("invoice_get", { invoice_id: invoice.id })).balance_minor).toBe(4999);
  });
  it("denies every business operation to an outsider, even when discovery hints are forged locally", async () => {
    const b = await setup(), stranger = { userId: rid() };
    await eu(env.ACCOUNTS).getByName(stranger.userId).add(b.business.business_id);
    const inputs: Partial<Record<Operation, object>> = {
      business_get: {}, business_set: { name: "Hijack", currency: "AUD" }, tax_profile_set: { profile }, team_list: {},
      team_invite: { email: "nobody@example.com", role: "viewer" }, team_accept: { invitation_id: "unknown" }, team_member_set: { member_id: "unknown", role: "removed" },
      clients_list: {}, client_save: { name: "Hack" }, billable_record: b.work, billables_list: {},
      expense_record: { vendor: "QA", description: "QA", category: "test", incurred_on: "2026-10-21", cost_minor: 1 }, expenses_list: {},
      invoice_draft: { client_id: b.client.id, supply_date: "2026-10-21", due_date: "2026-11-21", lines: [{ item_id: b.item.id, amount_minor: 1, tax }] },
      invoice_get: { invoice_id: "unknown" }, invoice_check: { invoice_id: "unknown" }, invoices_list: {},
      invoice_issue: { invoice_id: "unknown", expected_total_minor: 1, confirmed: true }, invoice_cancel_draft: { invoice_id: "unknown", reason: "Hack" },
      payment_record: { invoice_id: "unknown", reference: "x", amount_minor: 1, received_on: "2026-10-21" }, payments_list: {}, records_export: { kind: "audit" }
    };
    expect(Object.keys(inputs)).toHaveLength(22);
    for (const [op, input] of Object.entries(inputs)) {
      expect(await b.call(op as Operation, { ...input, request_id: rid(), business_id: b.business.business_id }, stranger), op).toMatchObject({ code: "FORBIDDEN" });
    }
    const list = value(await b.call("businesses_list", {}, stranger));
    expect(list.records.some((r: any) => r.business_id === b.business.business_id)).toBe(false);
    expect(await b.call("business_set", { request_id: rid(), business_id: "unowned-business", name: "Hijack", currency: "AUD" }, stranger)).toMatchObject({ code: "FORBIDDEN" });
  });
  it("expires/replaces invitations, requires reinvitation after removal, and scopes retries per actor", async () => {
    const b = await setup(), email = `${rid()}@example.com`, teammate = { userId: await digest(`otis-user:${email}`) };
    const business_id = b.business.business_id;
    const first = value(await b.call("team_invite", { request_id: rid(), email, role: "editor" }));
    const second = value(await b.call("team_invite", { request_id: rid(), email, role: "editor" }));
    expect(await b.call("team_accept", { request_id: rid(), business_id, invitation_id: first.invitation_id }, teammate)).toMatchObject({ code: "INVITATION_INVALID" });
    await runInDurableObject(eu(env.BUSINESSES).getByName(business_id), (_instance, state) => {
      state.storage.sql.exec("UPDATE records SET data = json_set(data, '$.expires_at', 1) WHERE kind = 'member' AND json_extract(data, '$.status') = 'invited'");
    });
    expect(await b.call("team_accept", { request_id: rid(), business_id, invitation_id: second.invitation_id }, teammate)).toMatchObject({ code: "FORBIDDEN" });
    expect(value(await b.call("businesses_list", {}, teammate)).records.some((r: any) => r.business_id === business_id)).toBe(false);
    const next = value(await b.call("team_invite", { request_id: rid(), email, role: "editor" }));
    const accept = { request_id: rid(), business_id, invitation_id: next.invitation_id };
    value(await b.call("team_accept", accept, teammate));
    expect(await b.call("team_invite", { request_id: rid(), email, role: "viewer" })).toMatchObject({ code: "ALREADY_MEMBER" });
    const sameId = rid();
    const ownerClient = value(await b.call("client_save", { request_id: sameId, name: "Owner client" }));
    const memberClient = value(await b.call("client_save", { request_id: sameId, business_id, name: "Member client" }, teammate));
    expect(memberClient.id).not.toBe(ownerClient.id);
    value(await b.call("team_member_set", { request_id: rid(), member_id: next.id, role: "removed" }));
    expect(await b.call("team_member_set", { request_id: rid(), member_id: next.id, role: "editor" })).toMatchObject({ code: "INVITATION_REQUIRED" });
    expect(await b.call("team_accept", accept, teammate)).toMatchObject({ code: "FORBIDDEN" });
  });
  it("repairs a missing account index on retry without duplicating the invitation or audit", async () => {
    const b = await setup(), email = `${rid()}@example.com`, userId = await digest(`otis-user:${email}`);
    const input = { request_id: rid(), email, role: "viewer" };
    const first = value(await b.call("team_invite", input));
    const count = value(await b.call("records_export", { kind: "audit" })).records.length;
    await runInDurableObject(eu(env.ACCOUNTS).getByName(userId), (_instance, state) => { state.storage.sql.exec("DELETE FROM businesses"); });
    const retry = value(await b.call("team_invite", input));
    expect(retry.invitation_id).toBe(first.invitation_id);
    expect(value(await b.call("records_export", { kind: "audit" })).records).toHaveLength(count);
    expect(value(await b.call("businesses_list", {}, { userId })).records.some((r: any) => r.business_id === b.business.business_id)).toBe(true);
  });
});
