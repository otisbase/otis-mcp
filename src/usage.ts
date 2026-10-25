/**
 * Usage events for the admin tools, written to the Workers Analytics Engine dataset `otis_usage` (binding USAGE).
 * Writes are fire-and-forget: no await, so an ordinary request never waits on them. Cloudflare keeps them three months.
 * Layout: index1 = user ID or "demo"; blob1–7 = event, tool, outcome, client, business, kind, currency;
 * double1 = amount in minor units, double2 = count.
 */
export type UsageEvent = {
  event: "tool_call" | "record_created" | "invoice_issued" | "plan_limit";
  user: string; tool?: string; outcome?: string; client?: string; business?: string; kind?: string; currency?: string;
  amount_minor?: number; count?: number;
};

export function recordUsage(env: Env, e: UsageEvent): void {
  try {
    env.USAGE?.writeDataPoint({
      indexes: [e.user],
      blobs: [e.event, e.tool ?? "", e.outcome ?? "", e.client ?? "", e.business ?? "", e.kind ?? "", e.currency ?? ""],
      doubles: [e.amount_minor ?? 0, e.count ?? 1]
    });
  } catch {
    // Usage events are informational; they never fail a request.
  }
}

const ID = /^[0-9a-f]{64}$/;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Named SQL for admin_usage over the inclusive UTC day range, clamped to the last 90 days Cloudflare keeps.
 * Only opaque 64-hex user IDs are interpolated; anything else throws. onlyUser narrows every query to one person.
 */
export function usageQueries(from: string, to: string, excludeUsers: string[], onlyUser?: string): Record<string, string> {
  for (const id of [...excludeUsers, ...(onlyUser ? [onlyUser] : [])]) if (!ID.test(id)) throw new Error("Usage queries take opaque user IDs only.");
  if (![from, to].every(d => /^\d{4}-\d{2}-\d{2}$/.test(d))) throw new Error("Usage queries take YYYY-MM-DD days.");
  const start = from > addDays(to, -89) ? from : addDays(to, -89);
  const where = (event: string, extra = "") => [`blob1 = '${event}'`, `timestamp >= toDateTime('${start} 00:00:00')`, `timestamp < toDateTime('${addDays(to, 1)} 00:00:00')`,
    ...(excludeUsers.length ? [`index1 NOT IN (${excludeUsers.map(id => `'${id}'`).join(", ")})`] : []), ...(onlyUser ? [`index1 = '${onlyUser}'`] : []), ...(extra ? [extra] : [])].join(" AND ");
  return {
    tool_calls: `SELECT blob2 AS tool, blob3 AS outcome, SUM(_sample_interval) AS calls FROM otis_usage WHERE ${where("tool_call", "index1 != 'demo'")} GROUP BY tool, outcome ORDER BY calls DESC`,
    clients: `SELECT blob4 AS client, SUM(_sample_interval) AS calls FROM otis_usage WHERE ${where("tool_call", "index1 != 'demo'")} GROUP BY client ORDER BY calls DESC`,
    records_created: `SELECT blob6 AS kind, SUM(_sample_interval * double2) AS created FROM otis_usage WHERE ${where("record_created")} GROUP BY kind ORDER BY created DESC`,
    invoices: `SELECT blob7 AS currency, SUM(_sample_interval) AS invoices, SUM(_sample_interval * double1) AS total_minor FROM otis_usage WHERE ${where("invoice_issued")} GROUP BY currency ORDER BY invoices DESC`,
    plan_limits: `SELECT blob6 AS plan_limit, SUM(_sample_interval) AS refusals FROM otis_usage WHERE ${where("plan_limit")} GROUP BY plan_limit ORDER BY refusals DESC`,
    demo_calls: `SELECT toStartOfDay(timestamp) AS day, SUM(_sample_interval) AS calls FROM otis_usage WHERE ${where("tool_call", "index1 = 'demo'")} GROUP BY day ORDER BY day`
  };
}

/** Runs one query through the Analytics Engine SQL API. Numeric strings in the result become numbers. */
export async function queryUsage(env: Env, sql: string): Promise<Record<string, unknown>[]> {
  if (!env.ANALYTICS_API_TOKEN) throw new Error("ANALYTICS_API_TOKEN is not set.");
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.ANALYTICS_ACCOUNT_ID}/analytics_engine/sql`, {
    method: "POST", headers: { Authorization: `Bearer ${env.ANALYTICS_API_TOKEN}` }, body: sql
  });
  if (!response.ok) throw new Error(`Analytics Engine answered ${response.status}.`);
  const { data } = await response.json() as { data: Record<string, unknown>[] };
  return data.map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v])));
}
