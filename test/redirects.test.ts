import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { localFetch, origin } from "./auth-fixture";

const fetcher = localFetch();
describe("canonical redirects on the MCP host", () => {
  it("sends HTTP visitors to HTTPS and adds HSTS to HTTPS responses", async () => {
    const http = await fetcher(`${origin}/health`, { headers: { "CF-Visitor": '{"scheme":"http"}' } });
    expect(http.status).toBe(301);
    expect(http.headers.get("Location")).toBe(`${origin}/health`);
    const https = await fetcher(`${origin}/health`, { headers: { "CF-Visitor": '{"scheme":"https"}' } });
    expect(https.headers.get("Strict-Transport-Security")).toContain("max-age=31536000");
  });

  it("never redirects an MCP request, and sends website pages to the website", async () => {
    expect((await fetcher(`${origin}/mcp/`, { method: "POST", body: "{}" })).status).not.toBe(301);
    const moved = await fetcher(`${origin}/pricing?ref=x`);
    expect(moved.status).toBe(301);
    expect(moved.headers.get("Location")).toBe(`${env.SITE_ORIGIN}/pricing?ref=x`);
  });
});
