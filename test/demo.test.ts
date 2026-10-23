import { describe, expect, it } from "vitest";
import { demoRecords, demoResult } from "../src/demo";
import { READ_OPERATIONS, type Billable, type Expense, type Invoice, type Payment, type Timer } from "../src/models";

const data = (operation: Parameters<typeof demoResult>[0], input: object = {}) => (demoResult(operation, input) as { ok: boolean; data: any }).data;
const billables = demoRecords.billable as Billable[];
const invoices = demoRecords.invoice as (Invoice & { paid_minor: number; balance_minor: number })[];
const byId = <T extends { id: string }>(list: T[], id: string) => list.find(item => item.id === id)!;

describe("demo account", () => {
  it("matches the figures the website quotes for Fernhill Coffee", () => {
    const unbilled = data("billables_list", { client_id: "fernhill-coffee", state: "unbilled" }).records as Billable[];
    expect(unbilled.map(item => item.amount_minor)).toEqual([36000, 24000, 7500, 1200]);
    expect(unbilled.reduce((sum, item) => sum + item.remaining_minor, 0)).toBe(68700);
    expect(data("invoice_get", { invoice_id: "invoice-1041" })).toMatchObject({ display_number: "NS-1041", number: 1041, total_minor: 100000, paid_minor: 40000, balance_minor: 60000, due_date: "2026-10-01" });
    const september = (data("expenses_list", { client_id: "fernhill-coffee" }).records as Expense[]).filter(item => item.incurred_on.startsWith("2026-09"));
    expect(september.reduce((sum, item) => sum + item.cost_minor, 0)).toBe(12300);
  });

  it("keeps every allocation, link and balance consistent", () => {
    for (const item of billables) {
      expect(item.reserved_minor + item.invoiced_minor + item.remaining_minor, item.id).toBe(item.amount_minor);
      const issued = invoices.filter(record => record.status === "issued").flatMap(record => record.lines).filter(line => line.item_id === item.id);
      const drafted = invoices.filter(record => record.status === "draft").flatMap(record => record.lines).filter(line => line.item_id === item.id);
      expect(issued.reduce((sum, line) => sum + line.amount_minor, 0), item.id).toBe(item.invoiced_minor);
      expect(drafted.reduce((sum, line) => sum + line.amount_minor, 0), item.id).toBe(item.reserved_minor);
      if (item.rate_minor && item.unit.startsWith("hour")) expect(Math.round(Number(item.quantity) * item.rate_minor), item.id).toBe(item.amount_minor);
    }
    for (const record of invoices) {
      for (const line of record.lines) expect(byId(billables, line.item_id).client_id, record.id).toBe(record.client_id);
      expect(record.lines.reduce((sum, line) => sum + line.total_minor, 0), record.id).toBe(record.total_minor);
      expect(record.balance_minor, record.id).toBeGreaterThanOrEqual(0);
    }
    expect(new Set(invoices.filter(record => record.number).map(record => record.number))).toEqual(new Set([1038, 1039, 1040, 1041, 1042]));
    for (const expense of demoRecords.expense as Expense[]) {
      if (expense.billable_id) expect(byId(billables, expense.billable_id).expense_id).toBe(expense.id);
    }
    for (const timer of demoRecords.timer as Timer[]) {
      if (timer.state === "recorded") expect(byId(billables, timer.billable_id!)).toMatchObject({ timer_id: timer.id, quantity: timer.hours, client_id: timer.client_id });
    }
    const references = (demoRecords.payment as Payment[]).map(item => item.reference);
    expect(new Set(references).size).toBe(references.length);
  });

  it("answers every read tool from the records, with a real check for the draft", () => {
    for (const operation of READ_OPERATIONS) {
      if (["otis_menu", "tax_guide", "businesses_list", "team_list"].includes(operation)) continue;
      const input = operation === "records_export" ? { kind: "timer" } : operation.startsWith("invoice_") ? { invoice_id: "invoice-1041" } : {};
      expect((demoResult(operation, input) as { ok: boolean }).ok, operation).toBe(true);
    }
    expect(data("invoice_check", { invoice_id: "draft-lumen-copy-review" })).toMatchObject({ ready: true, total_minor: 72000 });
    expect(data("invoice_check", { invoice_id: "invoice-1041" }).ready).toBe(false);
    expect(data("timers_list", { state: "running" }).records).toEqual([expect.objectContaining({ id: "timer-harbor-permits", elapsed_minutes: 80 })]);
    expect(data("invoices_list", { status: "draft" }).records).toHaveLength(1);
    expect(data("invoices_list", { status: "cancelled" }).records).toHaveLength(1);
    for (const kind of ["business", "client", "billable", "expense", "timer", "invoice", "payment", "audit"]) expect(data("records_export", { kind }).records.length, kind).toBeGreaterThan(0);
    expect(demoResult("invoice_get", { invoice_id: "nope" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("says it is the demo account and never calls itself a sample", () => {
    const response = demoResult("business_get", {}) as Record<string, unknown>;
    expect(response).toMatchObject({ demo: true, demo_as_of: "2026-10-20", ok: true });
    expect(JSON.stringify(demoRecords)).not.toMatch(/sample/i);
    expect(JSON.stringify(response)).not.toMatch(/sample/i);
  });
});
