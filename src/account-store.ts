import { DurableObject } from "cloudflare:workers";
import type { Milestone } from "./registry";
// A paginated discovery index, never an authorization source. BusinessStore checks access.
// It also remembers the person's last active day and reached milestones, so the registry hears about each only once.
export class AccountStore extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.schema();
  }
  private schema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS businesses (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS activity (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }
  add(businessId: string): void { this.ctx.storage.sql.exec("INSERT OR IGNORE INTO businesses(id) VALUES (?)", businessId); }
  list(limit: number, offset: number) {
    const rows = this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM businesses ORDER BY id LIMIT ? OFFSET ?", limit + 1, offset).toArray();
    return { ids: rows.slice(0, limit).map(r => r.id), next_offset: rows.length > limit ? offset + limit : null };
  }
  /** Records today's activity and milestones; returns only what is new. */
  touch(day: string, milestones: Milestone[]): { newDay: boolean; newMilestones: Milestone[] } {
    const sql = this.ctx.storage.sql;
    const newDay = sql.exec("SELECT 1 FROM activity WHERE name = 'day' AND value = ?", day).toArray().length === 0;
    if (newDay) sql.exec("INSERT INTO activity(name, value) VALUES ('day', ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value", day);
    const newMilestones = milestones.filter(m => sql.exec("INSERT OR IGNORE INTO activity(name, value) VALUES (?, ?)", `milestone:${m}`, day).rowsWritten > 0);
    return { newDay, newMilestones };
  }
  /** Account deletion. The object stays usable afterwards, empty. */
  async erase(): Promise<void> { await this.ctx.storage.deleteAll(); this.schema(); }
}
