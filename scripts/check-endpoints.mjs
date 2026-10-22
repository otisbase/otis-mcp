import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

// Safe to repeat against production: no valid signup, email or business writes.
const origin = process.env.OTIS_ORIGIN ?? 'https://mcp.otisbase.com';
const site = process.env.OTIS_SITE ?? 'https://otisbase.com';
const checks = [];
async function check(label, url, expected, init) {
  const response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  const body = await response.text();
  assert.equal(response.status, expected, `${label}: unexpected HTTP status`);
  checks.push({ label, method: init?.method ?? 'GET', url, status: response.status });
  return { response, body };
}
const jsonHeaders = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
let failure;
try {
  // The website (site) and the MCP service (origin) are separate Workers; both serve the agent docs.
  const toolCounts = [];
  const docs = ['/llms.txt', '/docs/workflows.md', '/docs/tax.md', '/docs/tools.json'];
  for (const [host, paths] of [[site, ['/', '/docs', ...docs]], [origin, ['/health', ...docs]]]) for (const path of paths) {
    const { body } = await check(`Public route ${host}${path}`, `${host}${path}`, 200);
    assert(body.length > 20);
    if (path === '/docs/tools.json') toolCounts.push(Object.keys(JSON.parse(body)).length);
  }
  assert.equal(toolCounts[0], toolCounts[1], 'Both hosts list the same tools');
  const { body: discovery } = await check('OAuth discovery', `${origin}/.well-known/oauth-authorization-server`, 200);
  const metadata = JSON.parse(discovery);
  assert.equal(metadata.issuer, origin);
  assert.equal(metadata.token_endpoint, `${origin}/oauth/token`);
  assert.equal(metadata.revocation_endpoint, `${origin}/oauth/token`);
  const { body: resource } = await check('Protected-resource discovery', `${origin}/.well-known/oauth-protected-resource/mcp`, 200);
  assert.equal(JSON.parse(resource).resource, `${origin}/mcp`);
  await check('No origin-root MCP resource', `${origin}/.well-known/oauth-protected-resource`, 404);
  for (const path of ['/mcp', '/demo/mcp', '/authorize', '/oauth/register', '/oauth/token']) await check('MCP/auth restricted to MCP host', `${site}${path}`, 404);
  await check('Unknown route', `${origin}/not-an-endpoint`, 404);
  for (const method of ['GET', 'POST', 'DELETE']) for (const authorization of ['', 'Bearer invalid']) {
    const { response } = await check('Unauthenticated/forged private access', `${origin}/mcp`, 401, { method, headers: authorization ? { Authorization: authorization } : {} });
    assert(response.headers.get('www-authenticate')?.includes('resource_metadata'));
  }
  await check('Invalid authorization request', `${origin}/authorize`, 400);
  for (const path of ['/authorize/start', '/authorize/verify']) {
    await check('Unbound form rejected; no email', `${origin}${path}`, 400, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'flow=invalid&csrf=invalid' });
    await check('Cross-origin form rejected', `${origin}${path}`, 403, { method: 'POST', headers: { Origin: 'https://example.com' }, body: '' });
  }
  await check('Oversized form rejected', `${origin}/authorize/start`, 413, { method: 'POST', headers: { Origin: origin }, body: 'x'.repeat(4097) });
  await check('Invalid JSON registration', `${origin}/oauth/register`, 400, { method: 'POST', headers: jsonHeaders, body: '{' });
  await check('Invalid redirect registration', `${origin}/oauth/register`, 400, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ redirect_uris: ['https://example.com/#fragment'] }) });
  for (const grant_type of ['authorization_code', 'refresh_token', 'unsupported']) {
    const response = await fetch(`${origin}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type, client_id: 'invalid-client' }), signal: AbortSignal.timeout(15000) });
    assert([400, 401].includes(response.status));
    assert((await response.json()).error);
    checks.push({ label: `Invalid ${grant_type} rejected`, method: 'POST', url: `${origin}/oauth/token`, status: response.status });
  }
  await check('Malformed demo MCP', `${origin}/demo/mcp`, 400, { method: 'POST', headers: jsonHeaders, body: '{' });
  await check('Hostile browser Origin on MCP', `${origin}/demo/mcp`, 403, { method: 'POST', headers: { ...jsonHeaders, Origin: 'https://example.com' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'otis-endpoint-check', version: '1' } } }) });
  const client = new Client({ name: 'otis-endpoint-check', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/demo/mcp`)));
  try {
    const tools = (await client.listTools()).tools;
    // Every read tool except businesses_list and team_list, timers_list included.
    assert.equal(tools.length, 12);
    assert(tools.some(t => t.name === 'timers_list'));
    assert(client.getInstructions().includes('otis_menu'));
    for (const tool of tools) {
      const args = tool.name === 'records_export' ? { kind: 'business' } : tool.name.startsWith('invoice_') ? { invoice_id: 'sample-invoice' } : {};
      const result = await client.callTool({ name: tool.name, arguments: args });
      assert.notEqual(result.isError, true, tool.name);
      assert.equal(result.structuredContent.ok, true);
      assert.equal(tool.annotations.readOnlyHint, true);
      if (tool.name === 'otis_menu') {
        const menu = result.structuredContent.data;
        assert.equal(menu.demo, true);
        assert.equal(menu.options.length, 10);
        assert(!menu.text.includes('&'));
        assert.equal(menu.connection_url, `${origin}/mcp`);
        assert(menu.text.includes('Sample demo'));
        for (const option of menu.options) for (const name of option.tools) assert(tools.some(t => t.name === name));
      }
      checks.push({ label: `Demo tool ${tool.name}`, passed: true });
    }
    for (const country of ['US', 'CA', 'GB', 'AU']) {
      assert.notEqual((await client.callTool({ name: 'tax_guide', arguments: { country } })).isError, true);
      checks.push({ label: `Tax guidance ${country}`, passed: true });
    }
    for (const resource of (await client.listResources()).resources) {
      assert((await client.readResource({ uri: resource.uri })).contents.length > 0);
      checks.push({ label: `Resource ${resource.uri}`, passed: true });
    }
    const prompts = (await client.listPrompts()).prompts;
    assert(prompts.some(p => p.name === 'otis' && p.title === 'Otis menu'));
    const workflowNames = ['create-invoice', 'record-work', 'add-expense', 'clients', 'invoices', 'payments', 'team', 'business-settings', 'tax-settings', 'export'];
    assert.deepEqual(prompts.map(p => p.name).sort(), ['otis', 'setup-business', 'invoices-and-payments', ...workflowNames].sort());
    for (const prompt of prompts) {
      const messages = (await client.getPrompt({ name: prompt.name })).messages;
      assert(messages.length > 0);
      if (prompt.name === 'otis') {
        assert(messages[0].content.text.includes('10. Export'));
        assert(messages[0].content.text.includes('Sample demo'));
      }
      if (workflowNames.includes(prompt.name)) {
        assert(messages[0].content.text.includes('read-only fictional sample demo'));
        assert(messages[0].content.text.includes('does not approve unspecified writes or invoice issuance'));
      }
      checks.push({ label: `Prompt ${prompt.name}`, passed: true });
    }
    await assert.rejects(() => client.callTool({ name: 'invoice_issue', arguments: {} }));
    checks.push({ label: 'Demo rejects private write tools', passed: true });
  } finally { await client.close(); }
} catch (error) { failure = error; }
const report = { completed_at: new Date().toISOString(), status: failure ? 'failed' : 'passed', origin, site,
  no_real_email_or_business_writes: true, checks, ...(failure ? { failure: failure.message } : {}) };
const reportUrl = new URL('../reports/endpoint-check-latest.json', import.meta.url);
await mkdir(new URL('./', reportUrl), { recursive: true });
await writeFile(reportUrl, JSON.stringify(report, null, 2) + '\n');
console.log(`${report.status.toUpperCase()}: ${checks.length} checks; report ${reportUrl.pathname}`);
if (failure) { console.error(failure.message); process.exitCode = 1; }
