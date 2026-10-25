import { DurableObject } from "cloudflare:workers";
import { eu } from "./regions";

/**
 * The one registry of people for the admin tools (roadmap/admin.md): sign-ups, active days, funnel milestones,
 * connected assistants, suspension, the access log and deletion tombstones. It is written only on rare events and
 * after the response (sign-in, a person's first call of the day, a new milestone), never on every request.
 * It is never an authorization source for business records; BusinessStore checks access.
 */
export const MILESTONES = ["first_call", "business", "client", "work", "draft", "issued", "payment"] as const;
export type Milestone = typeof MILESTONES[number];
export type Status = "active" | "suspended";
export type Connection = { client_id: string; client_name: string; first_at: string; last_at: string };
export type Person = {
  user_id: string; email: string | null; business_id: string | null; signed_up_at: string; first_seen: number;
  last_active_on: string | null; internal: number; status: Status; status_by: string | null; status_reason: string | null;
  status_at: string | null; milestones: Record<Milestone, string | null>; connections: Connection[]; deleted_at: string | null;
};
export type LogEntry = { admin: string; tool: string; targetUserId?: string; targetEmail?: string; reason?: string; outcome: string; at: string };
export type Range = { from: string; to: string; includeInternal: boolean };
export type Stats = ReturnType<RegistryStore["stats"]>;

export const registry = (env: Env) => eu(env.REGISTRY).getByName("registry");

type PersonRow = Omit<Person, "milestones" | "connections"> & Record<`m_${Milestone}`, string | null>;
const DAY = 86_400_000;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const round2 = (n: number) => Math.round(n * 100) / 100;
/** ISO 8601 week, as "2026-W36". */
function isoWeek(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const thursday = new Date(d.getTime() + (3 - (d.getUTCDay() + 6) % 7) * DAY);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  return `${thursday.getUTCFullYear()}-W${String(Math.floor((thursday.getTime() - yearStart) / DAY / 7) + 1).padStart(2, "0")}`;
}
/** Monday of the ISO week that contains day. */
const weekStart = (day: string) => addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));

export class RegistryStore extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS people (user_id TEXT PRIMARY KEY, email TEXT, business_id TEXT, signed_up_at TEXT NOT NULL,
        first_seen INTEGER NOT NULL, last_active_on TEXT, internal INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
        status_by TEXT, status_reason TEXT, status_at TEXT, deleted_at TEXT,
        ${MILESTONES.map(m => `m_${m} TEXT`).join(", ")});
      CREATE INDEX IF NOT EXISTS people_by_email ON people(email);
      CREATE TABLE IF NOT EXISTS connections (user_id TEXT NOT NULL, client_id TEXT NOT NULL, client_name TEXT NOT NULL,
        first_at TEXT NOT NULL, last_at TEXT NOT NULL, PRIMARY KEY(user_id, client_id));
      CREATE TABLE IF NOT EXISTS active_days (user_id TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY(user_id, day));
      CREATE INDEX IF NOT EXISTS active_days_by_day ON active_days(day);
      CREATE TABLE IF NOT EXISTS sign_in_days (day TEXT PRIMARY KEY, requested INTEGER NOT NULL DEFAULT 0, accepted INTEGER NOT NULL DEFAULT 0,
        wrong INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS access_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, admin TEXT NOT NULL, tool TEXT NOT NULL,
        target_user_id TEXT, target_email TEXT, reason TEXT, outcome TEXT NOT NULL);
    `);
  }
  private sql<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): T[] {
    return this.ctx.storage.sql.exec<T>(query, ...bindings).toArray();
  }
  private upsert(p: { userId: string; email?: string; businessId: string; internal: boolean; at: string }, firstSeen: number): void {
    this.sql(`INSERT INTO people(user_id, email, business_id, signed_up_at, first_seen, internal) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET email = coalesce(excluded.email, email), business_id = excluded.business_id,
        internal = CASE WHEN excluded.email IS NULL THEN internal ELSE excluded.internal END`,
      p.userId, p.email ?? null, p.businessId, p.at, firstSeen, p.internal ? 1 : 0);
  }

  signInStep(day: string, step: "requested" | "accepted" | "wrong" | "completed"): void {
    this.sql(`INSERT INTO sign_in_days(day, ${step}) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET ${step} = ${step} + 1`, day);
  }
  /** Returns whether this is a person the registry has never seen, and how many external people are signed up now. */
  signedIn(p: { userId: string; email: string; businessId: string; clientId: string; clientName: string; internal: boolean; at: string }): { isNew: boolean; people: number } {
    const isNew = this.sql("SELECT 1 FROM people WHERE user_id = ?", p.userId).length === 0;
    this.upsert(p, 0);
    this.sql(`INSERT INTO connections(user_id, client_id, client_name, first_at, last_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, client_id) DO UPDATE SET client_name = excluded.client_name, last_at = excluded.last_at`, p.userId, p.clientId, p.clientName, p.at, p.at);
    return { isNew, people: this.sql<{ n: number }>("SELECT count(*) AS n FROM people WHERE internal = 0 AND deleted_at IS NULL")[0].n };
  }
  activity(p: { userId: string; email?: string; businessId: string; day: string; milestones: Milestone[]; internal: boolean; at: string }): void {
    this.upsert(p, 1);
    this.sql("INSERT OR IGNORE INTO active_days(user_id, day) VALUES (?, ?)", p.userId, p.day);
    this.sql("UPDATE people SET last_active_on = max(coalesce(last_active_on, ''), ?) WHERE user_id = ?", p.day, p.userId);
    for (const m of p.milestones.filter(m => MILESTONES.includes(m))) this.sql(`UPDATE people SET m_${m} = coalesce(m_${m}, ?) WHERE user_id = ?`, p.at, p.userId);
  }

  private hydrate(row: PersonRow): Person {
    const { m_first_call, m_business, m_client, m_work, m_draft, m_issued, m_payment, ...rest } = row;
    return { ...rest, milestones: { first_call: m_first_call, business: m_business, client: m_client, work: m_work, draft: m_draft, issued: m_issued, payment: m_payment },
      connections: this.sql<Connection>("SELECT client_id, client_name, first_at, last_at FROM connections WHERE user_id = ? ORDER BY first_at", row.user_id) };
  }
  person(userId: string): Person | null {
    const row = this.sql<PersonRow>("SELECT * FROM people WHERE user_id = ? AND deleted_at IS NULL", userId)[0];
    return row ? this.hydrate(row) : null;
  }
  personByEmail(email: string): Person | null {
    const row = this.sql<PersonRow>("SELECT * FROM people WHERE email = ? AND deleted_at IS NULL", email.trim().toLowerCase())[0];
    return row ? this.hydrate(row) : null;
  }
  /** Live people, newest sign-up first. Active and dormant are measured against today: 14 days without a call is dormant. */
  people(p: { filter?: "active" | "dormant" | "internal" | "suspended"; limit: number; offset: number }): { records: Person[]; next_offset: number | null } {
    const cutoff = addDays(new Date().toISOString().slice(0, 10), -14);
    const where = { active: "last_active_on >= ?", dormant: "coalesce(last_active_on, '') < ?", internal: "internal = 1", suspended: "status = 'suspended'" };
    const filter = p.filter ? ` AND ${where[p.filter]}` : "";
    const bindings = p.filter === "active" || p.filter === "dormant" ? [cutoff] : [];
    const rows = this.sql<PersonRow>(`SELECT * FROM people WHERE deleted_at IS NULL${filter} ORDER BY signed_up_at DESC, user_id LIMIT ? OFFSET ?`, ...bindings, p.limit + 1, p.offset);
    return { records: rows.slice(0, p.limit).map(row => this.hydrate(row)), next_offset: rows.length > p.limit ? p.offset + p.limit : null };
  }
  /** Inserts the person as first seen when the registry has never seen them, so a suspension always has a row. */
  setStatus(userId: string, status: Status, by: string, reason: string, at: string, email?: string, businessId?: string): void {
    this.sql("INSERT OR IGNORE INTO people(user_id, email, business_id, signed_up_at, first_seen) VALUES (?, ?, ?, ?, 1)", userId, email ?? null, businessId ?? null, at);
    this.sql("UPDATE people SET status = ?, status_by = ?, status_reason = ?, status_at = ? WHERE user_id = ?", status, by, reason, at, userId);
  }

  log(entry: LogEntry): void {
    this.sql("INSERT INTO access_log(at, admin, tool, target_user_id, target_email, reason, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)",
      entry.at, entry.admin, entry.tool, entry.targetUserId ?? null, entry.targetEmail ?? null, entry.reason ?? null, entry.outcome);
  }
  accessLog(limit: number, offset: number) {
    const rows = this.sql<Record<string, SqlStorageValue>>("SELECT * FROM access_log ORDER BY id DESC LIMIT ? OFFSET ?", limit + 1, offset);
    return { records: rows.slice(0, limit), next_offset: rows.length > limit ? offset + limit : null };
  }

  /** Deletion: the person becomes an anonymous tombstone that keeps sign-up time, milestones and active days for the totals. */
  tombstone(userId: string, at: string): void {
    this.ctx.storage.transactionSync(() => {
      const id = `deleted:${crypto.randomUUID()}`;
      this.sql("UPDATE people SET user_id = ?, email = NULL, business_id = NULL, status = 'active', status_by = NULL, status_reason = NULL, status_at = NULL, deleted_at = ? WHERE user_id = ?", id, at, userId);
      this.sql("UPDATE active_days SET user_id = ? WHERE user_id = ?", id, userId);
      this.sql("DELETE FROM connections WHERE user_id = ?", userId);
      this.sql("UPDATE access_log SET target_email = NULL WHERE target_user_id = ?", userId);
    });
  }

  /**
   * Aggregate numbers for a date range (inclusive UTC days). Active users are measured at the range's last day:
   * daily = that day, weekly = its last 7 days, monthly = its last 30 days. Numbers only, never emails.
   */
  stats(r: Range) {
    const internal = r.includeInternal ? "" : " AND p.internal = 0";
    const people = this.sql<PersonRow>(`SELECT * FROM people p WHERE substr(p.signed_up_at, 1, 10) BETWEEN ? AND ?${internal}`, r.from, r.to);
    const signIns = this.sql<{ requested: number; accepted: number; wrong: number; completed: number }>(
      "SELECT coalesce(sum(requested), 0) AS requested, coalesce(sum(accepted), 0) AS accepted, coalesce(sum(wrong), 0) AS wrong, coalesce(sum(completed), 0) AS completed FROM sign_in_days WHERE day BETWEEN ? AND ?", r.from, r.to)[0];
    const reached = (m: Milestone) => people.filter(p => p[`m_${m}`] !== null).length;
    const funnel = { codes_requested: signIns.requested, codes_accepted: signIns.accepted, wrong_codes: signIns.wrong, signed_in: people.length, sign_ins_completed: signIns.completed,
      first_call: reached("first_call"), business: reached("business"), client: reached("client"), work: reached("work"), draft: reached("draft"), issued: reached("issued"), payment: reached("payment") };

    const activeBetween = (from: string, to: string) => this.sql<{ n: number }>(
      `SELECT count(DISTINCT a.user_id) AS n FROM active_days a JOIN people p ON p.user_id = a.user_id WHERE a.day BETWEEN ? AND ?${internal}`, from, to)[0].n;
    const dau = activeBetween(r.to, r.to), wau = activeBetween(addDays(r.to, -6), r.to), mau = activeBetween(addDays(r.to, -29), r.to);
    const daily = this.sql<{ day: string; active: number }>(
      `SELECT a.day AS day, count(DISTINCT a.user_id) AS active FROM active_days a JOIN people p ON p.user_id = a.user_id WHERE a.day BETWEEN ? AND ?${internal} GROUP BY a.day ORDER BY a.day`, r.from, r.to);

    const days = new Map<string, Set<string>>();
    for (const p of people) days.set(p.user_id, new Set(this.sql<{ day: string }>("SELECT day FROM active_days WHERE user_id = ?", p.user_id).map(x => x.day)));
    // A window counts only once its last day has passed; until then its rate is null, never a misleading 0.
    const today = new Date().toISOString().slice(0, 10);
    const return_rates = [1, 7, 30].map(n => {
      const eligible = people.filter(p => addDays(p.signed_up_at.slice(0, 10), n) < today);
      const returned = eligible.filter(p => { const start = p.signed_up_at.slice(0, 10); return [...days.get(p.user_id)!].some(d => d > start && d <= addDays(start, n)); }).length;
      return { days: n, eligible: eligible.length, returned, rate: eligible.length ? round2(returned / eligible.length) : null };
    });
    const groups = new Map<string, PersonRow[]>();
    for (const p of people) { const week = isoWeek(p.signed_up_at.slice(0, 10)); groups.set(week, [...(groups.get(week) ?? []), p]); }
    const cohorts = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([week, members]) => {
      const monday = weekStart(members[0].signed_up_at.slice(0, 10));
      const weeks = [1, 2, 3, 4].map(w => {
        const from = addDays(monday, 7 * w), to = addDays(monday, 7 * w + 6);
        if (to >= today) return null;
        return round2(members.filter(p => [...days.get(p.user_id)!].some(d => d >= from && d <= to)).length / members.length);
      });
      return { week, size: members.length, weeks };
    });
    const signups_per_day = this.sql<{ day: string; signups: number }>(
      `SELECT substr(p.signed_up_at, 1, 10) AS day, count(*) AS signups FROM people p WHERE substr(p.signed_up_at, 1, 10) BETWEEN ? AND ?${internal} GROUP BY day ORDER BY day`, r.from, r.to);
    const dormant = (n: number) => this.sql<{ n: number }>(
      `SELECT count(*) AS n FROM people p WHERE p.deleted_at IS NULL AND coalesce(p.last_active_on, substr(p.signed_up_at, 1, 10)) < ?${internal}`, addDays(r.to, -n))[0].n;
    const assistants = this.sql<{ client_name: string; people: number }>(
      `SELECT c.client_name AS client_name, count(DISTINCT c.user_id) AS people FROM connections c JOIN people p ON p.user_id = c.user_id WHERE 1 = 1${internal} GROUP BY c.client_name ORDER BY people DESC`);
    const deleted = this.sql<{ n: number }>(`SELECT count(*) AS n FROM people p WHERE substr(p.deleted_at, 1, 10) BETWEEN ? AND ?${internal}`, r.from, r.to)[0].n;
    return { range: { from: r.from, to: r.to }, include_internal: r.includeInternal, funnel, dau, wau, mau, stickiness: mau ? round2(dau / mau) : 0,
      daily, return_rates, cohorts, signups_per_day, dormant_14: dormant(14), dormant_30: dormant(30), assistants, deleted };
  }
}
