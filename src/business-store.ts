import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { schemas, READ_OPERATIONS, FAIR_USE, canonical, DomainError, fail,
  type Operation, type Business, type ClientRecord, type Billable, type DomainResult, type Invoice, type Payment, type Actor, type Member, type Expense, type Timer } from "./models";
import { calculate, round, taxBlockers } from "./billing";

export class BusinessStore extends DurableObject<Env> {
  // Business records created by the current operation; the audit trail is not counted.
  private created = 0;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS records (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
        CREATE INDEX IF NOT EXISTS records_by_kind ON records(kind, sequence);
        CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, operation TEXT NOT NULL, input TEXT NOT NULL, result TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
        INSERT OR IGNORE INTO counters(name, value) VALUES ('invoice', 0);
        CREATE TABLE IF NOT EXISTS payment_references (reference TEXT PRIMARY KEY, payment_id TEXT NOT NULL);
        INSERT OR IGNORE INTO counters(name, value) SELECT 'records', count(*) FROM records WHERE kind <> 'audit';
      `);
    });
  }
  private get<T>(kind: string, id: string): T {
    const row = this.ctx.storage.sql.exec<{ data: string }>("SELECT data FROM records WHERE kind = ? AND id = ?", kind, id).toArray()[0];
    if (!row) fail("NOT_FOUND", `${kind} record was not found in this business.`);
    return JSON.parse(row.data) as T;
  }
  private optional<T>(kind: string, id: string): T | null {
    try { return this.get<T>(kind, id); } catch (e) { if (e instanceof DomainError && e.code === "NOT_FOUND") return null; throw e; }
  }
  private put(kind: string, record: { id: string }): void {
    if (kind !== "audit" && !this.ctx.storage.sql.exec("SELECT 1 FROM records WHERE id = ?", record.id).toArray().length) this.created++;
    this.ctx.storage.sql.exec("INSERT INTO records(id, kind, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data", record.id, kind, JSON.stringify(record));
  }
  private list(kind: string, limit: number, offset: number, filters: Record<string, unknown> = {}) {
    let query = "SELECT data FROM records WHERE kind = ?";
    const bindings: (string | number)[] = [kind];
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined) { query += " AND json_extract(data, ?) = ?"; bindings.push(`$.${key}`, String(value)); }
    }
    const rows = this.ctx.storage.sql.exec<{ data: string }>(query + " ORDER BY sequence LIMIT ? OFFSET ?", ...bindings, limit + 1, offset).toArray();
    return { records: rows.slice(0, limit).map(row => JSON.parse(row.data)), next_offset: rows.length > limit ? offset + limit : null };
  }
  // Discovery index is only a hint. Every read and write checks this authoritative membership.
  membership(userId: string) {
    const member = this.optional<Member>("member", `member:${userId}`);
    if (!member || member.status === "removed" || (member.status === "invited" && (member.expires_at ?? 0) <= Date.now())) return null;
    return { ...member, business_name: this.optional<Business>("business", "business")?.name };
  }
  private authorize(operation: Operation, actor: Actor) {
    if (!actor?.userId) fail("FORBIDDEN", "An authenticated identity is required.");
    const business = this.optional<Business>("business", "business");
    const member = this.membership(actor.userId);
    if (!business && actor.home && ["business_get", "business_set"].includes(operation)) return;
    if (operation === "team_accept" && member && ["invited", "active"].includes(member.status)) return;
    if (!member || member.status !== "active") fail("FORBIDDEN", "You do not have access to this business. Ask its owner for an invitation.");
    if (["team_invite", "team_member_set", "business_set", "tax_profile_set"].includes(operation) && member.role !== "owner") fail("FORBIDDEN", "Only the business owner can change this setting.");
    if (!READ_OPERATIONS.has(operation) && member.role === "viewer") fail("FORBIDDEN", "Viewers cannot change business records.");
  }
  private counter(name: string): number {
    return this.ctx.storage.sql.exec<{ value: number }>("SELECT value FROM counters WHERE name = ?", name).toArray()[0]?.value ?? 0;
  }
  private bump(name: string, by: number): void {
    this.ctx.storage.sql.exec("INSERT INTO counters(name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = value + excluded.value", name, by);
  }
  // Daily fair-use counters are keyed by UTC date; earlier days are discarded as the day changes.
  private usageDay() {
    const now = new Date(), day = now.toISOString().slice(0, 10);
    const resets = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
    this.ctx.storage.sql.exec("DELETE FROM counters WHERE name GLOB '*:*' AND name NOT GLOB ?", `*:${day}`);
    return { requests: `requests:${day}`, created: `created:${day}`, resets_at: resets };
  }
  private limitReached(limit: keyof typeof FAIR_USE, used: number, resets_at: string | null, message: string): never {
    fail("FAIR_USE_LIMIT", message, { limit, allowed: FAIR_USE[limit], used, resets_at });
  }
  private meterRequest() {
    const day = this.usageDay(), used = this.counter(day.requests);
    if (used >= FAIR_USE.requests_per_day) this.limitReached("requests_per_day", used, day.resets_at, `This business has reached its fair-use limit of ${FAIR_USE.requests_per_day.toLocaleString("en-US")} requests today. Otis accepts requests again after 00:00 UTC.`);
    this.bump(day.requests, 1);
  }
  // Runs inside the operation's transaction, so a refusal also discards the records it would have created.
  private meterCreated(created: number) {
    const day = this.usageDay(), total = this.counter("records"), today = this.counter(day.created);
    if (total + created > FAIR_USE.records_total) this.limitReached("records_total", total, null, `This business has reached its fair-use limit of ${FAIR_USE.records_total.toLocaleString("en-US")} stored records. Reads and edits still work; new records cannot be saved.`);
    if (today + created > FAIR_USE.new_records_per_day) this.limitReached("new_records_per_day", today, day.resets_at, `This business has reached its fair-use limit of ${FAIR_USE.new_records_per_day.toLocaleString("en-US")} new records today. Reads and edits still work; new records can be saved again after 00:00 UTC.`);
    this.bump("records", created); this.bump(day.created, created);
  }
  execute(operation: Operation, input: unknown, actor: Actor): string {
    return JSON.stringify(this.executeResult(operation, input, actor));
  }
  private executeResult(operation: Operation, input: unknown, actor: Actor): DomainResult {
    if (!Object.hasOwn(schemas, operation)) return { ok: false, code: "UNKNOWN_OPERATION", message: "Unknown operation." };
    try {
      const parsed = schemas[operation].parse(input);
      // Every request from someone with access counts toward the daily limit, whether or not it succeeds.
      this.authorize(operation, actor);
      this.meterRequest();
      return this.ctx.storage.transactionSync(() => {
        const write = !READ_OPERATIONS.has(operation);
        const requestId = "request_id" in parsed ? String(parsed.request_id) : "";
        const key = `${actor.userId}:${requestId}`;
        const serialized = canonical(parsed);
        if (write) {
          const previous = this.ctx.storage.sql.exec<{ operation: string; input: string; result: string }>("SELECT operation, input, result FROM requests WHERE id = ?", key).toArray()[0];
          if (previous) {
            if (previous.operation !== operation || previous.input !== serialized) fail("IDEMPOTENCY_CONFLICT", "This request_id was used for a different action. Use a new ID.");
            return { ok: true, data: JSON.parse(previous.result) };
          }
        }
        this.created = 0;
        const data = this.dispatch(operation, parsed, actor);
        if (this.created) this.meterCreated(this.created);
        if (write) {
          this.put("audit", { id: crypto.randomUUID(), ...{ actor_id: actor.userId, operation, request_id: requestId, occurred_at: new Date().toISOString(), input: parsed, result: data } });
          this.ctx.storage.sql.exec("INSERT INTO requests(id, operation, input, result) VALUES (?, ?, ?, ?)", key, operation, serialized, JSON.stringify(data));
        }
        return { ok: true, data: JSON.parse(JSON.stringify(data)) };
      });
    } catch (e) {
      if (e instanceof DomainError) return { ok: false, code: e.code, message: e.message, ...(e.details ? { details: JSON.parse(JSON.stringify(e.details)) } : {}) };
      if (e instanceof z.ZodError) return { ok: false, code: "INVALID_INPUT", message: z.prettifyError(e) };
      throw e;
    }
  }
  private saveBillable(details: Omit<Billable, "id" | "currency" | "state" | "reserved_minor" | "invoiced_minor" | "remaining_minor" | "request_id">, existingId?: string) {
    const business = this.get<Business>("business", "business");
    if (existingId) {
      const existing = this.get<Billable>("billable", existingId);
      if (existing.reserved_minor > 0 || existing.invoiced_minor > 0) fail("ITEM_LOCKED", "Reserved or invoiced work cannot be edited. Cancel any drafts first; issued source facts remain immutable.");
    }
    this.get<ClientRecord>("client", details.client_id);
    if (details.kind === "ai_usage" && !details.measurement) fail("MEASUREMENT_REQUIRED", "AI usage must be labelled measured or estimated.");
    if (details.rate_minor !== undefined) {
      const [whole, fraction = ""] = details.quantity.split(".");
      if (round(BigInt(whole + fraction) * BigInt(details.rate_minor), 10n ** BigInt(fraction.length)) !== details.amount_minor) fail("AMOUNT_MISMATCH", "amount_minor must match quantity × rate_minor, rounded half up.");
    }
    const item = { id: existingId ?? crypto.randomUUID(), ...details, currency: business.currency, state: "unbilled" as const, reserved_minor: 0, invoiced_minor: 0, remaining_minor: details.amount_minor };
    this.put("billable", item);
    return item;
  }
  private allocation(item: Billable, reserved: number, invoiced: number) {
    item.reserved_minor += reserved; item.invoiced_minor += invoiced;
    item.remaining_minor = item.amount_minor - item.reserved_minor - item.invoiced_minor;
    if (Math.min(item.reserved_minor, item.invoiced_minor, item.remaining_minor) < 0) fail("ALLOCATION_CONFLICT", "This allocation exceeds the item's remaining amount. Reload billables_list and reduce the allocation.");
    item.state = item.invoiced_minor === item.amount_minor ? "invoiced" : item.invoiced_minor > 0 ? "partial" : item.reserved_minor > 0 ? "reserved" : "unbilled";
    this.put("billable", item);
  }
  private balance(invoice: Invoice) {
    const paid = this.ctx.storage.sql.exec<{ paid: number }>("SELECT COALESCE(SUM(json_extract(data, '$.amount_minor')), 0) AS paid FROM records WHERE kind = 'payment' AND json_extract(data, '$.invoice_id') = ?", invoice.id).one().paid;
    return { ...invoice, paid_minor: paid, balance_minor: invoice.status === "cancelled" ? 0 : invoice.total_minor - paid };
  }
  private check(invoice: Invoice) {
    const business = this.get<Business>("business", "business");
    const client = this.get<ClientRecord>("client", invoice.client_id);
    const blockers = taxBlockers(invoice, business, client);
    if (invoice.status !== "draft") blockers.push({ field: "status", message: "Only drafts can be issued.", next_tool: "invoice_get" });
    if (canonical(business) !== canonical(invoice.business_snapshot) || canonical(client) !== canonical(invoice.client_snapshot)) blockers.push({ field: "snapshot", message: "Business or client details changed. Cancel and recreate the draft to review the current facts.", next_tool: "invoice_cancel_draft" });
    return { ready: blockers.length === 0, blockers, total_minor: invoice.total_minor, currency: invoice.currency,
      notice: "Readiness validates recorded facts and arithmetic. It does not certify the legal tax treatment. Ask the user to approve the exact draft before issuing." };
  }
  private dispatch(operation: Operation, input: unknown, actor: Actor): unknown {
    switch (operation) {
      case "business_get": return this.optional<Business>("business", "business") ?? { setup_required: true, message: "Ask for the business name and currency, then call business_set. Tax setup is needed before issuing invoices." };
      case "business_set": {
        const { request_id, business_id, ...profile } = schemas.business_set.parse(input);
        if (!(Intl.supportedValuesOf("currency") as string[]).includes(profile.currency)) fail("INVALID_CURRENCY", "Use a supported ISO 4217 currency code.");
        const old = this.optional<Business>("business", "business");
        if (old && old.currency !== profile.currency && this.ctx.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM records WHERE kind IN ('billable','expense','invoice')").one().count > 0) fail("CURRENCY_LOCKED", "The currency cannot change after financial records exist.");
        if (profile.invoice_preferences && profile.invoice_preferences.starting_number !== (old?.invoice_preferences?.starting_number ?? 1)) {
          const issued = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM records WHERE kind = 'invoice' AND json_extract(data, '$.status') = 'issued'").one().count;
          if (issued) fail("NUMBERING_LOCKED", "The starting number cannot change after issuance. Existing invoice numbers are never reused.");
          this.ctx.storage.sql.exec("UPDATE counters SET value = ? WHERE name = 'invoice'", profile.invoice_preferences.starting_number - 1);
        }
        const business: Business = { id: "business", ...profile, invoice_preferences: profile.invoice_preferences ?? old?.invoice_preferences, ...(old?.tax_profile ? { tax_profile: old.tax_profile } : {}) };
        this.put("business", business);
        if (!old) this.put("member", { id: `member:${actor.userId}`, ...{ user_id: actor.userId, role: "owner", status: "active" } });
        return business;
      }
      case "tax_profile_set": {
        const { profile } = schemas.tax_profile_set.parse(input);
        const business = this.get<Business>("business", "business");
        business.tax_profile = profile; this.put("business", business); return business;
      }
      case "team_list": { const p = schemas.team_list.parse(input); return this.list("member", p.limit, p.offset); }
      case "team_invite": {
        const p = schemas.team_invite.parse(input);
        if (!actor.inviteeId) fail("INVALID_IDENTITY", "Invitation recipient must be resolved by the server.");
        const old = this.optional<Member>("member", `member:${actor.inviteeId}`);
        if (old?.status === "active") fail("ALREADY_MEMBER", "This person is already a member. Use team_member_set to change their role.");
        const member: Member = { id: `member:${actor.inviteeId}`, user_id: actor.inviteeId, email: p.email, role: p.role, status: "invited", invitation_id: crypto.randomUUID(), expires_at: Date.now() + 7 * 86400000 };
        this.put("member", member); return member;
      }
      case "team_accept": {
        const p = schemas.team_accept.parse(input);
        const member = this.get<Member>("member", `member:${actor.userId}`);
        if (member.invitation_id !== p.invitation_id || member.status !== "invited" || (member.expires_at ?? 0) <= Date.now()) fail("INVITATION_INVALID", "This invitation is invalid or expired. Ask the owner to invite your verified email again.");
        member.status = "active"; delete member.expires_at; delete member.invitation_id; this.put("member", member); return member;
      }
      case "team_member_set": {
        const p = schemas.team_member_set.parse(input);
        const member = this.get<Member>("member", p.member_id);
        if (member.role === "owner") fail("OWNER_REQUIRED", "The owner cannot be removed or downgraded. Ownership transfer is not available.");
        if (p.role === "removed") member.status = "removed";
        else { if (member.status === "removed") fail("INVITATION_REQUIRED", "Send a new invitation before restoring access."); member.role = p.role; }
        this.put("member", member); return member;
      }
      case "clients_list": { const p = schemas.clients_list.parse(input); return this.list("client", p.limit, p.offset); }
      case "client_save": {
        this.get<Business>("business", "business");
        const { request_id, business_id, client_id, ...details } = schemas.client_save.parse(input);
        if (client_id) this.get<ClientRecord>("client", client_id);
        const client = { id: client_id ?? crypto.randomUUID(), ...details }; this.put("client", client); return client;
      }
      case "billable_record": {
        const { request_id, business_id, item_id, ...details } = schemas.billable_record.parse(input);
        const existing = item_id ? this.get<Billable>("billable", item_id) : null;
        if (existing?.expense_id) fail("LINKED_EXPENSE", "Edit this item through expense_record with its expense_id so expense cost and billable price stay consistent.");
        // Work recorded from a timer keeps its link when corrected.
        return this.saveBillable({ ...details, ...(existing?.timer_id ? { timer_id: existing.timer_id } : {}) }, item_id);
      }
      case "timer_start": {
        const p = schemas.timer_start.parse(input);
        this.get<Business>("business", "business");
        this.get<ClientRecord>("client", p.client_id);
        const now = Date.now(), started = p.started_at ? reportedTime(p.started_at, now) : now;
        const timer: Timer = { id: crypto.randomUUID(), client_id: p.client_id, description: p.description, started_by: `member:${actor.userId}`, state: "running",
          started_at: new Date(started).toISOString(), clock_started_at: new Date(now).toISOString(), start_reported: !!p.started_at };
        this.put("timer", timer);
        return withElapsed(timer, now);
      }
      case "timer_stop": {
        const p = schemas.timer_stop.parse(input);
        const timer = this.get<Timer>("timer", p.timer_id);
        if (timer.started_by !== `member:${actor.userId}` && this.membership(actor.userId)?.role !== "owner") fail("FORBIDDEN", "Only the person who started this timer, or the business owner, can stop it.");
        if (timer.state === "recorded" || timer.state === "discarded") fail("TIMER_CLOSED", `This timer is already ${timer.state}.`, { billable_id: timer.billable_id ?? null });
        if (p.discard) {
          timer.state = "discarded"; this.put("timer", timer);
          return { timer, recorded: false };
        }
        if (timer.state === "running") {
          const now = Date.now(), stopped = p.stopped_at ? reportedTime(p.stopped_at, now) : now;
          if (stopped < Date.parse(timer.started_at)) fail("STOP_BEFORE_START", "The stop time is before the timer started. Check the reported time.");
          // Exact to the minute: the tracked time rounds to the nearest whole minute, stored as hours to six decimals.
          const minutes = Math.round((stopped - Date.parse(timer.started_at)) / 60_000);
          Object.assign(timer, { state: "stopped", stopped_at: new Date(stopped).toISOString(), clock_stopped_at: new Date(now).toISOString(),
            stop_reported: !!p.stopped_at, minutes, hours: hoursText(minutes) });
        }
        const warning = timer.minutes! > 12 * 60 ? "This timer ran for more than 12 hours. Confirm the time with the user before invoicing it." : undefined;
        if (p.rate_minor === undefined || timer.minutes === 0) {
          this.put("timer", timer);
          return { timer, recorded: false, ...(timer.minutes === 0 ? { message: "Less than a minute was tracked, so there is nothing to record." } : { message: "Stopped. Pass rate_minor to record this time as billable work." }), ...(warning ? { warning } : {}) };
        }
        const microHours = round(BigInt(timer.minutes!) * 1_000_000n, 60n);
        const billable = this.saveBillable({ client_id: timer.client_id, kind: "time", description: timer.description, quantity: timer.hours!, unit: "hours",
          rate_minor: p.rate_minor, amount_minor: round(BigInt(microHours) * BigInt(p.rate_minor), 1_000_000n), timer_id: timer.id });
        timer.state = "recorded"; timer.billable_id = billable.id; this.put("timer", timer);
        return { timer, recorded: true, billable, ...(warning ? { warning } : {}) };
      }
      case "timers_list": {
        const p = schemas.timers_list.parse(input), now = Date.now();
        const page = this.list("timer", p.limit, p.offset, { state: p.state, client_id: p.client_id });
        return { ...page, records: (page.records as Timer[]).map(timer => withElapsed(timer, now)) };
      }
      case "billables_list": { const { limit, offset, client_id, state } = schemas.billables_list.parse(input); return this.list("billable", limit, offset, { client_id, state }); }
      case "expense_record": {
        const { request_id, business_id, expense_id, ...p } = schemas.expense_record.parse(input);
        const business = this.get<Business>("business", "business");
        const old = expense_id ? this.get<Expense>("expense", expense_id) : null;
        if (p.client_id) this.get<ClientRecord>("client", p.client_id);
        if (p.billable_amount_minor !== undefined && !p.client_id) fail("CLIENT_REQUIRED", "A billable expense requires a client.");
        if (old?.billable_id && p.billable_amount_minor === undefined) fail("BILLABLE_AMOUNT_REQUIRED", "This expense has a linked billable. Include its billable amount, or zero to stop billing an unreserved item.");
        const id = expense_id ?? crypto.randomUUID();
        const billable = p.billable_amount_minor === undefined ? undefined : this.saveBillable({ client_id: p.client_id!, kind: "expense", description: p.description, amount_minor: p.billable_amount_minor, cost_minor: p.cost_minor, quantity: "1", unit: "expense", reference: p.reference, expense_id: id }, old?.billable_id);
        const expense: Expense = { id, ...p, currency: business.currency, billable_id: billable?.id };
        this.put("expense", expense); return expense;
      }
      case "expenses_list": { const p = schemas.expenses_list.parse(input); return this.list("expense", p.limit, p.offset, { client_id: p.client_id }); }
      case "invoice_draft": {
        const p = schemas.invoice_draft.parse(input);
        const business = this.get<Business>("business", "business");
        const client = this.get<ClientRecord>("client", p.client_id);
        if (new Set(p.lines.map(l => l.item_id)).size !== p.lines.length) fail("DUPLICATE_ITEM", "Combine allocations of the same item into one line.");
        const lines = p.lines.map(line => {
          const item = this.get<Billable>("billable", line.item_id);
          if (item.client_id !== p.client_id) fail("CLIENT_MISMATCH", "All invoice lines must belong to the selected client.");
          const snapshot = structuredClone(item);
          this.allocation(item, line.amount_minor, 0);
          return { ...line, source_snapshot: snapshot };
        });
        const invoice: Invoice = { id: crypto.randomUUID(), client_id: p.client_id, status: "draft", currency: business.currency,
          ...calculate(lines, p.discount), discount: p.discount, supply_date: p.supply_date, due_date: p.due_date, note: p.note ?? business.invoice_preferences?.default_note,
          business_snapshot: business, client_snapshot: client };
        this.put("invoice", invoice); return { ...this.balance(invoice), readiness: this.check(invoice) };
      }
      case "invoice_get": return this.balance(this.get<Invoice>("invoice", schemas.invoice_get.parse(input).invoice_id));
      case "invoice_check": return this.check(this.get<Invoice>("invoice", schemas.invoice_check.parse(input).invoice_id));
      case "invoices_list": {
        const p = schemas.invoices_list.parse(input); const list = this.list("invoice", p.limit, p.offset, { status: p.status });
        return { ...list, records: list.records.map(i => this.balance(i)) };
      }
      case "invoice_issue": {
        const p = schemas.invoice_issue.parse(input); const invoice = this.get<Invoice>("invoice", p.invoice_id);
        const readiness = this.check(invoice);
        if (!readiness.ready) fail("INVOICE_NOT_READY", "Resolve the missing facts before issuing this invoice.", readiness);
        if (p.expected_total_minor !== invoice.total_minor) fail("TOTAL_CHANGED", "Read the invoice and ask the user to approve its exact recorded total.");
        for (const line of invoice.lines) this.allocation(this.get<Billable>("billable", line.item_id), -line.amount_minor, line.amount_minor);
        invoice.number = this.ctx.storage.sql.exec<{ value: number }>("UPDATE counters SET value = value + 1 WHERE name = 'invoice' RETURNING value").one().value;
        const preferences = invoice.business_snapshot.invoice_preferences;
        invoice.display_number = `${preferences?.prefix ?? ""}${String(invoice.number).padStart(preferences?.number_padding ?? 1, "0")}`;
        invoice.status = "issued"; invoice.issued_at = new Date().toISOString(); this.put("invoice", invoice); return this.balance(invoice);
      }
      case "invoice_cancel_draft": {
        const p = schemas.invoice_cancel_draft.parse(input); const invoice = this.get<Invoice>("invoice", p.invoice_id);
        if (invoice.status !== "draft") fail("DRAFT_REQUIRED", "Only unissued drafts can be cancelled. Issued invoices remain immutable; correction support is not yet available.");
        for (const line of invoice.lines) this.allocation(this.get<Billable>("billable", line.item_id), -line.amount_minor, 0);
        invoice.status = "cancelled"; invoice.cancelled_reason = p.reason; this.put("invoice", invoice); return this.balance(invoice);
      }
      case "payment_record": {
        const { request_id, business_id, ...p } = schemas.payment_record.parse(input);
        const old = this.ctx.storage.sql.exec<{ payment_id: string }>("SELECT payment_id FROM payment_references WHERE reference = ?", p.reference).toArray()[0];
        if (old) {
          const payment = this.get<Payment>("payment", old.payment_id);
          if (payment.invoice_id !== p.invoice_id || payment.amount_minor !== p.amount_minor || payment.received_on !== p.received_on) fail("PAYMENT_REFERENCE_CONFLICT", "This payment reference already describes a different payment.");
          return payment;
        }
        const invoice = this.get<Invoice>("invoice", p.invoice_id);
        if (invoice.status !== "issued") fail("ISSUED_REQUIRED", "Payments can only be recorded against issued invoices.");
        if (p.amount_minor > this.balance(invoice).balance_minor) fail("OVERPAYMENT", "This payment exceeds the outstanding balance. Unapplied credits are not supported.");
        const payment: Payment = { id: crypto.randomUUID(), ...p, currency: invoice.currency };
        this.put("payment", payment); this.ctx.storage.sql.exec("INSERT INTO payment_references(reference, payment_id) VALUES (?, ?)", p.reference, payment.id); return payment;
      }
      case "payments_list": { const p = schemas.payments_list.parse(input); return this.list("payment", p.limit, p.offset, { invoice_id: p.invoice_id }); }
      case "records_export": { const p = schemas.records_export.parse(input); return { format: "otis-records-v1", kind: p.kind, ...this.list(p.kind, p.limit, p.offset) }; }
      default: fail("NOT_AVAILABLE", "This operation is handled by the MCP service.");
    }
  }
}

/** A time the user reported: not in the future (one minute of clock skew allowed) and no more than 7 days ago. */
function reportedTime(value: string, now: number): number {
  const time = Date.parse(value);
  if (time > now + 60_000) fail("TIME_IN_FUTURE", "A reported time cannot be in the future.");
  if (time < now - 7 * 86_400_000) fail("TIME_TOO_OLD", "A reported time must be within the last 7 days. Record older work with billable_record.");
  return time;
}
/** Whole minutes as hours to six decimals, without trailing zeros: 90 → "1.5", 83 → "1.383333". */
function hoursText(minutes: number): string {
  const micro = String(round(BigInt(minutes) * 1_000_000n, 60n)).padStart(7, "0");
  const whole = micro.slice(0, -6), fraction = micro.slice(-6).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}
/** A running timer also reports how long it has been running. */
function withElapsed(timer: Timer, now: number): Timer & { elapsed_minutes?: number } {
  return timer.state === "running" ? { ...timer, elapsed_minutes: Math.max(0, Math.round((now - Date.parse(timer.started_at)) / 60_000)) } : timer;
}
