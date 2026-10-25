import { env } from "cloudflare:workers";
import { eu } from "../src/regions";
import { describe, it, expect } from "vitest";
import { privateOperation } from "../src/mcp";
import { digest } from "../src/auth";
import { calculate } from "../src/billing";
import type { Actor, DomainResult, Operation, Invoice, Billable } from "../src/models";

function value<T = any>(r: DomainResult): T { if (!r.ok) throw new Error(`${r.code}: ${r.message}`); return r.data as T; }
function business() {
  const stub = eu(env.BUSINESSES).getByName(`billing-test:${crypto.randomUUID()}`);
  const owner: Actor = { userId: "owner", home: true };
  const call = async (op: Operation, input: unknown, actor = owner): Promise<DomainResult> => JSON.parse(await stub.execute(op, input, actor));
  return { call, stub };
}
const rid = () => crypto.randomUUID();
const noTax = { treatment: "not_registered", jurisdiction: "US-NY", reason: "User confirmed no collection obligation for this example", service_category: "consulting" };
const vat = { treatment: "taxable", jurisdiction: "GB", reason: "User confirmed standard-rated domestic consulting", service_category: "consulting", components: [{ name: "VAT", rate_ppm: 200000 }] };
async function setup() {
  const b = business();
  value(await b.call("business_set", { request_id: rid(), name: "Studio", currency: "USD", billing_address: "Business address" }));
  value(await b.call("tax_profile_set", { request_id: rid(), profile: { country: "US", region: "NY", registration_status: "not_registered", reviewed_on: "2026-10-20", notes: "User confirmed" } }));
  const client = value(await b.call("client_save", { request_id: rid(), name: "Client", country: "US", region: "NY", customer_type: "business", billing_address: "Client address" }));
  const item = value<Billable>(await b.call("billable_record", { request_id: rid(), client_id: client.id, kind: "time", description: "Project", quantity: "10", unit: "hour", amount_minor: 100000, rate_minor: 10000 }));
  const draft = (amount_minor: number, extras: object = {}) => b.call("invoice_draft", { request_id: rid(), client_id: client.id, lines: [{ item_id: item.id, amount_minor, tax: noTax }], due_date: "2026-11-20", supply_date: "2026-10-20", ...extras });
  return { ...b, client, item, draft };
}

describe("partial billing and payments", () => {
  it("serializes competing drafts, releases reservations and preserves snapshots", async () => {
    const b = await setup();
    const attempts = await Promise.all([b.draft(60000), b.draft(60000)]);
    expect(attempts.filter(r => r.ok)).toHaveLength(1);
    expect(attempts.find(r => !r.ok)).toMatchObject({ code: "ALLOCATION_CONFLICT" });
    const first = value<Invoice>(attempts.find(r => r.ok)!);
    expect(first.number).toBeUndefined();
    value(await b.call("invoice_cancel_draft", { request_id: rid(), invoice_id: first.id, reason: "Replace draft" }));
    const next = value<Invoice>(await b.draft(40000));
    const input = { request_id: rid(), invoice_id: next.id, expected_total_minor: 40000, confirmed: true };
    const issued = await Promise.all(Array.from({ length: 5 }, () => b.call("invoice_issue", input)));
    expect(issued.map(r => value<Invoice>(r).number)).toEqual([1, 1, 1, 1, 1]);
    const item = value(await b.call("billables_list", {})).records[0];
    expect(item).toMatchObject({ invoiced_minor: 40000, reserved_minor: 0, remaining_minor: 60000, state: "partial" });
    const last = value<Invoice>(await b.draft(60000));
    expect(value<Invoice>(await b.call("invoice_issue", { request_id: rid(), invoice_id: last.id, expected_total_minor: 60000, confirmed: true })).number).toBe(2);
    expect(await b.draft(1)).toMatchObject({ ok: false, code: "ALLOCATION_CONFLICT" });
    expect(await b.call("invoice_cancel_draft", { request_id: rid(), invoice_id: next.id, reason: "No" })).toMatchObject({ code: "DRAFT_REQUIRED" });
    value(await b.call("client_save", { request_id: rid(), client_id: b.client.id, name: "Changed name" }));
    const unchanged = value<Invoice>(await b.call("invoice_get", { invoice_id: next.id }));
    expect(unchanged.client_snapshot.name).toBe("Client");
    expect(unchanged.lines[0].source_snapshot.amount_minor).toBe(100000);
    expect(unchanged.lines[0].amount_minor).toBe(40000);
  });
  it("rolls back all allocations when a later line or discount fails", async () => {
    const b = await setup();
    const r = await b.draft(50000, { lines: [{ item_id: b.item.id, amount_minor: 50000, tax: noTax }, { item_id: "missing", amount_minor: 1 }] });
    expect(r).toMatchObject({ code: "NOT_FOUND" });
    expect(await b.draft(50000, { discount: { kind: "fixed", amount_minor: 60000 } })).toMatchObject({ code: "DISCOUNT_TOO_LARGE" });
    expect(value(await b.call("billables_list", {})).records[0].remaining_minor).toBe(100000);
  });
  it("deduplicates payment references, computes balances and prevents overpayment races", async () => {
    const b = await setup(), invoice = value<Invoice>(await b.draft(100000));
    value(await b.call("invoice_issue", { request_id: rid(), invoice_id: invoice.id, expected_total_minor: 100000, confirmed: true }));
    const p = { invoice_id: invoice.id, amount_minor: 40000, received_on: "2026-10-20", reference: "bank-1" };
    const payments = await Promise.all(Array.from({ length: 4 }, () => b.call("payment_record", { ...p, request_id: rid() })));
    expect(new Set(payments.map(r => value(r).id)).size).toBe(1);
    expect(value(await b.call("invoice_get", { invoice_id: invoice.id }))).toMatchObject({ paid_minor: 40000, balance_minor: 60000 });
    expect(await b.call("payment_record", { ...p, request_id: rid(), amount_minor: 20000 })).toMatchObject({ code: "PAYMENT_REFERENCE_CONFLICT" });
    const competing = await Promise.all(["bank-2", "bank-3"].map(reference => b.call("payment_record", { ...p, reference, amount_minor: 60000, request_id: rid() })));
    expect(competing.filter(r => r.ok)).toHaveLength(1);
    expect(competing.find(r => !r.ok)).toMatchObject({ code: "OVERPAYMENT" });
  });
  it("records nonbillable costs and creates exactly one linked reimbursable item", async () => {
    const b = await setup();
    value(await b.call("expense_record", { request_id: rid(), vendor: "Stationery", description: "Office", category: "supplies", incurred_on: "2026-10-20", cost_minor: 500 }));
    const p = { request_id: rid(), vendor: "Travel", description: "Client trip", category: "travel", incurred_on: "2026-10-20", cost_minor: 1000, client_id: b.client.id, billable_amount_minor: 1500 };
    const a = value(await b.call("expense_record", p)), repeat = value(await b.call("expense_record", p));
    expect(a.billable_id).toBe(repeat.billable_id);
    expect(value(await b.call("billables_list", {})).records).toHaveLength(2);
  });
});

describe("tax feedback and exact arithmetic", () => {
  it("returns actionable blockers, blocks missing tax and refuses stale snapshots", async () => {
    const b = await setup();
    const invoice = value<Invoice>(await b.draft(10000, { lines: [{ item_id: b.item.id, amount_minor: 10000 }] }));
    const check = value(await b.call("invoice_check", { invoice_id: invoice.id }));
    expect(check).toMatchObject({ ready: false, blockers: [{ field: "lines[0].tax", next_tool: "invoice_cancel_draft" }] });
    expect(await b.call("invoice_issue", { request_id: rid(), invoice_id: invoice.id, expected_total_minor: 10000, confirmed: true })).toMatchObject({ code: "INVOICE_NOT_READY", details: { ready: false } });
    const ready = value<Invoice>(await b.draft(10000));
    value(await b.call("client_save", { request_id: rid(), client_id: b.client.id, ...b.client, name: "New" }));
    expect(value(await b.call("invoice_check", { invoice_id: ready.id })).blockers.some((x: any) => x.field === "snapshot")).toBe(true);
  });
  it("calculates line and invoice discounts before exclusive VAT and records source consumption", async () => {
    const b = await setup();
    value(await b.call("tax_profile_set", { request_id: rid(), profile: { country: "GB", registration_status: "registered", registrations: [{ jurisdiction: "GB", number: "EXAMPLE", effective_from: "2026-01-01" }], reviewed_on: "2026-10-20", notes: "Fictional test only" } }));
    const draft = value<Invoice>(await b.draft(50000, { discount: { kind: "fixed", amount_minor: 5000 }, lines: [{ item_id: b.item.id, amount_minor: 50000, discount: { kind: "percent", rate_ppm: 100000 }, tax: vat }] }));
    expect(draft).toMatchObject({ subtotal_minor: 50000, discount_minor: 10000, net_minor: 40000, tax_minor: 8000, total_minor: 48000 });
    expect(value(await b.call("billables_list", {})).records[0]).toMatchObject({ reserved_minor: 50000, remaining_minor: 50000 });
    expect(await b.call("invoice_issue", { request_id: rid(), invoice_id: draft.id, expected_total_minor: 50000, confirmed: true })).toMatchObject({ code: "TOTAL_CHANGED" });
  });
  it("conserves minor units for proportional discounts and inclusive multi-component taxes", () => {
    const line = (amount_minor: number) => ({ item_id: rid(), source_snapshot: {} as Billable, amount_minor });
    const split = calculate([line(101), line(101), line(101)], { kind: "fixed", amount_minor: 2 });
    expect(split.lines.map(l => l.invoice_discount_minor)).toEqual([1, 1, 0]);
    expect(split.total_minor).toBe(301);
    const inclusive = calculate([{ ...line(12000), tax: { ...vat, treatment: "taxable", mode: "inclusive", evidence: [], components: [{ name: "A", rate_ppm: 50000, taxable_fraction_ppm: 1000000 }, { name: "B", rate_ppm: 150000, taxable_fraction_ppm: 1000000 }] } }]);
    expect(inclusive).toMatchObject({ total_minor: 12000, net_minor: 10000, tax_minor: 2000 });
    expect(inclusive.lines[0].taxes.map(t => t.amount_minor)).toEqual([500, 1500]);
    const fractional = calculate([{ ...line(10000), tax: { ...vat, treatment: "taxable", mode: "exclusive", evidence: [], components: [{ name: "Example", rate_ppm: 88750, taxable_fraction_ppm: 800000 }] } }]);
    expect(fractional.tax_minor).toBe(710);
  });
});

describe("shared business access", () => {
  it("requires identity-bound acceptance, enforces roles and immediately revokes access including retries", async () => {
    const owner = { userId: rid() }, email = `${rid()}@example.com`, teammate = { userId: await digest(`otis-user:${email}`) };
    const call = (op: Operation, args: unknown, who = owner) => privateOperation(env, who, op, args);
    const own = value(await call("business_set", { request_id: rid(), name: "Agency", currency: "USD" }));
    const business_id = own.business_id;
    const invite = value(await call("team_invite", { request_id: rid(), email, role: "viewer" }));
    const list = value(await call("businesses_list", {}, teammate));
    expect(list.records.some((x: any) => x.business_id === business_id && x.status === "invited")).toBe(true);
    expect(await call("business_get", { business_id }, teammate)).toMatchObject({ code: "FORBIDDEN" });
    const acceptance = { request_id: rid(), business_id, invitation_id: invite.invitation_id };
    expect(await call("team_accept", acceptance, { userId: "intruder" })).toMatchObject({ code: "FORBIDDEN" });
    value(await call("team_accept", acceptance, teammate));
    value(await call("team_accept", acceptance, teammate));
    expect(value(await call("business_get", { business_id }, teammate)).name).toBe("Agency");
    const client = { request_id: rid(), business_id, name: "Shared client" };
    expect(await call("client_save", client, teammate)).toMatchObject({ code: "FORBIDDEN" });
    value(await call("team_member_set", { request_id: rid(), member_id: invite.id, role: "editor" }));
    value(await call("client_save", client, teammate));
    expect(await call("business_set", { request_id: rid(), business_id, name: "Hijack", currency: "USD" }, teammate)).toMatchObject({ code: "FORBIDDEN" });
    value(await call("team_member_set", { request_id: rid(), member_id: invite.id, role: "removed" }));
    expect(await call("client_save", client, teammate)).toMatchObject({ code: "FORBIDDEN" });
    expect(await call("business_get", { business_id }, teammate)).toMatchObject({ code: "FORBIDDEN" });
    const ownMember = value(await call("team_list", {})).records.find((m: any) => m.role === "owner");
    expect(await call("team_member_set", { request_id: rid(), member_id: ownMember.id, role: "removed" })).toMatchObject({ code: "OWNER_REQUIRED" });
  });
});

describe("record edits and invoice preferences", () => {
  it("edits only available work and updates linked expense facts atomically", async () => {
    const b = await setup();
    const work = { request_id: rid(), item_id: b.item.id, client_id: b.client.id, kind: "time", description: "Corrected work", quantity: "8", unit: "hour", amount_minor: 80000, rate_minor: 10000 };
    expect(value(await b.call("billable_record", work))).toMatchObject({ id: b.item.id, remaining_minor: 80000, amount_minor: 80000 });
    const draft = value<Invoice>(await b.draft(10000));
    expect(await b.call("billable_record", { ...work, request_id: rid() })).toMatchObject({ code: "ITEM_LOCKED" });
    value(await b.call("invoice_cancel_draft", { request_id: rid(), invoice_id: draft.id, reason: "Edit work" }));
    value(await b.call("billable_record", { ...work, request_id: rid() }));
    const expense = { request_id: rid(), vendor: "Train", category: "travel", description: "Trip", incurred_on: "2026-10-20", cost_minor: 1000, client_id: b.client.id, billable_amount_minor: 1500 };
    const old = value(await b.call("expense_record", expense));
    const updated = value(await b.call("expense_record", { ...expense, request_id: rid(), expense_id: old.id, cost_minor: 1100, billable_amount_minor: 1600 }));
    expect(updated.billable_id).toBe(old.billable_id);
    expect(value(await b.call("billables_list", {})).records.find((r: any) => r.id === old.billable_id)).toMatchObject({ cost_minor: 1100, amount_minor: 1600 });
    expect(await b.call("billable_record", { ...work, request_id: rid(), item_id: old.billable_id })).toMatchObject({ code: "LINKED_EXPENSE" });
    value(await b.draft(1, { lines: [{ item_id: old.billable_id, amount_minor: 1600, tax: noTax }] }));
    expect(await b.call("expense_record", { ...expense, request_id: rid(), expense_id: old.id, cost_minor: 999 })).toMatchObject({ code: "ITEM_LOCKED" });
    expect(value(await b.call("expenses_list", {})).records[0].cost_minor).toBe(1100);
  });
  it("uses configured numbering once, preserves defaults and locks the starting number after issue", async () => {
    const b = await setup();
    const profile = { request_id: rid(), name: "Studio", currency: "USD", invoice_preferences: { starting_number: 1041, prefix: "INV-", number_padding: 6, default_note: "Thank you", payment_instructions: "Bank transfer" } };
    value(await b.call("business_set", profile));
    value(await b.call("business_set", { request_id: rid(), name: "Studio", currency: "USD" }));
    const draft = value<Invoice>(await b.draft(10000));
    expect(draft.note).toBe("Thank you");
    const invoice = value<Invoice>(await b.call("invoice_issue", { request_id: rid(), invoice_id: draft.id, expected_total_minor: 10000, confirmed: true }));
    expect(invoice).toMatchObject({ number: 1041, display_number: "INV-001041", business_snapshot: { invoice_preferences: { payment_instructions: "Bank transfer" } } });
    expect(await b.call("business_set", { ...profile, request_id: rid(), invoice_preferences: { starting_number: 1 } })).toMatchObject({ code: "NUMBERING_LOCKED" });
  });
});
