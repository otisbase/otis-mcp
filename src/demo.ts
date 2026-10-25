import type { Billable, Business, ClientRecord, Discount, Expense, Invoice, JsonValue, Operation, Payment, Tax, Timer } from "./models";
import { canonical, schemas } from "./models";
import { calculate, round, taxBlockers } from "./billing";

/*
 * The demo account behind /demo/mcp: Northstar Studio, a small consultancy in Portland, Oregon, three months
 * into using Otis. Every record is fictional and the account is read-only, but the records hang together the
 * way a real business's do: invoice totals come from the same billing code as the private service, work is
 * reserved by drafts and consumed by issued invoices, and balances follow the payments. The data stands still
 * at DEMO_AS_OF, so a running timer's elapsed time is measured from then, not from today.
 *
 * The website's examples quote this account (Fernhill Coffee's $687 ready to invoice, invoice 1041 for $1,000
 * with $400 paid), so change the website's story and traces with it.
 */
export const DEMO_AS_OF = "2026-10-20T16:00:00Z";
const CURRENCY = "USD";
const OWNER = "member:demo-owner";

const business: Business = {
  id: "business", name: "Northstar Studio", currency: CURRENCY,
  billing_address: "Northstar Studio LLC, 1200 Example Avenue, Suite 300, Portland, OR 97204, United States",
  invoice_preferences: {
    prefix: "NS-", number_padding: 1, starting_number: 1038,
    default_note: "Thank you for working with Northstar Studio.",
    payment_instructions: "Pay by bank transfer to Northstar Studio LLC by the due date. Use the invoice number as the payment reference.",
  },
  tax_profile: {
    country: "US", region: "OR", registration_status: "not_registered", registrations: [], reviewed_on: "2026-08-01",
    notes: "Northstar Studio is not registered to collect sales tax or VAT anywhere. Oregon has no general sales tax. Confirmed with the studio's accountant on 1 August 2026.",
  },
};

const client = (id: string, name: string, email: string, billing_address: string, country: string, region?: string, tax_ids: string[] = []): ClientRecord =>
  ({ id, name, email, billing_address, country, ...(region ? { region } : {}), customer_type: "business", tax_ids });
const clients: ClientRecord[] = [
  client("fernhill-coffee", "Fernhill Coffee", "accounts@fernhill.example.com", "418 Alder Street, Portland, OR 97205, United States", "US", "OR"),
  client("harbor-pine", "Harbor & Pine Architects", "billing@harborpine.example.com", "92 Wharf Road, Seattle, WA 98101, United States", "US", "WA"),
  client("lumen-health", "Lumen Health Clinic", "finance@lumenhealth.example.com", "2700 Larkspur Way, Boise, ID 83702, United States", "US", "ID"),
  client("kestrel-labs", "Kestrel Labs Ltd", "accounts@kestrellabs.example.com", "14 Canal Street, Manchester M1 3HE, United Kingdom", "GB", undefined, ["GB 123 4567 89"]),
];
const clientById = (id: string) => clients.find(item => item.id === id)!;

// Billable work: hours, fixed-price services, AI usage and billed-back expenses.
type Extra = Partial<Pick<Billable, "rate_minor" | "cost_minor" | "measurement" | "reference" | "expense_id" | "timer_id">>;
function work(id: string, client_id: string, kind: Billable["kind"], description: string, quantity: string, unit: string, amount_minor: number, extra: Extra = {}): Billable {
  return { id, client_id, kind, description, quantity, unit, amount_minor, ...extra, currency: CURRENCY, state: "unbilled", reserved_minor: 0, invoiced_minor: 0, remaining_minor: amount_minor };
}
/** Hours to six decimals from whole minutes, as timer_stop records them. */
function hours(minutes: number): string {
  const micro = String(round(BigInt(minutes) * 1_000_000n, 60n)).padStart(7, "0");
  const fraction = micro.slice(-6).replace(/0+$/, "");
  return fraction ? `${micro.slice(0, -6)}.${fraction}` : micro.slice(0, -6);
}
const timed = (minutes: number, rate: number) => round(BigInt(round(BigInt(minutes) * 1_000_000n, 60n)) * BigInt(rate), 1_000_000n);

const billables: Billable[] = [
  // Fernhill Coffee: an issued, part-paid invoice and $687 ready to invoice.
  work("fernhill-brand-sprint", "fernhill-coffee", "time", "Brand strategy sprint", "1", "project", 100000, { rate_minor: 100000 }),
  work("fernhill-workshop-facilitation", "fernhill-coffee", "time", "Brand workshop facilitation", hours(180), "hours", timed(180, 12000), { rate_minor: 12000, timer_id: "timer-fernhill-workshop" }),
  work("fernhill-menu-pricing", "fernhill-coffee", "time", "Menu pricing review", "2", "hour", 24000, { rate_minor: 12000 }),
  work("fernhill-workshop-supplies", "fernhill-coffee", "expense", "Workshop supplies", "1", "expense", 7500, { cost_minor: 7500, expense_id: "expense-fernhill-supplies" }),
  work("fernhill-menu-photos", "fernhill-coffee", "ai_usage", "Menu photo generation", "2000000", "token", 1200, { cost_minor: 1200, measurement: "estimated" }),
  // Harbor & Pine Architects: one invoice paid, one part-paid, and new work to bill.
  work("harbor-design-system", "harbor-pine", "time", "Design system build, August", "20", "hour", 240000, { rate_minor: 12000 }),
  work("harbor-permit-reviews", "harbor-pine", "time", "Permit drawing reviews, September", "12", "hour", 156000, { rate_minor: 13000 }),
  work("harbor-site-mileage", "harbor-pine", "expense", "Mileage for the Seattle site visit", "1", "expense", 6400, { cost_minor: 6400, expense_id: "expense-harbor-mileage" }),
  work("harbor-stock-photos", "harbor-pine", "expense", "Stock photography for the client presentation", "1", "expense", 4500, { cost_minor: 4500, expense_id: "expense-harbor-stock" }),
  // Lumen Health Clinic: a paid invoice, a draft holding work, and timed work.
  work("lumen-intake-redesign", "lumen-health", "time", "Patient intake form redesign", "1", "project", 180000, { rate_minor: 180000 }),
  work("lumen-accessibility-research", "lumen-health", "ai_usage", "Accessibility research with Claude", "1800000", "token", 3600, { cost_minor: 1800, measurement: "measured" }),
  work("lumen-copy-review", "lumen-health", "time", "Clinic website copy review", "6", "hour", 72000, { rate_minor: 12000 }),
  work("lumen-accessibility-review", "lumen-health", "time", "Accessibility review", hours(90), "hours", timed(90, 12000), { rate_minor: 12000, timer_id: "timer-lumen-accessibility" }),
  // Kestrel Labs (UK): a paid invoice, a cancelled draft and a recorded call.
  work("kestrel-strategy-workshop", "kestrel-labs", "time", "Product strategy workshop", "8", "hour", 120000, { rate_minor: 15000 }),
  work("kestrel-interview-synthesis", "kestrel-labs", "ai_usage", "Customer interview synthesis", "4500000", "token", 4500, { cost_minor: 2700, measurement: "measured" }),
  work("kestrel-roadmap-session", "kestrel-labs", "time", "Roadmap follow-up session", "4", "hour", 60000, { rate_minor: 15000 }),
  work("kestrel-discovery-call", "kestrel-labs", "time", "Discovery call", hours(45), "hours", timed(45, 15000), { rate_minor: 15000, timer_id: "timer-kestrel-call" }),
];
const billable = (id: string) => billables.find(item => item.id === id)!;

const expense = (id: string, vendor: string, category: string, description: string, incurred_on: string, cost_minor: number, client_id?: string, billable_id?: string): Expense =>
  ({ id, vendor, category, description, incurred_on, cost_minor, ...(client_id ? { client_id } : {}), ...(billable_id ? { billable_amount_minor: billable(billable_id).amount_minor, billable_id } : {}), currency: CURRENCY });
const expenses: Expense[] = [
  expense("expense-fernhill-supplies", "Paper & Co", "Supplies", "Workshop supplies", "2026-09-12", 7500, "fernhill-coffee", "fernhill-workshop-supplies"),
  expense("expense-harbor-mileage", "Personal vehicle", "Travel", "Mileage for the Seattle site visit", "2026-09-24", 6400, "harbor-pine", "harbor-site-mileage"),
  expense("expense-fernhill-proofs", "Copy Corner", "Printing", "Printed menu proofs", "2026-09-26", 4800, "fernhill-coffee"),
  expense("expense-coworking", "Alder Street Cowork", "Office", "Coworking desk, October", "2026-10-01", 32000),
  expense("expense-design-software", "Design software", "Software", "Monthly subscription", "2026-10-01", 1900),
  expense("expense-ai-subscription", "AI assistant", "Software", "AI assistant subscription, October", "2026-10-03", 2000),
  expense("expense-harbor-stock", "Stock library", "Stock media", "Stock photography for the client presentation", "2026-10-08", 4500, "harbor-pine", "harbor-stock-photos"),
];

// Invoices, built the way invoice_draft and invoice_issue build them.
function taxFor(record: ClientRecord): Tax {
  return { treatment: "not_registered", jurisdiction: record.country === "US" ? `US-${record.region}` : record.country ?? "unknown",
    reason: "Northstar Studio is not registered to collect sales tax or VAT; confirmed in its tax profile.", service_category: "Consulting services",
    evidence: [], mode: "exclusive", components: [] };
}
function setState(item: Billable) {
  item.remaining_minor = item.amount_minor - item.reserved_minor - item.invoiced_minor;
  item.state = item.invoiced_minor === item.amount_minor ? "invoiced" : item.invoiced_minor > 0 ? "partial" : item.reserved_minor > 0 ? "reserved" : "unbilled";
}
type InvoiceOptions = { status: Invoice["status"]; number?: number; supply_date: string; due_date: string; issued_at?: string; cancelled_reason?: string; discount?: Discount };
function invoice(id: string, client_id: string, items: string[], options: InvoiceOptions): Invoice {
  const record = clientById(client_id);
  const lines = items.map(itemId => ({ item_id: itemId, source_snapshot: structuredClone(billable(itemId)), amount_minor: billable(itemId).remaining_minor, tax: taxFor(record) }));
  for (const line of lines) {
    const item = billable(line.item_id);
    if (options.status === "issued") item.invoiced_minor += line.amount_minor;
    if (options.status === "draft") item.reserved_minor += line.amount_minor;
    setState(item);
  }
  const { number, issued_at, cancelled_reason, discount, ...dates } = options;
  return { id, client_id, currency: CURRENCY, ...calculate(lines, discount), ...(discount ? { discount } : {}), ...dates,
    note: business.invoice_preferences?.default_note,
    ...(number ? { number, display_number: `${business.invoice_preferences?.prefix}${number}`, issued_at } : {}),
    ...(cancelled_reason ? { cancelled_reason } : {}), business_snapshot: business, client_snapshot: record };
}
const invoices: Invoice[] = [
  invoice("invoice-1038", "harbor-pine", ["harbor-design-system"], { status: "issued", number: 1038, supply_date: "2026-08-31", due_date: "2026-09-30", issued_at: "2026-08-31T17:10:00Z", discount: { kind: "percent", rate_ppm: 50000 } }),
  invoice("invoice-1039", "lumen-health", ["lumen-intake-redesign", "lumen-accessibility-research"], { status: "issued", number: 1039, supply_date: "2026-09-05", due_date: "2026-09-20", issued_at: "2026-09-05T16:30:00Z" }),
  invoice("invoice-1040", "kestrel-labs", ["kestrel-strategy-workshop", "kestrel-interview-synthesis"], { status: "issued", number: 1040, supply_date: "2026-09-10", due_date: "2026-10-10", issued_at: "2026-09-10T09:15:00Z" }),
  invoice("invoice-1041", "fernhill-coffee", ["fernhill-brand-sprint"], { status: "issued", number: 1041, supply_date: "2026-09-15", due_date: "2026-10-01", issued_at: "2026-09-15T18:00:00Z" }),
  invoice("invoice-1042", "harbor-pine", ["harbor-permit-reviews", "harbor-site-mileage"], { status: "issued", number: 1042, supply_date: "2026-09-30", due_date: "2026-10-30", issued_at: "2026-09-30T20:45:00Z" }),
  invoice("draft-kestrel-roadmap", "kestrel-labs", ["kestrel-roadmap-session"], { status: "cancelled", supply_date: "2026-10-09", due_date: "2026-11-08", cancelled_reason: "Kestrel asked to bill this with next month's work." }),
  invoice("draft-lumen-copy-review", "lumen-health", ["lumen-copy-review"], { status: "draft", supply_date: "2026-10-20", due_date: "2026-11-19" }),
];
// The cancelled draft released its work again, as invoice_cancel_draft does.
for (const id of ["kestrel-roadmap-session"]) setState(billable(id));

const payment = (id: string, invoice_id: string, amount_minor: number, received_on: string, reference: string): Payment =>
  ({ id, invoice_id, amount_minor, currency: CURRENCY, received_on, reference });
const payments: Payment[] = [
  payment("payment-1038", "invoice-1038", invoices[0].total_minor, "2026-09-14", "HP-ACH-0914"),
  payment("payment-1039", "invoice-1039", invoices[1].total_minor, "2026-09-18", "LHC-4471"),
  payment("payment-1041-part", "invoice-1041", 40000, "2026-09-20", "FC-TRANSFER-0920"),
  payment("payment-1040", "invoice-1040", invoices[2].total_minor, "2026-09-28", "KL-BACS-2809"),
  payment("payment-1042-part", "invoice-1042", 80000, "2026-10-15", "HP-ACH-1015"),
];

// Timers, from one still running to one thrown away.
const timers: Timer[] = [
  { id: "timer-fernhill-workshop", client_id: "fernhill-coffee", description: "Brand workshop facilitation", started_by: OWNER, state: "recorded",
    started_at: "2026-10-14T16:00:00.000Z", clock_started_at: "2026-10-14T16:00:00.000Z", start_reported: false,
    stopped_at: "2026-10-14T19:00:00.000Z", clock_stopped_at: "2026-10-14T19:00:00.000Z", stop_reported: false, minutes: 180, hours: hours(180), billable_id: "fernhill-workshop-facilitation" },
  { id: "timer-kestrel-call", client_id: "kestrel-labs", description: "Discovery call", started_by: OWNER, state: "recorded",
    started_at: "2026-10-16T09:00:00.000Z", clock_started_at: "2026-10-16T09:00:00.000Z", start_reported: false,
    stopped_at: "2026-10-16T09:45:00.000Z", clock_stopped_at: "2026-10-16T09:45:00.000Z", stop_reported: false, minutes: 45, hours: hours(45), billable_id: "kestrel-discovery-call" },
  { id: "timer-lumen-accessibility", client_id: "lumen-health", description: "Accessibility review", started_by: OWNER, state: "recorded",
    started_at: "2026-10-17T17:00:00.000Z", clock_started_at: "2026-10-17T17:22:00.000Z", start_reported: true,
    stopped_at: "2026-10-17T18:30:00.000Z", clock_stopped_at: "2026-10-17T18:30:00.000Z", stop_reported: false, minutes: 90, hours: hours(90), billable_id: "lumen-accessibility-review" },
  { id: "timer-harbor-site-notes", client_id: "harbor-pine", description: "Site visit notes", started_by: OWNER, state: "discarded",
    started_at: "2026-10-12T15:00:00.000Z", clock_started_at: "2026-10-12T15:00:00.000Z", start_reported: false },
  { id: "timer-fernhill-photo-brief", client_id: "fernhill-coffee", description: "Menu photography brief", started_by: OWNER, state: "stopped",
    started_at: "2026-10-19T20:00:00.000Z", clock_started_at: "2026-10-19T20:00:00.000Z", start_reported: false,
    stopped_at: "2026-10-19T20:40:00.000Z", clock_stopped_at: "2026-10-19T20:40:00.000Z", stop_reported: false, minutes: 40, hours: hours(40) },
  { id: "timer-harbor-permits", client_id: "harbor-pine", description: "Permit drawings review", started_by: OWNER, state: "running",
    started_at: "2026-10-20T14:40:00.000Z", clock_started_at: "2026-10-20T14:40:00.000Z", start_reported: false },
];

// The change history records_export returns for kind "audit": each write, in the order it happened.
type AuditEntry = { id: string; actor_id: string; operation: Operation; request_id: string; occurred_at: string; input: JsonValue; result: JsonValue };
const audit: AuditEntry[] = [];
const log = (occurred_at: string, operation: Operation, input: Record<string, JsonValue>, result: Record<string, JsonValue>) =>
  audit.push({ id: `audit-${String(audit.length + 1).padStart(3, "0")}`, actor_id: OWNER, operation, request_id: `${operation.replace(/_/g, "-")}-${audit.length + 1}`, occurred_at, input, result });
log("2026-08-01T15:00:00Z", "business_set", { name: business.name, currency: CURRENCY }, { id: "business" });
log("2026-08-01T15:06:00Z", "tax_profile_set", { country: "US", region: "OR", registration_status: "not_registered" }, { id: "business" });
for (const [index, record] of clients.entries()) log(`2026-08-0${2 + index}T16:00:00Z`, "client_save", { name: record.name, country: record.country ?? null }, { id: record.id });
log("2026-08-29T18:20:00Z", "billable_record", { client_id: "harbor-pine", kind: "time", quantity: "20", rate_minor: 12000 }, { id: "harbor-design-system" });
log("2026-08-31T17:02:00Z", "invoice_draft", { client_id: "harbor-pine", discount: { kind: "percent", rate_ppm: 50000 } }, { id: "invoice-1038", total_minor: invoices[0].total_minor });
log("2026-08-31T17:10:00Z", "invoice_issue", { invoice_id: "invoice-1038", expected_total_minor: invoices[0].total_minor }, { display_number: "NS-1038" });
log("2026-09-05T16:30:00Z", "invoice_issue", { invoice_id: "invoice-1039", expected_total_minor: invoices[1].total_minor }, { display_number: "NS-1039" });
log("2026-09-10T09:15:00Z", "invoice_issue", { invoice_id: "invoice-1040", expected_total_minor: invoices[2].total_minor }, { display_number: "NS-1040" });
log("2026-09-12T20:00:00Z", "expense_record", { vendor: "Paper & Co", cost_minor: 7500, client_id: "fernhill-coffee", billable_amount_minor: 7500 }, { id: "expense-fernhill-supplies" });
log("2026-09-14T15:00:00Z", "payment_record", { invoice_id: "invoice-1038", amount_minor: invoices[0].total_minor, reference: "HP-ACH-0914" }, { id: "payment-1038" });
log("2026-09-15T18:00:00Z", "invoice_issue", { invoice_id: "invoice-1041", expected_total_minor: 100000 }, { display_number: "NS-1041" });
log("2026-09-18T16:40:00Z", "payment_record", { invoice_id: "invoice-1039", amount_minor: invoices[1].total_minor, reference: "LHC-4471" }, { id: "payment-1039" });
log("2026-09-20T17:05:00Z", "payment_record", { invoice_id: "invoice-1041", amount_minor: 40000, reference: "FC-TRANSFER-0920" }, { id: "payment-1041-part" });
log("2026-09-28T10:30:00Z", "payment_record", { invoice_id: "invoice-1040", amount_minor: invoices[2].total_minor, reference: "KL-BACS-2809" }, { id: "payment-1040" });
log("2026-09-30T20:45:00Z", "invoice_issue", { invoice_id: "invoice-1042", expected_total_minor: invoices[4].total_minor }, { display_number: "NS-1042" });
log("2026-10-09T15:20:00Z", "invoice_cancel_draft", { invoice_id: "draft-kestrel-roadmap", reason: "Kestrel asked to bill this with next month's work." }, { status: "cancelled" });
log("2026-10-14T19:00:00Z", "timer_stop", { timer_id: "timer-fernhill-workshop", rate_minor: 12000 }, { recorded: true, billable_id: "fernhill-workshop-facilitation" });
log("2026-10-15T16:10:00Z", "payment_record", { invoice_id: "invoice-1042", amount_minor: 80000, reference: "HP-ACH-1015" }, { id: "payment-1042-part" });
log("2026-10-17T17:22:00Z", "timer_start", { client_id: "lumen-health", description: "Accessibility review", started_at: "2026-10-17T10:00:00-07:00" }, { id: "timer-lumen-accessibility", start_reported: true });
log("2026-10-20T14:40:00Z", "timer_start", { client_id: "harbor-pine", description: "Permit drawings review" }, { id: "timer-harbor-permits" });
log("2026-10-20T15:30:00Z", "invoice_draft", { client_id: "lumen-health", lines: [{ item_id: "lumen-copy-review", amount_minor: 72000 }] }, { id: "draft-lumen-copy-review", status: "draft" });

const paidOn = (invoiceId: string) => payments.filter(item => item.invoice_id === invoiceId).reduce((sum, item) => sum + item.amount_minor, 0);
const balance = (record: Invoice) => ({ ...record, paid_minor: paidOn(record.id), balance_minor: record.status === "cancelled" ? 0 : record.total_minor - paidOn(record.id) });
function check(record: Invoice) {
  const blockers = taxBlockers(record, business, clientById(record.client_id));
  if (record.status !== "draft") blockers.push({ field: "status", message: "Only drafts can be issued.", next_tool: "invoice_get" });
  if (canonical(business) !== canonical(record.business_snapshot) || canonical(clientById(record.client_id)) !== canonical(record.client_snapshot)) blockers.push({ field: "snapshot", message: "Business or client details changed. Cancel and recreate the draft.", next_tool: "invoice_cancel_draft" });
  return { ready: blockers.length === 0, blockers, total_minor: record.total_minor, currency: record.currency,
    notice: "Readiness validates recorded facts and arithmetic. It does not certify the legal tax treatment. This demo account is read-only, so nothing can be issued here." };
}
const withElapsed = (timer: Timer) => timer.state === "running" ? { ...timer, elapsed_minutes: Math.round((Date.parse(DEMO_AS_OF) - Date.parse(timer.started_at)) / 60_000) } : timer;

/** Every record kind the demo account holds, as records_export returns them. */
export const demoRecords: Record<string, readonly unknown[]> = {
  business: [business], client: clients, billable: billables, expense: expenses, timer: timers, invoice: invoices.map(balance), payment: payments, audit,
};

export function demoResult(operation: Operation, input: unknown): unknown {
  const parsed = schemas[operation].parse(input) as Record<string, unknown>;
  const paginate = (items: readonly unknown[]) => {
    const offset = Number(parsed.offset ?? 0), limit = Number(parsed.limit ?? 50);
    return { records: items.slice(offset, offset + limit), next_offset: offset + limit < items.length ? offset + limit : null };
  };
  const matches = (record: Record<string, unknown>, ...keys: string[]) => keys.every(key => parsed[key] === undefined || record[key] === parsed[key]);
  const find = (id: unknown) => invoices.find(record => record.id === id);
  let data: unknown;
  if (operation === "business_get") data = business;
  else if (operation === "clients_list") data = paginate(clients);
  else if (operation === "billables_list") data = paginate(billables.filter(item => matches(item, "client_id", "state")));
  else if (operation === "expenses_list") data = paginate(expenses.filter(item => matches(item, "client_id")));
  else if (operation === "timers_list") data = paginate(timers.filter(item => matches(item, "client_id", "state")).map(withElapsed));
  else if (operation === "invoices_list") data = paginate(invoices.filter(item => matches(item, "status")).map(balance));
  else if (operation === "invoice_get" || operation === "invoice_check") {
    const record = find(parsed.invoice_id);
    if (!record) return { demo: true, ok: false, code: "NOT_FOUND", message: "That invoice is not in the demo account. Call invoices_list for its invoice IDs." };
    data = operation === "invoice_get" ? balance(record) : check(record);
  } else if (operation === "payments_list") data = paginate(payments.filter(item => matches(item, "invoice_id")));
  else if (operation === "records_export") data = { format: "otis-records-v1", kind: parsed.kind, ...paginate(demoRecords[String(parsed.kind)] ?? []) };
  else return { demo: true, ok: false, code: "DEMO_READ_ONLY", message: "The demo account is read-only. Connect the private /mcp endpoint to save your own records." };
  return { demo: true, demo_as_of: DEMO_AS_OF.slice(0, 10), notice: "Demo account: Northstar Studio's records are fictional, and nothing you send is saved.", ok: true, data };
}
