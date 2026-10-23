import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { privateOperation } from "../src/mcp";
import { digest } from "../src/auth";
import { docsResponse } from "../src/docs";
import { otisMenu } from "../src/menu";
import { TEAM_OPERATIONS, offeredOperations, schemas, type DomainResult, type Operation } from "../src/models";
import { connected, rid } from "./auth-fixture";

// Production runs with TEAM_ENABLED "false" (wrangler.jsonc). The rest of the suite keeps the team logic tested with it on.
const off = { ...env, TEAM_ENABLED: "false" } as Env;
function value<T = any>(r: DomainResult): T {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.data as T;
}

describe("teams switched off", () => {
  it("offers no team tools over MCP and lists none in the tool schemas", async () => {
    const { client } = await connected(undefined, { TEAM_ENABLED: "false" });
    try {
      const names = (await client.listTools()).tools.map(tool => tool.name).sort();
      expect(names).toEqual(offeredOperations(false).sort());
      for (const operation of TEAM_OPERATIONS) expect(names).not.toContain(operation);
      expect(names).toHaveLength(Object.keys(schemas).length - TEAM_OPERATIONS.size);
    } finally { await client.close(); }
    const tools = await docsResponse("/docs/tools.json", off)!.json() as object;
    expect(Object.keys(tools).sort()).toEqual(offeredOperations(false).sort());
    expect(otisMenu(false, env.ORIGIN).data.options.map(option => option.prompt_name)).not.toContain("team");
  });

  it("refuses team operations and cuts off shared access", async () => {
    const owner = { userId: rid() }, email = `${rid()}@example.com`, editor = { userId: await digest(`otis-user:${email}`) };
    const on = (op: Operation, input: object, who = owner) => privateOperation(env, who, op, input);
    const business_id = value(await on("business_set", { request_id: rid(), name: "Shared before", currency: "EUR" })).business_id;
    const invite = value(await on("team_invite", { request_id: rid(), business_id, email, role: "editor" }));
    value(await on("team_accept", { request_id: rid(), business_id, invitation_id: invite.invitation_id }, editor));
    expect((await on("clients_list", { business_id }, editor)).ok).toBe(true);

    for (const op of TEAM_OPERATIONS) expect(await privateOperation(off, owner, op, { request_id: rid(), business_id, email, role: "viewer", invitation_id: "x", member_id: invite.id }), op).toMatchObject({ ok: false, code: "NOT_AVAILABLE" });
    expect(await privateOperation(off, editor, "clients_list", { business_id })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(await privateOperation(off, editor, "client_save", { request_id: rid(), business_id, name: "Blocked" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    const listing = value(await privateOperation(off, editor, "businesses_list", {}));
    expect(listing.records.map((record: any) => record.business_id)).not.toContain(business_id);
    // The owner keeps full access to their own business.
    expect((await privateOperation(off, owner, "clients_list", { business_id })).ok).toBe(true);
    expect(value(await privateOperation(off, owner, "businesses_list", {})).records.map((record: any) => record.business_id)).toContain(business_id);
  });
});
