import { env } from "cloudflare:workers";
import { eu } from "../src/regions";
import { SELF, createExecutionContext, evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import worker from "../src/index";
import { digest } from "../src/auth";
import type { DomainResult, Operation } from "../src/models";

function data<T = Record<string, unknown>>(result: DomainResult): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.data as T;
}
function store() {
  const stub = eu(env.BUSINESSES).getByName(`test:${crypto.randomUUID()}`);
  return { stub, execute: async (operation: Operation, input: unknown): Promise<DomainResult> => JSON.parse(await stub.execute(operation, input, { userId: "owner", home: true })) };
}
function mcpFetch(input: RequestInfo | URL, init?: RequestInit) {
  const request = new Request(input, init);
  request.headers.set("Host", new URL(request.url).host);
  return SELF.fetch(request);
}
async function setup(target = store()) {
  data(await target.execute("business_set", { request_id: crypto.randomUUID(), name: "Test Studio", currency: "USD" }));
  const client = data<{ id: string }>(await target.execute("client_save", { request_id: crypto.randomUUID(), name: "Client" }));
  return { target, client };
}

describe("business record integrity", () => {
  it("persists across eviction and isolates businesses", async () => {
    const { target, client } = await setup();
    await evictDurableObject(target.stub);
    expect(data(await target.execute("business_get", {})).name).toBe("Test Studio");
    const other = await setup();
    const result = await other.target.execute("billable_record", {
      request_id: crypto.randomUUID(), client_id: client.id, kind: "time",
      quantity: "2", unit: "hour", description: "Consulting", amount_minor: 20000
    });
    expect(result).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("deduplicates concurrent retries and rejects conflicting reuse", async () => {
    const { target, client } = await setup();
    const input = {
      request_id: crypto.randomUUID(), client_id: client.id, kind: "time",
      quantity: "5", unit: "hour", description: "Consulting", amount_minor: 60000, rate_minor: 12000
    };
    const results = await Promise.all(Array.from({ length: 8 }, () => target.execute("billable_record", input)));
    expect(new Set(results.map((r) => data(r).id)).size).toBe(1);
    const list = data<{ records: unknown[] }>(await target.execute("billables_list", { state: "unbilled" }));
    expect(list.records).toHaveLength(1);
    expect(await target.execute("billable_record", { ...input, description: "Different action" }))
      .toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
  });

  it("rejects arithmetic mismatches without recording an item or consuming the retry key", async () => {
    const { target, client } = await setup();
    const input = {
      request_id: crypto.randomUUID(), client_id: client.id, kind: "time", quantity: "1.5",
      unit: "hour", description: "Consulting", rate_minor: 101, amount_minor: 151
    };
    expect(await target.execute("billable_record", input)).toMatchObject({ ok: false, code: "AMOUNT_MISMATCH" });
    expect(data(await target.execute("billable_record", { ...input, amount_minor: 152 })).amount_minor).toBe(152);
  });

  it("requires AI usage provenance and prevents currency reinterpretation", async () => {
    const { target, client } = await setup();
    const item = {
      request_id: crypto.randomUUID(), client_id: client.id, kind: "ai_usage",
      quantity: "2000000", unit: "token", description: "Coding", amount_minor: 1200
    };
    expect(await target.execute("billable_record", item)).toMatchObject({ ok: false, code: "MEASUREMENT_REQUIRED" });
    data(await target.execute("billable_record", { ...item, measurement: "estimated" }));
    expect(await target.execute("business_set", { request_id: crypto.randomUUID(), name: "Test Studio", currency: "EUR" }))
      .toMatchObject({ ok: false, code: "CURRENCY_LOCKED" });
  });

  it("exports paginated records with a matching audit trail", async () => {
    const { target } = await setup();
    for (const name of ["Second client", "Third client"]) {
      data(await target.execute("client_save", { request_id: crypto.randomUUID(), name }));
    }
    const first = data<{ records: { id: string }[]; next_offset: number }>(await target.execute("records_export", { kind: "client", limit: 2 }));
    const second = data<{ records: { id: string }[]; next_offset: null }>(await target.execute("records_export", { kind: "client", limit: 2, offset: first.next_offset }));
    expect(new Set([...first.records, ...second.records].map((r) => r.id)).size).toBe(3);
    expect(second.next_offset).toBeNull();
    const audit = data<{ records: unknown[] }>(await target.execute("records_export", { kind: "audit" }));
    expect(audit.records).toHaveLength(4);
  });
});

describe("public MCP and access control", () => {
  it("supports a real MCP client and exposes only sample-data reads", async () => {
    const client = new Client({ name: "otis-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL("https://otis.test/demo/mcp"), {
      fetch: mcpFetch
    });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain("billables_list");
      expect(tools.tools.map((t) => t.name)).not.toContain("billable_record");
      const result = await client.callTool({ name: "billables_list", arguments: { state: "unbilled", client_id: "fernhill-coffee" } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ demo: true, ok: true });
      const entries = (result.structuredContent as { data: { records: { amount_minor: number }[] } }).data.records;
      expect(entries.reduce((total, item) => total + item.amount_minor, 0)).toBe(68700);
      await expect(client.callTool({
        name: "billable_record",
        arguments: { request_id: crypto.randomUUID(), description: "Do not save this" }
      })).rejects.toThrow("not found");
    } finally { await client.close(); }
  });

  it("requires OAuth on private records and publishes discoverable metadata", async () => {
    const denied = await SELF.fetch("https://otis.test/mcp", { method: "POST", body: "{}" });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("WWW-Authenticate")).toContain("resource_metadata");
    const metadata = await SELF.fetch("https://otis.test/.well-known/oauth-authorization-server");
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      issuer: "https://otis.test", authorization_endpoint: "https://otis.test/authorize"
    });
    const bogus = await SELF.fetch("https://otis.test/mcp", { method: "POST", headers: { Authorization: "Bearer invented" }, body: "{}" });
    expect(bogus.status).toBe(401);
  });

  it("rejects unknown hosts and keeps signup closed until configured", async () => {
    expect((await SELF.fetch("https://attacker.test/")).status).toBe(421);
    expect((await SELF.fetch("https://otis.test/authorize")).status).toBe(503);
    const docs = await SELF.fetch("https://otis.test/llms.txt");
    expect(await docs.text()).toContain("read-only demo");
  });
});

describe("passwordless authorization", () => {
  async function begin() {
    const registered = await SELF.fetch("https://otis.test/oauth/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "<script>untrusted</script>", redirect_uris: ["http://127.0.0.1:8912/callback"],
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none"
      })
    });
    expect(registered.status).toBe(201);
    const registration = await registered.json() as { client_id: string };
    const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-test";
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(hash))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    let emailBody = "";
    const bindings: Env = {
      ...env, SIGN_IN_ENABLED: "true",
      EMAIL: { send: async (message: unknown) => {
        emailBody = (message as { text: string }).text;
        return { messageId: "simulated-local-email" };
      } } as SendEmail
    };
    const parameters = new URLSearchParams({
      client_id: registration.client_id, redirect_uri: "http://127.0.0.1:8912/callback",
      response_type: "code", scope: "otis:records offline_access", state: "client-state",
      code_challenge: challenge, code_challenge_method: "S256", resource: "https://otis.test/mcp"
    });
    const response = await worker.fetch(new Request(`https://otis.test/authorize?${parameters}`), bindings, createExecutionContext());
    expect(response.status).toBe(200);
    // Browser form navigations need a real Origin and a permitted OAuth redirect.
    expect(response.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(response.headers.get("Content-Security-Policy")).toContain("form-action 'self' http://127.0.0.1:8912;");
    const html = await response.text();
    expect(html).toContain("&lt;script&gt;untrusted&lt;/script&gt;");
    const flow = html.match(/name="flow" value="([^"]+)"/)![1];
    const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
    const cookie = response.headers.get("Set-Cookie")!.split(";")[0];
    const post = (path: string, values: Record<string, string>, origin = "https://otis.test") =>
      worker.fetch(new Request(`https://otis.test${path}`, {
        method: "POST", headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ flow, csrf, ...values })
      }), bindings, createExecutionContext());
    return { bindings, registration, verifier, flow, csrf, cookie, post, emailBody: () => emailBody };
  }

  it("completes signup, token exchange and authenticated MCP without exposing the code", async () => {
    const flow = await begin();
    const started = await flow.post("/authorize/start", { email: `test-${crypto.randomUUID()}@example.com` });
    expect(started.status).toBe(200);
    expect(started.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(started.headers.get("Content-Security-Policy")).toContain("form-action 'self' http://127.0.0.1:8912;");
    const code = flow.emailBody().match(/code is (\d{6})/)![1];
    expect(await started.text()).not.toContain(code);
    const verified = await flow.post("/authorize/verify", { code });
    expect(verified.status).toBe(303);
    const callback = new URL(verified.headers.get("Location")!);
    expect(callback.searchParams.get("state")).toBe("client-state");
    const exchange = await SELF.fetch("https://otis.test/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", client_id: flow.registration.client_id,
        redirect_uri: "http://127.0.0.1:8912/callback", code: callback.searchParams.get("code")!,
        code_verifier: flow.verifier, resource: "https://otis.test/mcp"
      })
    });
    expect(exchange.status).toBe(200);
    const token = await exchange.json() as { access_token: string };
    const client = new Client({ name: "private-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL("https://otis.test/mcp"), {
      fetch: mcpFetch,
      requestInit: { headers: { Authorization: `Bearer ${token.access_token}` } }
    }));
    try {
      const result = await client.callTool({ name: "business_get", arguments: {} });
      expect(result.structuredContent).toMatchObject({ ok: true, data: { setup_required: true } });
    } finally { await client.close(); }
    expect((await flow.post("/authorize/verify", { code })).status).toBe(400);
  });

  it("rejects cross-origin submissions and enforces five guesses", async () => {
    const flow = await begin();
    expect((await flow.post("/authorize/start", { email: "test@example.com" }, "https://attacker.test")).status).toBe(403);
    expect((await flow.post("/authorize/start", { email: "test@example.com" }, "null")).status).toBe(403);
    expect((await flow.post("/authorize/start", { email: `test-${crypto.randomUUID()}@example.com` })).status).toBe(200);
    const code = flow.emailBody().match(/code is (\d{6})/)![1];
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect((await flow.post("/authorize/verify", { code: wrong })).status).toBe(400);
    expect((await flow.post("/authorize/verify", { code })).status).toBe(400);
  });

  it("expires flows and applies persistent email delivery limits", async () => {
    const flow = await begin();
    const stub = eu(env.SIGN_INS).getByName(`flow:${flow.flow}`);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await flow.post("/authorize/start", { email: "test@example.com" })).status).toBe(400);
    const limit = eu(env.SIGN_INS).getByName(`rate-test:${crypto.randomUUID()}`);
    const attempts = await Promise.all(Array.from({ length: 8 }, () => limit.allow(3, 60000)));
    expect(attempts.filter(Boolean)).toHaveLength(3);
  });

  it("invalidates the connection when the user cancels", async () => {
    const flow = await begin();
    const denied = await flow.post("/authorize/start", { deny: "yes" });
    expect(denied.status).toBe(303);
    expect(new URL(denied.headers.get("Location")!).searchParams.get("error")).toBe("access_denied");
    expect((await flow.post("/authorize/start", { email: "test@example.com" })).status).toBe(400);
  });
});
