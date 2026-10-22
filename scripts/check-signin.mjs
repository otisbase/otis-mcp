// Sends ONE real sign-in email to an explicitly approved recipient supplied on the command line.
// Tokens, codes and cookies stay in process memory and are never logged or written to disk.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import readline from 'node:readline/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const origin = process.env.OTIS_ORIGIN ?? 'https://mcp.otisbase.com';
const email = process.argv[2];
assert(email, 'Pass the explicitly approved test email address.');
const redirect = 'http://127.0.0.1:8912/otis-release-check';
const registrationResponse = await fetch(`${origin}/oauth/register`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ client_name: 'Otis release verification', redirect_uris: [redirect], grant_types: ['authorization_code','refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' })
});
assert.equal(registrationResponse.status, 201, 'OAuth client registration');
const registration = await registrationResponse.json();
const verifier = randomBytes(48).toString('base64url');
const state = randomBytes(24).toString('base64url');
const query = new URLSearchParams({ client_id: registration.client_id, redirect_uri: redirect, response_type: 'code', scope: 'otis:records offline_access', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: `${origin}/mcp` });
const begin = await fetch(`${origin}/authorize?${query}`, { redirect: 'manual' });
assert.equal(begin.status, 200, 'Sign-in page');
const html = await begin.text();
const flow = html.match(/name="flow" value="([^"]+)"/)[1];
const csrf = html.match(/name="csrf" value="([^"]+)"/)[1];
const cookie = begin.headers.get('set-cookie').split(';')[0];
const post = (path, values) => fetch(`${origin}${path}`, { method: 'POST', redirect: 'manual', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ flow, csrf, ...values }) });
const sent = await post('/authorize/start', { email });
assert.equal(sent.status, 200, 'Email send and code form');
console.log('EMAIL_SENT: one sign-in email accepted by Cloudflare. Waiting for delivery verification; code is not logged.');
const input = readline.createInterface({ input: process.stdin, terminal: false });
const code = await input.question('');
input.close();
assert(/^\d{6}$/.test(code.trim()), 'Expected a six-digit code from the approved test email');
const verified = await post('/authorize/verify', { code: code.trim() });
assert.equal(verified.status, 303, 'Verification');
const callback = new URL(verified.headers.get('location'));
assert.equal(callback.searchParams.get('state'), state, 'OAuth state');
const exchanged = await fetch(`${origin}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: registration.client_id, redirect_uri: redirect, code: callback.searchParams.get('code'), code_verifier: verifier, resource: `${origin}/mcp` }) });
assert.equal(exchanged.status, 200, 'PKCE token exchange');
const tokens = await exchanged.json();
assert(tokens.access_token && tokens.refresh_token);
console.log('PASS delivered email, single-use verification and PKCE token exchange');
const client = new Client({ name: 'otis-private-release-check', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }));
try {
  const list = await client.listTools();
  assert(list.tools.some(t => t.name === 'invoice_issue'));
  const result = await client.callTool({ name: 'business_get', arguments: {} });
  assert.equal(result.structuredContent.ok, true);
  console.log(`PASS authenticated MCP: ${list.tools.length} tools and business_get. No business profile, work, invoice or payment was created.`);
} finally { await client.close(); }
const refreshed = await fetch(`${origin}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: registration.client_id, resource: `${origin}/mcp` }) });
assert.equal(refreshed.status, 200, 'Refresh token');
const latest = await refreshed.json();
assert(latest.access_token);
const replay = await post('/authorize/verify', { code: code.trim() });
assert.equal(replay.status, 400, 'Code replay must fail');
console.log('PASS token refresh and code replay rejection');
// If supported, revoke the test authorization so verification leaves no reusable credentials.
const metadata = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json();
if (metadata.revocation_endpoint) {
  const revoked = await fetch(metadata.revocation_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: latest.refresh_token ?? tokens.refresh_token, token_type_hint: 'refresh_token', client_id: registration.client_id }) });
  assert.equal(revoked.status, 200, 'Test authorization revocation');
  console.log('PASS test authorization revocation');
} else console.log('NOTE no standard revocation endpoint advertised; test tokens were held only in process memory.');
