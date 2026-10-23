import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect } from "vitest";
import worker from "../src/index";

export const origin = "https://otis.test";
export const rid = () => crypto.randomUUID();
export function localFetch(bindings: Env = env) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    request.headers.set("Host", new URL(request.url).host);
    return worker.fetch(request as Parameters<typeof worker.fetch>[0], bindings, createExecutionContext());
  };
}
export async function authFlow(options: { email?: string; failEmail?: boolean; redirect?: string; scope?: string; bindings?: Partial<Env> } = {}) {
  const deliveries: { to: string; text: string }[] = [];
  const bindings: Env = { ...env, ...options.bindings, SIGN_IN_ENABLED: "true", EMAIL: { send: async (message: unknown) => {
    if (options.failEmail) throw new Error("Simulated email outage");
    deliveries.push(message as { to: string; text: string });
    return { messageId: "local-only" };
  } } as SendEmail };
  const fetcher = localFetch(bindings);
  const ip = rid();
  const redirect = options.redirect ?? "http://127.0.0.1:8912/callback";
  const registration = await fetcher(`${origin}/oauth/register`, { method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify({ client_name: "Local security checks", redirect_uris: [redirect],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }) });
  expect(registration.status).toBe(201);
  const { client_id } = await registration.json() as { client_id: string };
  const verifier = rid() + rid();
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...hash)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const parameters = new URLSearchParams({ client_id, redirect_uri: redirect, response_type: "code",
    scope: options.scope ?? "otis:records offline_access", state: rid(), code_challenge: challenge,
    code_challenge_method: "S256", resource: `${origin}/mcp` });
  const response = await fetcher(`${origin}/authorize?${parameters}`, { headers: { "CF-Connecting-IP": ip } });
  expect(response.status).toBe(200);
  const html = await response.text();
  const flow = html.match(/name="flow" value="([^"]+)"/)![1];
  const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
  const cookie = response.headers.get("Set-Cookie")!.split(";")[0];
  const post = (path: string, fields: Record<string, string> = {}, headers: Record<string, string> = {}) => fetcher(`${origin}${path}`, {
    method: "POST", headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": ip, ...headers },
    body: new URLSearchParams({ flow, csrf, ...fields })
  });
  const send = () => post("/authorize/start", { email: options.email ?? `${rid()}@example.com` });
  const code = () => deliveries.at(-1)!.text.match(/code is (\d{6})/)![1];
  const tokenRequest = (fields: Record<string, string>) => fetcher(`${origin}/oauth/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id, resource: `${origin}/mcp`, ...fields })
  });
  const exchange = (authorizationCode: string, overrides: Record<string, string> = {}) => tokenRequest({
    grant_type: "authorization_code", redirect_uri: redirect, code: authorizationCode, code_verifier: verifier, ...overrides
  });
  const authorize = async () => {
    expect((await send()).status).toBe(200);
    const verified = await post("/authorize/verify", { code: code() });
    expect(verified.status).toBe(303);
    const callback = new URL(verified.headers.get("Location")!);
    expect(callback.searchParams.get("state")).toBe(parameters.get("state"));
    return callback.searchParams.get("code")!;
  };
  return { fetcher, bindings, deliveries, parameters, response, flow, csrf, cookie, ip, client_id, post, send, code, tokenRequest, exchange, authorize };
}
export async function connected(email?: string, bindings?: Partial<Env>) {
  const flow = await authFlow({ email, bindings });
  const response = await flow.exchange(await flow.authorize());
  expect(response.status).toBe(200);
  const tokens = await response.json() as { access_token: string; refresh_token: string };
  const client = new Client({ name: "otis-local-complete-coverage", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    fetch: flow.fetcher, requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } }
  }));
  return { ...flow, client, tokens };
}
