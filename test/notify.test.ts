import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { privateOperation } from "../src/mcp";
import type { DomainResult } from "../src/models";
import { authFlow, rid } from "./auth-fixture";

type Sent = { to: string; subject: string; text: string };
function mailer() {
  const sent: Sent[] = [];
  const bindings: Env = { ...env, EMAIL: { send: async (message: unknown) => { sent.push(message as Sent); return { messageId: "local-only" }; } } as SendEmail };
  return { bindings, sent };
}
const ok = (r: DomainResult) => { if (!r.ok) throw new Error(`${r.code}: ${r.message}`); return r.data; };

describe("security notices", () => {
  it("emails the person when a new assistant connects", async () => {
    const email = `${rid()}@example.com`;
    const flow = await authFlow({ email });
    await flow.authorize();
    const notice = flow.deliveries.find(message => message.text.includes("can now read and change your Otis business records"));
    expect(notice).toMatchObject({ to: email });
    expect(notice!.text).toContain("Local security checks");
  });
  it("emails the owner when someone is invited, and never blocks the invitation if email fails", async () => {
    const m = mailer(), owner = { userId: rid(), email: `${rid()}@example.com` };
    ok(await privateOperation(m.bindings, owner, "business_set", { request_id: rid(), name: "Northstar Studio", currency: "USD" }));
    ok(await privateOperation(m.bindings, owner, "team_invite", { request_id: rid(), email: "colleague@example.com", role: "viewer" }));
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0]).toMatchObject({ to: owner.email, subject: "You invited someone to your Otis business" });
    expect(m.sent[0].text).toContain("colleague@example.com was invited as a viewer");
    const failing: Env = { ...env, EMAIL: { send: async () => { throw new Error("Simulated email outage"); } } as SendEmail };
    ok(await privateOperation(failing, owner, "team_invite", { request_id: rid(), email: "second@example.com", role: "editor" }));
  });
});
