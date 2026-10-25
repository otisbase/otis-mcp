import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { privateOperation } from "../src/mcp";
import { digest } from "../src/auth";
import { schemas, type DomainResult, type Operation } from "../src/models";
import { rid } from "./auth-fixture";

function value<T = any>(r: DomainResult): T {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.data as T;
}
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

async function setup() {
  const owner = { userId: rid() };
  const call = (op: Operation, input: Record<string, unknown> = {}, who = owner) => privateOperation(env, who, op, input);
  const business_id = value(await call("business_set", { request_id: rid(), name: "Timer QA", currency: "EUR" })).business_id as string;
  const client = value(await call("client_save", { request_id: rid(), name: "Client X", customer_type: "business" }));
  const start = (extras: object = {}, who = owner) => call("timer_start", { request_id: rid(), business_id, client_id: client.id, description: "Design review", ...extras }, who);
  return { owner, call, business_id, client, start };
}

describe("timers", () => {
  it("records the tracked time as billable hours when stopped with a rate", async () => {
    const t = await setup();
    const timer = value(await t.start({ started_at: minutesAgo(90) }));
    expect(timer).toMatchObject({ state: "running", start_reported: true, elapsed_minutes: 90 });
    const stopped = value(await t.call("timer_stop", { request_id: rid(), timer_id: timer.id, rate_minor: 10_000 }));
    expect(stopped.recorded).toBe(true);
    expect(stopped.timer).toMatchObject({ state: "recorded", minutes: 90, hours: "1.5", stop_reported: false, billable_id: stopped.billable.id });
    expect(stopped.billable).toMatchObject({ kind: "time", quantity: "1.5", unit: "hours", rate_minor: 10_000, amount_minor: 15_000, timer_id: timer.id, client_id: t.client.id, description: "Design review" });
    const listed = value(await t.call("billables_list", { business_id: t.business_id }));
    expect(listed.records.map((r: any) => r.id)).toContain(stopped.billable.id);
  });

  it("is exact to the minute and rounds the amount half up", async () => {
    const t = await setup();
    const timer = value(await t.start({ started_at: minutesAgo(83) }));
    const stopped = value(await t.call("timer_stop", { request_id: rid(), timer_id: timer.id, rate_minor: 12_345 }));
    expect(stopped.timer.hours).toBe("1.383333");
    // 1.383333 h × 123.45 = 170.7712…, rounded half up to 170.77.
    expect(stopped.billable.amount_minor).toBe(17_077);
  });

  it("stops without a rate, records on a second call, and then stays closed", async () => {
    const t = await setup();
    const timer = value(await t.start({ started_at: minutesAgo(45) }));
    const first = value(await t.call("timer_stop", { request_id: rid(), timer_id: timer.id, stopped_at: minutesAgo(15) }));
    expect(first).toMatchObject({ recorded: false, timer: { state: "stopped", minutes: 30, hours: "0.5", stop_reported: true } });
    const second = value(await t.call("timer_stop", { request_id: rid(), timer_id: timer.id, rate_minor: 8000 }));
    expect(second).toMatchObject({ recorded: true, timer: { minutes: 30 }, billable: { amount_minor: 4000 } });
    expect(await t.call("timer_stop", { request_id: rid(), timer_id: timer.id, rate_minor: 8000 })).toMatchObject({ ok: false, code: "TIMER_CLOSED" });
  });

  it("runs several timers at once, lists the running ones and discards one", async () => {
    const t = await setup();
    const a = value(await t.start({ description: "Call" })), b = value(await t.start({ description: "Proposal" }));
    const running = value(await t.call("timers_list", { business_id: t.business_id, state: "running" }));
    expect(running.records.map((r: any) => r.id).sort()).toEqual([a.id, b.id].sort());
    for (const record of running.records) expect(record.elapsed_minutes).toBe(0);
    expect(value(await t.call("timer_stop", { request_id: rid(), timer_id: a.id, discard: true }))).toMatchObject({ recorded: false, timer: { state: "discarded" } });
    expect(value(await t.call("timers_list", { business_id: t.business_id, state: "running" })).records.map((r: any) => r.id)).toEqual([b.id]);
    // Under a minute tracks nothing to record.
    expect(value(await t.call("timer_stop", { request_id: rid(), timer_id: b.id, rate_minor: 5000 }))).toMatchObject({ recorded: false, timer: { minutes: 0 } });
  });

  it("checks reported times and keeps Otis's clock beside them", async () => {
    const t = await setup();
    expect(await t.start({ started_at: new Date(Date.now() + 10 * 60_000).toISOString() })).toMatchObject({ ok: false, code: "TIME_IN_FUTURE" });
    expect(await t.start({ started_at: minutesAgo(8 * 24 * 60) })).toMatchObject({ ok: false, code: "TIME_TOO_OLD" });
    for (const started_at of ["9am", "2026-10-23T09:00:00"]) expect(schemas.timer_start.safeParse({ request_id: rid(), client_id: "c", description: "d", started_at }).success, started_at).toBe(false);
    const timer = value(await t.start({ started_at: minutesAgo(30) }));
    expect(Date.parse(timer.clock_started_at) - Date.parse(timer.started_at)).toBeGreaterThan(29 * 60_000);
    expect(await t.call("timer_stop", { request_id: rid(), timer_id: timer.id, stopped_at: minutesAgo(60) })).toMatchObject({ ok: false, code: "STOP_BEFORE_START" });
  });

  it("returns the same start on a retried request and warns about very long timers", async () => {
    const t = await setup();
    const request_id = rid(), input = { request_id, business_id: t.business_id, client_id: t.client.id, description: "Retry" };
    const first = value(await t.call("timer_start", input)), retry = value(await t.call("timer_start", input));
    expect(retry.id).toBe(first.id);
    expect(retry.started_at).toBe(first.started_at);
    const long = value(await t.start({ started_at: minutesAgo(13 * 60) }));
    expect(value(await t.call("timer_stop", { request_id: rid(), timer_id: long.id, rate_minor: 1000 })).warning).toContain("more than 12 hours");
  });

  it("lets only the member who started a timer, or the owner, stop it", async () => {
    const t = await setup();
    const email = `${rid()}@example.com`, editor = { userId: await digest(`otis-user:${email}`) };
    const invite = value(await t.call("team_invite", { request_id: rid(), business_id: t.business_id, email, role: "editor" }));
    value(await t.call("team_accept", { request_id: rid(), business_id: t.business_id, invitation_id: invite.invitation_id }, editor));
    const owners = value(await t.start());
    expect(await t.call("timer_stop", { request_id: rid(), business_id: t.business_id, timer_id: owners.id }, editor)).toMatchObject({ ok: false, code: "FORBIDDEN" });
    const editors = value(await t.start({}, editor));
    expect(editors.started_by).toBe(`member:${editor.userId}`);
    expect(value(await t.call("timer_stop", { request_id: rid(), business_id: t.business_id, timer_id: editors.id })).timer.state).toBe("stopped");
  });

  it("keeps the timer link when the recorded work is corrected", async () => {
    const t = await setup();
    const timer = value(await t.start({ started_at: minutesAgo(60) }));
    const { billable } = value(await t.call("timer_stop", { request_id: rid(), timer_id: timer.id, rate_minor: 9000 }));
    const corrected = value(await t.call("billable_record", { request_id: rid(), business_id: t.business_id, item_id: billable.id, client_id: t.client.id, kind: "time",
      description: "Design review (corrected)", quantity: "1", unit: "hours", rate_minor: 8000, amount_minor: 8000 }));
    expect(corrected.timer_id).toBe(timer.id);
  });
});
