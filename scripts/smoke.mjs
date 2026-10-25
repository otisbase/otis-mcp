import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const origin = process.env.OTIS_ORIGIN ?? 'https://mcp.otisbase.com';
const site = process.env.OTIS_SITE ?? 'https://otisbase.com';
for (const path of ['/', '/docs', '/llms.txt', '/docs/workflows.md', '/docs/tax.md', '/docs/tools.json']) {
  const response = await fetch(`${site}${path}`);
  assert.equal(response.status, 200, `${path} should load`);
  const body = await response.text();
  assert(body.length > 100, `${path} should contain documentation`);
  console.log(`PASS ${site}${path}`);
}
const denied = await fetch(`${origin}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
assert.equal(denied.status, 401);
assert(denied.headers.get('www-authenticate')?.includes('resource_metadata'));
console.log('PASS private MCP rejects unauthenticated access');
const metadata = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json();
assert.equal(metadata.issuer, origin);
assert.equal(metadata.authorization_endpoint, `${origin}/authorize`);
console.log('PASS OAuth discovery');
const client = new Client({ name: 'otis-release-smoke', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/demo/mcp`)));
try {
  const { tools } = await client.listTools();
  assert(tools.some(t => t.name === 'billables_list'));
  assert(!tools.some(t => t.name === 'invoice_issue'));
  const result = await client.callTool({ name: 'billables_list', arguments: { state: 'unbilled' } });
  assert.equal(result.structuredContent.demo, true);
  assert.equal(result.structuredContent.ok, true);
  const invoice = await client.callTool({ name: 'invoice_get', arguments: { invoice_id: 'invoice-1041' } });
  assert.equal(invoice.structuredContent.data.balance_minor, 60000);
  const guide = await client.callTool({ name: 'tax_guide', arguments: { country: 'GB' } });
  assert.equal(guide.structuredContent.data.guidance.title, 'United Kingdom');
  const { resources } = await client.listResources();
  assert(resources.some(r => r.uri === 'otis://docs/workflows'));
  const resource = await client.readResource({ uri: 'otis://docs/tax' });
  assert(resource.contents[0].text.includes('Canada'));
  const prompt = await client.getPrompt({ name: 'setup-business' });
  assert(prompt.messages.length > 0);
  console.log(`PASS real MCP client: ${tools.length} public tools, demo reads, tax guide, resources and setup prompt`);
} finally { await client.close(); }
