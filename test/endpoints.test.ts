import { env } from "cloudflare:workers";
import { eu } from "../src/regions";
import { runInDurableObject } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { schemas, READ_OPERATIONS } from "../src/models";
import { authFlow, connected, localFetch, origin, rid } from "./auth-fixture";

const fetcher = localFetch();
describe("MCP host routes", () => {
  it.each(["/", "/how-it-works", "/connect", "/skills", "/pricing", "/docs", "/about", "/privacy", "/terms", "/dpa", "/sitemap.xml", "/robots.txt"])("redirects website page %s to the website", async path => {
    const moved = await fetcher(`${origin}${path}?ref=x`);
    expect(moved.status).toBe(301);
    expect(moved.headers.get("Location")).toBe(`${env.SITE_ORIGIN}${path}?ref=x`);
  });
  it("serves the agent docs, health and the sign-in shell's own assets", async () => {
    for (const [path, type] of [["/llms.txt", "text/plain"], ["/docs/workflows.md", "text/plain"], ["/docs/tax.md", "text/plain"], ["/docs/tools.json", "application/json"], ["/health", "application/json"],
      ["/shell.css", "text/css"], ["/shell.js", "text/javascript"], ["/favicon.svg", "image/svg+xml"], ["/fonts/geist.woff2", "font/woff2"], ["/fonts/geist-mono.woff2", "font/woff2"]]) {
      const response = await fetcher(`${origin}${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("Content-Type"), path).toContain(type);
    }
    expect(Object.keys(await (await fetcher(`${origin}/docs/tools.json`)).json()).sort()).toEqual(Object.keys(schemas).sort());
    expect(await (await fetcher(`${origin}/fonts/geist.woff2`)).headers.get("Cache-Control")).toContain("immutable");
    // The website's own files stay on the website.
    for (const path of ["/site.css", "/site.js", "/og.png", "/ingest/static/array.js"]) expect((await fetcher(`${origin}${path}`)).status, path).toBe(404);
  });
  it("shows the MCP URL to a browser and serves 404s in the sign-in shell", async () => {
    expect((await fetcher(`${origin}/mcp`)).status).toBe(401);
    // A browser visit gets a short page pointing to the setup guides, with the same OAuth challenge.
    const browser = await fetcher(`${origin}/mcp`, { headers: { Accept: "text/html,application/xhtml+xml" } });
    expect(browser.status).toBe(401);
    expect(browser.headers.get("WWW-Authenticate")).toContain("resource_metadata=");
    const html = await browser.text();
    expect(html).toContain("This is the Otis MCP server.");
    expect(html).toContain('data-copy="mcp-url"');
    expect((await fetcher(`${origin}/MCP`)).status).toBe(404);
    expect((await fetcher(`${origin}/no-such-page`)).status).toBe(404);
    const missing = await fetcher(`${origin}/oauth/no-such-page`, { headers: { Accept: "text/html" } });
    expect(missing.status).toBe(404);
    const page = await missing.text();
    expect(page).toContain('href="/shell.css"');
    expect(page).not.toContain("data-cookie-notice");
    expect(page).toContain("There’s nothing at this address.");
    expect(missing.headers.get("Content-Security-Policy")).not.toContain("unsafe-inline");
  });
  it("publishes authorization and protected-resource discovery", async () => {
    const discovery = await fetcher(`${origin}/.well-known/oauth-authorization-server`);
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toMatchObject({ issuer: origin, authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/oauth/token`, registration_endpoint: `${origin}/oauth/register`, revocation_endpoint: `${origin}/oauth/token`,
      code_challenge_methods_supported: ["S256"] });
    const denied = await fetcher(`${origin}/mcp`);
    expect(denied.headers.get("WWW-Authenticate")).toContain(`${origin}/.well-known/oauth-protected-resource/mcp`);
    const response = await fetcher(`${origin}/.well-known/oauth-protected-resource/mcp`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resource: `${origin}/mcp`, authorization_servers: [origin] });
    // This service is mounted at /mcp, not at the origin root.
    expect((await fetcher(`${origin}/.well-known/oauth-protected-resource`)).status).toBe(404);
  });
  it("answers only on the MCP host and rejects unknown routes", async () => {
    expect((await fetcher(`${env.SITE_ORIGIN}/mcp`)).status).toBe(421);
    expect((await fetcher(`${origin}/not-an-endpoint`)).status).toBe(404);
    expect((await fetcher("https://untrusted.test/mcp")).status).toBe(421);
  });
  it("rejects missing/forged authorization on private MCP for every transport method", async () => {
    for (const method of ["GET", "POST", "DELETE"]) for (const authorization of ["", "Bearer invalid", "Basic invalid"]) {
      const response = await fetcher(`${origin}/mcp`, { method, headers: authorization ? { Authorization: authorization } : {} });
      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toContain("resource_metadata");
    }
  });
  it("returns 429 with retry guidance before public work when the limiter denies", async () => {
    const limited = localFetch({ ...env, PUBLIC_REQUESTS: { limit: async () => ({ success: false }) } });
    for (const path of ["/demo/mcp", "/oauth/register", "/authorize", "/authorize/start", "/authorize/verify"]) {
      const response = await limited(`${origin}${path}`);
      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("60");
    }
    expect((await limited(`${origin}/health`)).status).toBe(200);
  });
  it("rejects malformed MCP and an untrusted browser Origin", async () => {
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    expect((await fetcher(`${origin}/demo/mcp`, { method: "POST", headers, body: "{" })).status).toBe(400);
    const response = await fetcher(`${origin}/demo/mcp`, { method: "POST", headers: { ...headers, Origin: "https://attacker.test" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } }) });
    expect(response.status).toBe(403);
  });
  it("rejects malformed registration and invalid token grants without server errors", async () => {
    for (const body of ["{", JSON.stringify({ redirect_uris: ["https://example.com/callback#fragment"] })]) {
      expect((await fetcher(`${origin}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body })).status).toBe(400);
    }
    for (const grant_type of ["authorization_code", "refresh_token", "unsupported"]) {
      const response = await fetcher(`${origin}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type, client_id: "unknown" }) });
      expect([400, 401]).toContain(response.status);
      expect(await response.json()).toHaveProperty("error");
    }
  });
});

describe("sample MCP contract", () => {
  it("executes every advertised demo tool and checks resources/prompts and rejected writes", async () => {
    const client = new Client({ name: "demo-coverage", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/demo/mcp`), { fetch: fetcher }));
    try {
      const tools = (await client.listTools()).tools;
      expect(tools.map(t => t.name).sort()).toEqual([...READ_OPERATIONS].filter(n => !["businesses_list", "team_list"].includes(n)).sort());
      for (const tool of tools) {
        const args = tool.name === "records_export" ? { kind: "business" } : tool.name.startsWith("invoice_") ? { invoice_id: "invoice-1041" } : {};
        const result = await client.callTool({ name: tool.name, arguments: args });
        expect(result.isError, tool.name).not.toBe(true);
        expect(result.structuredContent, tool.name).toMatchObject({ ok: true });
        expect(tool.annotations?.readOnlyHint).toBe(true);
      }
      for (const resource of (await client.listResources()).resources) expect((await client.readResource({ uri: resource.uri })).contents.length).toBeGreaterThan(0);
      for (const prompt of (await client.listPrompts()).prompts) expect((await client.getPrompt({ name: prompt.name })).messages.length).toBeGreaterThan(0);
      await expect(client.callTool({ name: "invoice_issue", arguments: {} })).rejects.toThrow();
      expect((await client.callTool({ name: "invoice_get", arguments: { invoice_id: "absent" } })).isError).toBe(true);
      const invalid = await client.callTool({ name: "billables_list", arguments: { limit: 0 } }).catch(() => ({ isError: true }));
      expect(invalid.isError).toBe(true);
    } finally { await client.close(); }
  });
});

describe("passwordless and OAuth adversarial paths", () => {
  it("binds forms to their cookie and CSRF and never sends on invalid inputs", async () => {
    const f = await authFlow();
    for (const [fields, headers] of [
      [{ csrf: "wrong" }, {}], [{ flow: rid() }, {}], [{}, { Cookie: "" }], [{}, { Cookie: "__Host-otis-connect=wrong" }], [{}, { Origin: "null" }]
    ] as [Record<string, string>, Record<string, string>][]) {
      expect([400, 403]).toContain((await f.post("/authorize/start", { email: "person@example.com", ...fields }, headers)).status);
    }
    expect((await f.post("/authorize/start", { email: "invalid" })).status).toBe(400);
    expect((await f.post("/authorize/start", { email: "x".repeat(5000) })).status).toBe(413);
    expect(f.deliveries).toHaveLength(0);
    expect((await f.post("/authorize/unknown")).status).toBe(404);
  });
  it("sends only once per flow, normalizes identity and consumes a code once under concurrency", async () => {
    const f = await authFlow({ email: "  Person@Example.COM  " });
    expect((await f.send()).status).toBe(200);
    expect((await f.send()).status).toBe(400);
    expect(f.deliveries).toHaveLength(1);
    expect(f.deliveries[0].to).toBe("person@example.com");
    const results = await Promise.all(Array.from({ length: 4 }, () => f.post("/authorize/verify", { code: f.code() })));
    expect(results.filter(r => r.status === 303)).toHaveLength(1);
    expect(results.filter(r => r.status === 400)).toHaveLength(3);
  });
  it("does not authenticate when email delivery fails", async () => {
    const f = await authFlow({ failEmail: true });
    expect((await f.send()).status).toBe(503);
    expect(f.deliveries).toHaveLength(0);
    expect((await f.post("/authorize/verify", { code: "invalid" })).status).toBe(400);
  });
  it("enforces the email delivery window without sending real email", async () => {
    const email = `${rid()}@example.com`;
    for (let i = 0; i < 6; i++) {
      const f = await authFlow({ email });
      const response = await f.send();
      expect(response.status).toBe(i < 5 ? 200 : 429);
      expect(f.deliveries).toHaveLength(i < 5 ? 1 : 0);
    }
  });
  it("enforces the shared IP delivery window across different email identities", async () => {
    const f = await authFlow();
    const { digest } = await import("../src/auth");
    const stub = eu(env.SIGN_INS).getByName(`ip:${await digest(f.ip)}`);
    for (let i = 0; i < 20; i++) expect(await stub.allow(20, 3600000)).toBe(true);
    expect((await f.send()).status).toBe(429);
    expect(f.deliveries).toHaveLength(0);
  });
  it("expires a flow by its deadline even before its alarm runs", async () => {
    const f = await authFlow();
    await runInDurableObject(eu(env.SIGN_INS).getByName(`flow:${f.flow}`), (_instance, state) => {
      const flow = state.storage.kv.get<Record<string, unknown>>("flow")!;
      state.storage.kv.put("flow", { ...flow, expires: Date.now() - 1 });
    });
    expect((await f.send()).status).toBe(400);
    expect(f.deliveries).toHaveLength(0);
  });
  it.each(["redirect_uri", "scope", "resource", "code_challenge_method"])("rejects altered %s before creating a connection", async field => {
    const f = await authFlow();
    const params = new URLSearchParams(f.parameters);
    params.set(field, { redirect_uri: "https://attacker.test/callback", scope: "admin", resource: "https://attacker.test/mcp", code_challenge_method: "plain" }[field]!);
    const response = await f.fetcher(`${origin}/authorize?${params}`, { headers: { "CF-Connecting-IP": rid() } });
    expect(response.status).toBe(400);
    expect(response.headers.has("Location")).toBe(false);
  });
  it("rejects an authorization request without PKCE", async () => {
    const f = await authFlow();
    const params = new URLSearchParams(f.parameters);
    params.delete("code_challenge"); params.delete("code_challenge_method");
    expect((await f.fetcher(`${origin}/authorize?${params}`, { headers: { "CF-Connecting-IP": rid() } })).status).toBe(400);
  });
  it("rejects incorrect PKCE and code replay", async () => {
    const f = await authFlow();
    const code = await f.authorize();
    const invalid = await f.exchange(code, { code_verifier: "incorrect-verifier".repeat(4) });
    expect(invalid.status).toBe(400);
    const g = await authFlow();
    const goodCode = await g.authorize();
    expect((await g.exchange(goodCode)).status).toBe(200);
    expect((await g.exchange(goodCode)).status).toBe(400);
  });
  it.each(["redirect_uri", "resource", "client_id"])("binds authorization-code exchange to its %s", async field => {
    const f = await authFlow();
    const code = await f.authorize();
    const response = await f.exchange(code, { [field]: field === "client_id" ? "unrelated-client" : "https://attacker.test/" });
    expect([400, 401]).toContain(response.status);
    expect(await response.json()).toHaveProperty("error");
  });
  it("refreshes and revokes access and refresh tokens", async () => {
    const s = await connected();
    try {
      const refreshed = await s.tokenRequest({ grant_type: "refresh_token", refresh_token: s.tokens.refresh_token });
      expect(refreshed.status).toBe(200);
      const tokens = await refreshed.json() as { access_token: string; refresh_token: string };
      expect((await s.tokenRequest({ token: tokens.refresh_token, token_type_hint: "refresh_token" })).status).toBe(200);
      expect([400, 401]).toContain((await s.tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token })).status);
      for (const token of [s.tokens.access_token, tokens.access_token]) {
        expect((await s.fetcher(`${origin}/mcp`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
      }
    } finally { await s.client.close(); }
  });
  it("expires an access token after its advertised lifetime", async () => {
    const s = await connected();
    const time = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3601000);
    try {
      expect((await s.fetcher(`${origin}/mcp`, { headers: { Authorization: `Bearer ${s.tokens.access_token}` } })).status).toBe(401);
    } finally { time.mockRestore(); await s.client.close(); }
  });
  it("returns the same business after a fresh sign-in with normalized email", async () => {
    const email = `returning-${rid()}@example.com`;
    const first = await connected(email);
    const second = await connected(`  ${email.toUpperCase()}  `);
    try {
      const saved = await first.client.callTool({ name: "business_set", arguments: { request_id: rid(), name: "Returning business", currency: "USD" } });
      const read = await second.client.callTool({ name: "business_get", arguments: {} });
      expect(read.structuredContent).toMatchObject({ ok: true, data: { name: "Returning business", business_id: (saved.structuredContent as any).data.business_id } });
    } finally { await first.client.close(); await second.client.close(); }
  });
  it("cancels after email delivery and prevents use of that correct code", async () => {
    const f = await authFlow();
    expect((await f.send()).status).toBe(200);
    const response = await f.post("/authorize/verify", { deny: "yes" });
    expect(response.status).toBe(303);
    const callback = new URL(response.headers.get("Location")!);
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.get("state")).toBe(f.parameters.get("state"));
    expect((await f.post("/authorize/verify", { code: f.code() })).status).toBe(400);
  });
});
