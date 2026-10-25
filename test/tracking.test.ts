import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { digest } from "../src/auth";
import { registry, type Milestone } from "../src/registry";
import { trackCall, milestonesFor } from "../src/tracking";
import { authFlow, connected, rid, settle } from "./auth-fixture";

const today = () => new Date().toISOString().slice(0, 10);
const attempts = async () => (await registry(env).stats({ from: today(), to: today(), includeInternal: true })).funnel;

describe("tracking", () => {
  it("a sign-in registers the person with their assistant", async () => {
    const email = `${rid()}@example.com`;
    await connected(email);
    await settle();
    const person = (await registry(env).personByEmail(email))!;
    expect(person).toMatchObject({ email, first_seen: 0, internal: 0, business_id: await digest(`otis-business:${await digest(`otis-user:${email}`)}`) });
    expect(person.connections.map(c => c.client_name)).toEqual(["Local security checks"]);
  });

  it("sign-in steps are counted", async () => {
    const before = await attempts();
    const flow = await authFlow();
    await flow.authorize();
    await settle();
    const after = await attempts();
    expect(after.codes_requested - before.codes_requested).toBe(1);
    expect(after.codes_accepted - before.codes_accepted).toBe(1);
    expect(after.sign_ins_completed - before.sign_ins_completed).toBe(1);
  });

  it("a wrong code is counted", async () => {
    const before = await attempts();
    const flow = await authFlow();
    expect((await flow.send()).status).toBe(200);
    expect((await flow.post("/authorize/verify", { code: flow.code() === "000000" ? "111111" : "000000" })).status).toBe(400);
    await settle();
    expect((await attempts()).wrong_codes - before.wrong_codes).toBe(1);
  });

  it("tool calls set milestones", async () => {
    const email = `${rid()}@example.com`;
    const c = await connected(email);
    await c.client.callTool({ name: "business_set", arguments: { request_id: rid(), name: "Tracked", currency: "USD" } });
    await c.client.callTool({ name: "client_save", arguments: { request_id: rid(), name: "Client" } });
    await settle();
    const { milestones, last_active_on } = (await registry(env).personByEmail(email))!;
    expect(milestones.first_call).not.toBeNull();
    expect(milestones.business).not.toBeNull();
    expect(milestones.client).not.toBeNull();
    expect(milestones.work).toBeNull();
    expect(last_active_on).toBe(today());
  });

  it("the registry gets one activity write per new day", async () => {
    const writes: unknown[] = [];
    const fake = { getByName: () => ({ activity: async (p: unknown) => { writes.push(p); } }) };
    const bindings = { ...env, REGISTRY: fake } as unknown as Env;
    const who = { userId: rid(), email: `${rid()}@example.com` };
    for (let i = 0; i < 3; i++) await trackCall(bindings, who, "businesses_list", true);
    expect(writes).toHaveLength(1);
    await trackCall(bindings, who, "client_save", true);
    expect(writes).toHaveLength(2);
  });

  it("failed calls count as activity but reach no milestone", () => {
    expect(milestonesFor("invoice_issue", false)).toEqual<Milestone[]>(["first_call"]);
    expect(milestonesFor("timer_start", true)).toEqual<Milestone[]>(["first_call", "work"]);
  });

  it("internal emails are marked internal", async () => {
    const email = `${rid()}@example.com`;
    await connected(email, { INTERNAL_EMAILS: ` other@example.com, ${email.toUpperCase()} ` });
    await settle();
    expect((await registry(env).personByEmail(email))!.internal).toBe(1);
  });

  it("a suspended email cannot finish signing in", async () => {
    const email = `${rid()}@example.com`;
    await registry(env).setStatus(await digest(`otis-user:${email}`), "suspended", "admin@example.com", "Abuse", new Date().toISOString(), email);
    const flow = await authFlow({ email });
    expect((await flow.send()).status).toBe(200);
    const response = await flow.post("/authorize/verify", { code: flow.code() });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("This account is suspended.");
  });

  it("sign-in still works when the registry is unavailable", async () => {
    const broken = { getByName: () => ({ person: async () => { throw new Error("registry down"); }, signInStep: async () => {}, signedIn: async () => {} }) };
    const flow = await authFlow({ bindings: { REGISTRY: broken } as unknown as Partial<Env> });
    expect((await flow.send()).status).toBe(200);
    expect((await flow.post("/authorize/verify", { code: flow.code() })).status).toBe(303);
  });
});
