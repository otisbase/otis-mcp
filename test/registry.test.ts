import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { eu } from "../src/regions";
import { rid } from "./auth-fixture";

// A fresh registry per test; production uses the one named "registry" (registry() in src/registry.ts).
const fresh = () => eu(env.REGISTRY).getByName(rid());
const person = (extra: Record<string, unknown> = {}) => ({ userId: rid(), email: `${rid()}@example.com`, businessId: rid(), clientId: "client-a", clientName: "Claude", internal: false, at: "2026-09-01T10:00:00.000Z", ...extra });
const range = { from: "2026-09-01", to: "2026-10-25", includeInternal: false };

describe("registry", () => {
  it("signedIn keeps the first sign-up time", async () => {
    const r = fresh(), p = person();
    await r.signedIn(p);
    await r.signedIn({ ...p, clientId: "client-b", clientName: "ChatGPT", at: "2026-09-03T10:00:00.000Z" });
    const stored = (await r.person(p.userId))!;
    expect(stored.signed_up_at).toBe("2026-09-01T10:00:00.000Z");
    expect(stored.first_seen).toBe(0);
    expect(stored.connections.map(c => c.client_name).sort()).toEqual(["ChatGPT", "Claude"]);
  });

  it("activity inserts unknown people as first seen", async () => {
    const r = fresh(), p = person();
    await r.activity({ userId: p.userId, email: p.email, businessId: p.businessId, day: "2026-09-02", milestones: ["first_call"], internal: false, at: "2026-09-02T08:00:00.000Z" });
    const stored = (await r.personByEmail(p.email))!;
    expect(stored).toMatchObject({ first_seen: 1, signed_up_at: "2026-09-02T08:00:00.000Z", last_active_on: "2026-09-02" });
    expect(stored.milestones.first_call).toBe("2026-09-02T08:00:00.000Z");
  });

  it("milestones are set once", async () => {
    const r = fresh(), p = person();
    await r.signedIn(p);
    const touch = (at: string) => r.activity({ userId: p.userId, businessId: p.businessId, day: at.slice(0, 10), milestones: ["client"], internal: false, at });
    await touch("2026-09-02T08:00:00.000Z");
    await touch("2026-09-05T08:00:00.000Z");
    const stored = (await r.person(p.userId))!;
    expect(stored.milestones.client).toBe("2026-09-02T08:00:00.000Z");
    expect(stored.last_active_on).toBe("2026-09-05");
  });

  it("stats exclude internal people unless asked", async () => {
    const r = fresh();
    await r.signedIn(person());
    await r.signedIn(person({ internal: true }));
    expect((await r.stats(range)).funnel.signed_in).toBe(1);
    expect((await r.stats({ ...range, includeInternal: true })).funnel.signed_in).toBe(2);
  });

  it("funnel steps 1 and 2 sum sign-in attempts", async () => {
    const r = fresh();
    for (const step of ["requested", "requested", "requested", "accepted", "accepted"] as const) await r.signInStep("2026-09-04", step);
    await r.signInStep("2026-08-01", "requested");
    const { funnel } = await r.stats(range);
    expect(funnel).toMatchObject({ codes_requested: 3, codes_accepted: 2 });
  });

  it("return rates use the window and only count elapsed windows", async () => {
    const r = fresh(), p = person();
    await r.signedIn(p);
    await r.activity({ userId: p.userId, businessId: p.businessId, day: "2026-09-05", milestones: [], internal: false, at: "2026-09-05T08:00:00.000Z" });
    const late = person({ at: "2026-10-20T08:00:00.000Z" });
    await r.signedIn(late);
    const rates = Object.fromEntries((await r.stats(range)).return_rates.map(x => [x.days, x]));
    expect(rates[1]).toMatchObject({ eligible: 2, returned: 0, rate: 0 });
    expect(rates[7]).toMatchObject({ eligible: 1, returned: 1, rate: 1 });
    expect(rates[30]).toMatchObject({ eligible: 1, returned: 1, rate: 1 });
  });

  it("cohorts group by ISO week of sign-up", async () => {
    const r = fresh(), a = person(), b = person({ at: "2026-09-03T09:00:00.000Z" });
    await r.signedIn(a);
    await r.signedIn(b);
    await r.activity({ userId: a.userId, businessId: a.businessId, day: "2026-09-08", milestones: [], internal: false, at: "2026-09-08T08:00:00.000Z" });
    const { cohorts } = await r.stats(range);
    expect(cohorts).toEqual([{ week: "2026-W36", size: 2, weeks: [0.5, 0, 0, 0] }]);
  });

  it("active users count distinct people up to the end of the range", async () => {
    const r = fresh(), a = person(), b = person();
    await r.signedIn(a);
    await r.signedIn(b);
    for (const [who, day] of [[a, "2026-10-25"], [b, "2026-10-20"], [a, "2026-10-01"]] as const) {
      await r.activity({ userId: who.userId, businessId: who.businessId, day, milestones: [], internal: false, at: `${day}T08:00:00.000Z` });
    }
    const stats = await r.stats(range);
    expect(stats).toMatchObject({ dau: 1, wau: 2, mau: 2, stickiness: 0.5 });
    expect(stats.daily.find(d => d.day === "2026-10-20")).toEqual({ day: "2026-10-20", active: 1 });
  });

  it("tombstone removes identity and keeps totals", async () => {
    const r = fresh(), p = person();
    await r.signedIn(p);
    await r.log({ admin: "admin@example.com", tool: "admin_account_get", targetUserId: p.userId, targetEmail: p.email, reason: "Support", outcome: "ok", at: "2026-10-25T08:00:00.000Z" });
    const before = (await r.stats(range)).funnel.signed_in;
    await r.tombstone(p.userId, "2026-10-25T09:00:00.000Z");
    expect(await r.personByEmail(p.email)).toBeNull();
    expect(await r.person(p.userId)).toBeNull();
    const after = await r.stats(range);
    expect(after.funnel.signed_in).toBe(before);
    expect(after.deleted).toBe(1);
    const log = (await r.accessLog(10, 0)).records;
    expect(log[0]).toMatchObject({ target_user_id: p.userId, target_email: null });
  });

  it("a call without an email keeps the internal flag", async () => {
    const r = fresh(), p = person({ internal: true });
    await r.signedIn(p);
    await r.activity({ userId: p.userId, businessId: p.businessId, day: "2026-09-02", milestones: [], internal: false, at: "2026-09-02T08:00:00.000Z" });
    expect((await r.person(p.userId))!).toMatchObject({ internal: 1, email: p.email });
  });

  it("windows that have not ended are reported as null", async () => {
    const r = fresh(), now = new Date().toISOString(), today = now.slice(0, 10);
    await r.signedIn(person({ at: now }));
    const stats = await r.stats({ from: today, to: today, includeInternal: false });
    expect(stats.return_rates.map(x => [x.days, x.eligible, x.rate])).toEqual([[1, 0, null], [7, 0, null], [30, 0, null]]);
    expect(stats.cohorts[0].weeks).toEqual([null, null, null, null]);
  });

  it("people filters by status and paginates", async () => {
    const r = fresh(), a = person(), b = person();
    await r.signedIn(a);
    await r.signedIn(b);
    await r.setStatus(b.userId, "suspended", "admin@example.com", "Abuse", "2026-10-25T08:00:00.000Z");
    const suspended = await r.people({ filter: "suspended", limit: 10, offset: 0 });
    expect(suspended.records.map(x => x.email)).toEqual([b.email]);
    expect(suspended.records[0]).toMatchObject({ status: "suspended", status_by: "admin@example.com", status_reason: "Abuse" });
    const page = await r.people({ limit: 1, offset: 0 });
    expect(page.records).toHaveLength(1);
    expect(page.next_offset).toBe(1);
  });
});

describe("account activity", () => {
  const account = () => eu(env.ACCOUNTS).getByName(rid());
  it("touch reports a new day once", async () => {
    const a = account();
    expect(await a.touch("2026-10-25", [])).toEqual({ newDay: true, newMilestones: [] });
    expect(await a.touch("2026-10-25", [])).toEqual({ newDay: false, newMilestones: [] });
    expect((await a.touch("2026-10-26", [])).newDay).toBe(true);
  });

  it("touch reports each milestone once", async () => {
    const a = account();
    expect((await a.touch("2026-10-25", ["first_call", "client"])).newMilestones).toEqual(["first_call", "client"]);
    expect((await a.touch("2026-10-25", ["first_call", "client", "work"])).newMilestones).toEqual(["work"]);
  });

  it("erase removes the index and state", async () => {
    const a = account();
    await a.add(rid());
    await a.touch("2026-10-25", ["first_call"]);
    await a.erase();
    expect((await a.list(10, 0)).ids).toEqual([]);
    expect(await a.touch("2026-10-25", ["first_call"])).toEqual({ newDay: true, newMilestones: ["first_call"] });
  });
});
