import { DurableObject } from "cloudflare:workers";
// A paginated discovery index, never an authorization source. BusinessStore checks access.
export class AccountStore extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS businesses (id TEXT PRIMARY KEY)");
  }
  add(businessId: string): void { this.ctx.storage.sql.exec("INSERT OR IGNORE INTO businesses(id) VALUES (?)", businessId); }
  list(limit: number, offset: number) {
    const rows = this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM businesses ORDER BY id LIMIT ? OFFSET ?", limit + 1, offset).toArray();
    return { ids: rows.slice(0, limit).map(r => r.id), next_offset: rows.length > limit ? offset + limit : null };
  }
}
