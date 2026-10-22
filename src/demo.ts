import type { Business, Billable, ClientRecord, Invoice, Operation } from "./models";
import { schemas } from "./models";

const business: Business = { id: "business", name: "Northstar Studio (sample)", currency: "USD", billing_address: "Sample address — fictional business" };
const clients: ClientRecord[] = [{ id: "sample-acme", name: "Acme (sample)", email: "billing@example.com", billing_address: "Sample client address", country: "US", region: "NY", customer_type: "business", tax_ids: [] }];
const billables: Billable[] = [
  { id: "sample-time", client_id: "sample-acme", kind: "time", description: "Five hours of consulting", quantity: "5", unit: "hour", rate_minor: 12000, amount_minor: 60000, currency: "USD", reserved_minor: 0, invoiced_minor: 0, remaining_minor: 0, state: "unbilled" },
  { id: "sample-expense", client_id: "sample-acme", kind: "expense", description: "Client workshop supplies", quantity: "1", unit: "expense", amount_minor: 7500, cost_minor: 7500, currency: "USD", reserved_minor: 0, invoiced_minor: 0, remaining_minor: 0, state: "unbilled" },
  { id: "sample-ai", client_id: "sample-acme", kind: "ai_usage", description: "Estimated coding-session usage", quantity: "2000000", unit: "token", amount_minor: 1200, cost_minor: 1200, measurement: "estimated", currency: "USD", reserved_minor: 0, invoiced_minor: 0, remaining_minor: 0, state: "unbilled" }
];
for (const item of billables) item.remaining_minor = item.amount_minor;
const invoices: Invoice[] = [{
  id: "sample-invoice", client_id: "sample-acme", status: "issued", number: 1041,
  lines: [],
  subtotal_minor: 100000, discount_minor: 0, net_minor: 100000, tax_minor: 0, supply_date: "2026-09-15",
  currency: "USD", total_minor: 100000, due_date: "2026-10-01", issued_at: "2026-09-15T12:00:00Z",
  business_snapshot: business, client_snapshot: clients[0]
}];
invoices[0].lines = [{ item_id: "sample-prior-work", source_snapshot: { ...billables[0], id: "sample-prior-work", description: "Previous consulting project", quantity: "1", unit: "project", rate_minor: 100000, amount_minor: 100000, invoiced_minor: 100000, remaining_minor: 0, state: "invoiced" }, amount_minor: 100000, line_discount_minor: 0, invoice_discount_minor: 0, net_minor: 100000, tax_minor: 0, total_minor: 100000, taxes: [], tax: { treatment: "out_of_scope", jurisdiction: "Fictional sample", service_category: "Sample consulting", reason: "Illustrative sample only, not tax guidance", mode: "exclusive", components: [], evidence: [] } }];
const payments = [{ id: "sample-payment", invoice_id: "sample-invoice", amount_minor: 40000, currency: "USD", received_on: "2026-09-20", reference: "sample-bank-reference" }];

export function demoResult(operation: Operation, input: unknown): unknown {
  const parsed = schemas[operation].parse(input) as Record<string, unknown>;
  const paginate = (items: unknown[]) => {
    const offset = Number(parsed.offset ?? 0), limit = Number(parsed.limit ?? 50);
    return { records: items.slice(offset, offset + limit), next_offset: offset + limit < items.length ? offset + limit : null };
  };
  let data: unknown;
  if (operation === "business_get") data = business;
  else if (operation === "clients_list") data = paginate(clients);
  else if (operation === "billables_list") data = paginate(billables.filter((item) =>
    (!parsed.client_id || item.client_id === parsed.client_id) && (!parsed.state || item.state === parsed.state)));
  else if (operation === "invoices_list") data = paginate(invoices.filter((invoice) => !parsed.status || invoice.status === parsed.status)
    .map((invoice) => ({ ...invoice, paid_minor: 40000, balance_minor: 60000 })));
  else if (operation === "invoice_get") {
    if (parsed.invoice_id !== "sample-invoice") return { demo: true, ok: false, code: "NOT_FOUND", message: "Sample invoice not found. List invoices first." };
    data = { ...invoices[0], paid_minor: 40000, balance_minor: 60000 };
  } else if (operation === "expenses_list" || operation === "timers_list") data = paginate([]);
  else if (operation === "invoice_check") data = { ready: false, blockers: [{ field: "demo", message: "The sample demo cannot issue invoices.", next_tool: "invoice_get" }] };
  else if (operation === "payments_list") data = paginate(payments.filter((payment) => !parsed.invoice_id || payment.invoice_id === parsed.invoice_id));
  else if (operation === "records_export") {
    const byKind: Record<string, unknown[]> = { business: [business], client: clients, billable: billables, timer: [], invoice: invoices, payment: payments, audit: [] };
    data = paginate(byKind[String(parsed.kind)] ?? []);
  } else return { demo: true, ok: false, code: "DEMO_READ_ONLY", message: "The sample demo is read-only. Connect the private /mcp endpoint to save your own records." };
  return { demo: true, sample_as_of: "2026-10-20", notice: "Fictional sample data. This demo does not save inputs or create an account.", ok: true, data };
}
