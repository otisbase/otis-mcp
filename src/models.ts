import { z } from "zod";

const text = z.string().trim().min(1).max(2000);
const id = z.string().min(1).max(128);
export const money = z.number().int().min(0).max(1_000_000_000_000);
const requestId = z.string().min(8).max(128).describe("Stable ID for this action; reuse only for identical retries.");
const context = { business_id: id.optional().describe("Omit for your own business; use businesses_list for shared business IDs.") };
const write = { ...context, request_id: requestId };
const page = { limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).default(0) };
const country = z.string().regex(/^[A-Z]{2}$/);
export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const value = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(value.getTime()) && value.toISOString().startsWith(s);
}, "Use a valid calendar date in YYYY-MM-DD format.");
/** A moment with its UTC offset, such as 2026-10-23T09:00:00+03:00. */
const instant = z.iso.datetime({ offset: true });
export const discountSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed"), amount_minor: money }),
  z.object({ kind: z.literal("percent"), rate_ppm: z.number().int().min(0).max(1_000_000) })
]);
export const taxSchema = z.object({
  treatment: z.enum(["taxable", "zero_rated", "exempt", "out_of_scope", "reverse_charge", "not_registered"]),
  jurisdiction: text, reason: text, service_category: text,
  evidence: z.array(text).max(10).default([]),
  mode: z.enum(["exclusive", "inclusive"]).default("exclusive"),
  components: z.array(z.object({
    name: z.string().trim().min(1).max(80),
    rate_ppm: z.number().int().min(1).max(1_000_000).describe("Parts per million: 20% = 200000; 8.875% = 88750."),
    taxable_fraction_ppm: z.number().int().min(1).max(1_000_000).default(1_000_000)
  })).max(5).default([])
});
export const taxProfileSchema = z.object({
  country, region: text.optional(),
  registration_status: z.enum(["registered", "not_registered", "unknown"]),
  registrations: z.array(z.object({ jurisdiction: text, number: text, effective_from: date })).max(20).default([]),
  reviewed_on: date, notes: text
});
export const invoicePreferencesSchema = z.object({
  prefix: z.string().regex(/^[A-Za-z0-9_-]{0,24}$/).default(""),
  number_padding: z.number().int().min(1).max(12).default(1),
  starting_number: z.number().int().min(1).max(999999999).default(1),
  default_note: text.optional(), payment_instructions: text.optional()
});
const billableFields = {
  client_id: id, kind: z.enum(["time", "expense", "ai_usage"]), description: text,
  quantity: z.string().regex(/^\d{1,9}(?:\.\d{1,6})?$/).refine((s) => Number(s) > 0),
  unit: z.string().min(1).max(40), amount_minor: money,
  rate_minor: money.optional(), cost_minor: money.optional(),
  measurement: z.enum(["measured", "estimated"]).optional(), reference: text.optional()
};
export const schemas = {
  otis_menu: z.object({}),
  businesses_list: z.object(page),
  business_get: z.object(context),
  business_set: z.object({ ...write, name: text, currency: z.string().regex(/^[A-Z]{3}$/), billing_address: text.optional(), invoice_preferences: invoicePreferencesSchema.optional() }),
  tax_profile_set: z.object({ ...write, profile: taxProfileSchema }),
  tax_guide: z.object({ country: country.optional() }),
  team_list: z.object({ ...context, ...page }),
  team_invite: z.object({ ...write, email: z.string().trim().toLowerCase().email().max(254), role: z.enum(["editor", "viewer"]) }),
  team_accept: z.object({ ...write, invitation_id: id }),
  team_member_set: z.object({ ...write, member_id: id, role: z.enum(["editor", "viewer", "removed"]) }),
  clients_list: z.object({ ...context, ...page }),
  client_save: z.object({ ...write, client_id: id.optional(), name: text,
    email: z.string().email().max(254).optional(), billing_address: text.optional(),
    country: country.optional(), region: text.optional(), postal_code: text.optional(),
    customer_type: z.enum(["business", "consumer", "unknown"]).default("unknown"),
    tax_ids: z.array(text).max(20).default([]), tax_evidence: text.optional()
  }),
  billable_record: z.object({ ...write, item_id: id.optional(), ...billableFields }),
  billables_list: z.object({ ...context, ...page, client_id: id.optional(), state: z.enum(["unbilled", "reserved", "partial", "invoiced"]).optional() }),
  timer_start: z.object({ ...write, client_id: id, description: text,
    started_at: instant.optional().describe("Only when the user reports an earlier start, such as 'I started at 9'. Omit to use Otis's clock.") }),
  timer_stop: z.object({ ...write, timer_id: id,
    stopped_at: instant.optional().describe("Only when the user reports an earlier stop. Omit to use Otis's clock."),
    rate_minor: money.optional().describe("Hourly rate in minor units. With it, the tracked time is recorded as billable work; call again with it to record an already stopped timer."),
    discard: z.literal(true).optional().describe("Only when the user wants this timer thrown away. Records nothing.") }),
  timers_list: z.object({ ...context, ...page, state: z.enum(["running", "stopped", "recorded", "discarded"]).optional(), client_id: id.optional() }),
  expense_record: z.object({ ...write, expense_id: id.optional(), vendor: text, category: text, description: text, incurred_on: date,
    cost_minor: money, client_id: id.optional(), billable_amount_minor: money.optional(), reference: text.optional() }),
  expenses_list: z.object({ ...context, ...page, client_id: id.optional() }),
  invoice_draft: z.object({ ...write, client_id: id,
    lines: z.array(z.object({ item_id: id, amount_minor: money.refine(n => n > 0), discount: discountSchema.optional(), tax: taxSchema.optional() })).min(1).max(100),
    discount: discountSchema.optional(), supply_date: date, due_date: date, note: text.optional()
  }),
  invoice_get: z.object({ ...context, invoice_id: id }),
  invoice_check: z.object({ ...context, invoice_id: id }),
  invoices_list: z.object({ ...context, ...page, status: z.enum(["draft", "issued", "cancelled"]).optional() }),
  invoice_issue: z.object({ ...write, invoice_id: id,
    expected_total_minor: money, confirmed: z.literal(true).describe("Only after the user approves this draft and its exact total.") }),
  invoice_cancel_draft: z.object({ ...write, invoice_id: id, reason: text }),
  payment_record: z.object({ ...write, invoice_id: id, amount_minor: money.refine(n => n > 0), received_on: date,
    reference: text.describe("Unique business-wide payment reference. Reuse when reporting the same payment.") }),
  payments_list: z.object({ ...context, ...page, invoice_id: id.optional() }),
  records_export: z.object({ ...context, ...page, kind: z.enum(["business", "client", "billable", "expense", "timer", "invoice", "payment", "audit"]) }),
  feedback_send: z.object({ request_id: requestId, kind: z.enum(["feature", "problem", "other"]),
    message: z.string().trim().min(1).max(4000).describe("The exact plain-text message the user approved. Nothing they did not write or approve."),
    client: z.string().trim().min(1).max(120).optional().describe("The assistant sending this, if known, such as Claude Code."),
    reply_ok: z.boolean().default(false).describe("True only if the user agreed to share their verified email so the team can reply.") })
} as const;
export type Operation = keyof typeof schemas;
export const READ_OPERATIONS = new Set<Operation>(["otis_menu", "businesses_list", "business_get", "tax_guide", "team_list", "clients_list", "billables_list", "timers_list", "expenses_list", "invoice_get", "invoice_check", "invoices_list", "payments_list", "records_export"]);
export type TaxProfile = z.infer<typeof taxProfileSchema>;
export type Tax = z.infer<typeof taxSchema>;
export type Discount = z.infer<typeof discountSchema>;
export type Business = { id: "business"; name: string; currency: string; billing_address?: string; invoice_preferences?: z.infer<typeof invoicePreferencesSchema>; tax_profile?: TaxProfile };
export type ClientRecord = { id: string; name: string; email?: string; billing_address?: string; country?: string; region?: string; postal_code?: string; customer_type: "business" | "consumer" | "unknown"; tax_ids: string[]; tax_evidence?: string };
export type Billable = Omit<z.infer<typeof schemas.billable_record>, "request_id" | "business_id" | "item_id"> & {
  id: string; currency: string; expense_id?: string; timer_id?: string; reserved_minor: number; invoiced_minor: number; remaining_minor: number;
  state: "unbilled" | "reserved" | "partial" | "invoiced";
};
export type InvoiceLine = {
  item_id: string; source_snapshot: Billable; amount_minor: number; discount?: Discount; tax?: Tax;
  line_discount_minor: number; invoice_discount_minor: number; net_minor: number; tax_minor: number;
  taxes: { name: string; rate_ppm: number; taxable_fraction_ppm: number; amount_minor: number }[]; total_minor: number;
};
export type Invoice = {
  id: string; client_id: string; status: "draft" | "issued" | "cancelled"; lines: InvoiceLine[];
  currency: string; subtotal_minor: number; discount_minor: number; net_minor: number; tax_minor: number; total_minor: number;
  discount?: Discount; supply_date: string; due_date: string; note?: string; number?: number; display_number?: string; issued_at?: string; cancelled_reason?: string;
  business_snapshot: Business; client_snapshot: ClientRecord;
};
export type Expense = Omit<z.infer<typeof schemas.expense_record>, "request_id" | "business_id" | "expense_id"> & { id: string; currency: string; billable_id?: string };
/** Time tracked from a start to a stop. Times are Otis's clock unless the user reported them (start_reported, stop_reported). */
export type Timer = {
  id: string; client_id: string; description: string; started_by: string; state: "running" | "stopped" | "recorded" | "discarded";
  started_at: string; clock_started_at: string; start_reported: boolean;
  stopped_at?: string; clock_stopped_at?: string; stop_reported?: boolean;
  minutes?: number; hours?: string; billable_id?: string;
};
export type Payment = { id: string; invoice_id: string; amount_minor: number; currency: string; received_on: string; reference: string };
export type Member = { id: string; user_id: string; role: "owner" | "editor" | "viewer"; status: "active" | "invited" | "removed"; invitation_id?: string; expires_at?: number; email?: string };
export type Actor = { userId: string; home: boolean; inviteeId?: string; team?: boolean };
export type Blocker = { field: string; message: string; next_tool: string };
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { [key: string]: JsonValue | undefined };
export type DomainResult = { ok: true; data: JsonValue } | { ok: false; code: string; message: string; details?: JsonValue };
/**
 * Team sharing (invitations, roles, shared businesses) is switched off and kept for a possible Pro plan
 * (Stefan, 2026-10-23). With TEAM_ENABLED other than "true", the MCP offers none of these tools and every
 * business is reachable by its owner only. The membership model stays in place.
 */
export const TEAM_OPERATIONS: ReadonlySet<Operation> = new Set<Operation>(["team_list", "team_invite", "team_accept", "team_member_set"]);
export const teamEnabled = (env: { TEAM_ENABLED?: string }) => env.TEAM_ENABLED === "true";
/** The tools the MCP offers: every operation, without the team tools while teams are off. */
export function offeredOperations(team: boolean): Operation[] {
  return (Object.keys(schemas) as Operation[]).filter(operation => team || !TEAM_OPERATIONS.has(operation));
}
/** Fair-use limits per business (Stefan, 2026-10-21), enforced by BusinessStore and published on /pricing. Daily limits reset at 00:00 UTC. */
export const FAIR_USE = { requests_per_day: 10_000, new_records_per_day: 1_000, records_total: 100_000 } as const;
/** Feedback messages per person per UTC day; separate from the business fair-use counters. */
export const FEEDBACK_PER_DAY = 20;
export class DomainError extends Error { constructor(public readonly code: string, message: string, public readonly details?: unknown) { super(message); } }
export function fail(code: string, message: string, details?: unknown): never { throw new DomainError(code, message, details); }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().filter(key => object[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
