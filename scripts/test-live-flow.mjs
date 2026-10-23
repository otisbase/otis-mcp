// Real browser OAuth + public MCP only. Requires explicit approval for the two
// recipient addresses and permanent, fictional records described in qa-plan.json.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const plan = JSON.parse(await readFile(new URL('./qa-plan.json', import.meta.url), 'utf8'));
if (process.argv.includes('--plan')) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}
assert(process.argv.includes('--approved-test-writes'), 'Explicit approval for fictional live records is required.');
const ownerEmail = process.env.OTIS_QA_OWNER_EMAIL;
const memberEmail = process.env.OTIS_QA_MEMBER_EMAIL;
assert(ownerEmail && memberEmail && ownerEmail !== memberEmail, 'Supply two explicitly approved, distinct QA email addresses.');
const origin = process.env.OTIS_ORIGIN ?? 'https://mcp.otisbase.com';
const runId = randomUUID();
const checks = [];
const sessions = [];
const pending = new Map();
const called = new Set();
const artifacts = {};
const reportDir = new URL('../reports/', import.meta.url);
const pass = message => { checks.push(message); console.log(`PASS ${message}`); };
const rid = () => randomUUID();
let liveMember;
let owner;
let member;
let failure;

// The browser callback never exposes access/refresh tokens. They remain in this process.
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:8913');
  const task = pending.get(url.pathname);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  if (url.pathname === '/connected') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><title>Otis QA connected</title><h1>Otis QA connected</h1><p>The test runner has received this connection. You can return to Codex.</p>');
    return;
  }
  if (req.method !== 'GET' || !task || url.searchParams.get('state') !== task.state || !url.searchParams.get('code')) {
    res.writeHead(400); res.end('Invalid QA callback.'); return;
  }
  pending.delete(url.pathname);
  res.writeHead(303, { Location: '/connected' }); res.end();
  try {
    const response = await fetch(`${origin}/oauth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: task.clientId,
        redirect_uri: task.redirect, code: url.searchParams.get('code'), code_verifier: task.verifier,
        resource: `${origin}/mcp` })
    });
    assert.equal(response.status, 200, `${task.role} PKCE exchange`);
    const tokens = await response.json();
    assert(tokens.access_token && tokens.refresh_token, 'Expected access and refresh tokens');
    task.resolve({ role: task.role, clientId: task.clientId, tokens });
  } catch (error) { task.reject(error); }
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(8913, '127.0.0.1', resolve);
});

async function connect(tokens, label) {
  const client = new Client({ name: `otis-qa-${label}`, version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } }
  }));
  return client;
}

async function authenticate(role, email) {
  const redirect = `http://127.0.0.1:8913/callback/${role}`;
  const response = await fetch(`${origin}/oauth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: `Otis QA — ${role}`, redirect_uris: [redirect],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      token_endpoint_auth_method: 'none' })
  });
  assert.equal(response.status, 201, `${role} client registration`);
  const registration = await response.json();
  const verifier = randomBytes(48).toString('base64url');
  const state = randomBytes(24).toString('base64url');
  const query = new URLSearchParams({ client_id: registration.client_id, redirect_uri: redirect,
    response_type: 'code', scope: 'otis:records offline_access', state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', resource: `${origin}/mcp` });
  const session = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${role} browser sign-in timed out`)), 20 * 60_000);
    pending.set(`/callback/${role}`, { state, verifier, redirect, role, clientId: registration.client_id,
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); } });
    console.log(`BROWSER_SIGN_IN ${role} ${email}\n${origin}/authorize?${query}`);
  });
  sessions.push(session);
  session.client = await connect(session.tokens, role);
  pass(`${role}: real browser email verification, consent and PKCE connection`);
  return session;
}

async function raw(session, name, args = {}) {
  called.add(name);
  const result = await session.client.callTool({ name, arguments: args });
  assert(result.structuredContent, `${name} must provide structured content`);
  assert.equal(result.isError === true, result.structuredContent.ok === false, `${name} error signaling`);
  return result.structuredContent;
}
async function call(session, name, args = {}) {
  const result = await raw(session, name, args);
  assert.equal(result.ok, true, `${name}: ${result.code ?? ''} ${result.message ?? ''}`);
  return result.data;
}
async function rejected(session, name, args, code) {
  const result = await raw(session, name, args);
  assert.equal(result.ok, false, `${name} must reject the action`);
  assert.equal(result.code, code, `${name} expected ${code}`);
  return result;
}
async function allPages(session, name, extra = {}, limit = 2) {
  const records = [];
  let offset = 0;
  for (let page = 0; page < 500; page++) {
    const result = await call(session, name, { ...extra, limit, offset });
    records.push(...result.records);
    if (result.next_offset === null) return records;
    assert(result.next_offset > offset, `${name} pagination must advance`);
    offset = result.next_offset;
  }
  throw new Error(`${name} pagination did not terminate`);
}

try {
  owner = await authenticate('owner', ownerEmail);
  member = await authenticate('member', memberEmail);
  assert.equal((await call(owner, 'business_get')).setup_required, true, 'QA owner must have an empty business');
  assert.equal((await call(member, 'business_get')).setup_required, true, 'QA teammate must have an empty business');
  const tools = await owner.client.listTools();
  artifacts.tool_names = tools.tools.map(t => t.name);
  assert.equal(tools.tools.length, 25);
  assert.equal((await call(owner, 'otis_menu')).options.length, 9);
  assert((await owner.client.getPrompt({ name: 'otis' })).messages[0].content.text.includes('9. Export'));
  const resources = await owner.client.listResources();
  assert(resources.resources.some(r => r.uri === 'otis://docs/workflows'));
  assert((await owner.client.readResource({ uri: 'otis://docs/workflows' })).contents[0].text.includes('request_id'));
  assert((await owner.client.getPrompt({ name: 'setup-business' })).messages.length);
  pass('Private tool discovery, workflow resource and setup prompt');
  const profile = { request_id: rid(), name: plan.business_name, currency: plan.currency,
    billing_address: plan.billing_address,
    invoice_preferences: { prefix: plan.invoice_prefix, number_padding: 4, starting_number: 1,
      default_note: plan.note, payment_instructions: 'QA ONLY — do not transfer money.' } };
  const business = await call(owner, 'business_set', profile);
  const businessId = business.business_id;
  artifacts.business_id = businessId;
  assert.deepEqual(await call(owner, 'business_set', profile), business);
  await rejected(owner, 'business_set', { ...profile, name: 'Conflicting retry' }, 'IDEMPOTENCY_CONFLICT');
  pass('Isolated business setup and write retry/conflict handling');
  const client = await call(owner, 'client_save', { request_id: rid(), name: plan.client_name });
  const timeInput = { request_id: rid(), client_id: client.id, kind: 'time',
    description: 'QA ONLY — fictional consulting hours', quantity: '9', unit: 'hour',
    rate_minor: 10000, amount_minor: 90000 };
  await rejected(owner, 'billable_record', { ...timeInput, request_id: rid(), amount_minor: 90001 }, 'AMOUNT_MISMATCH');
  const time = await call(owner, 'billable_record', timeInput);
  const correctedTime = { ...timeInput, request_id: rid(), item_id: time.id, quantity: '10', amount_minor: plan.time_amount_minor };
  await call(owner, 'billable_record', correctedTime);
  const draft = (lines, extra = {}) => call(owner, 'invoice_draft', { request_id: rid(), client_id: client.id,
    supply_date: plan.supply_date, due_date: plan.due_date, lines, ...extra });
  const cancel = invoice => call(owner, 'invoice_cancel_draft', { request_id: rid(), invoice_id: invoice.id, reason: 'QA ONLY — test reservation release' });
  const incomplete = await draft([{ item_id: time.id, amount_minor: 10000 }]);
  const missing = await call(owner, 'invoice_check', { invoice_id: incomplete.id });
  assert.equal(missing.ready, false);
  assert(missing.blockers.some(b => b.field.includes('tax')));
  assert(missing.blockers.every(b => b.message && b.next_tool));
  await rejected(owner, 'invoice_issue', { request_id: rid(), invoice_id: incomplete.id, expected_total_minor: 10000, confirmed: true }, 'INVOICE_NOT_READY');
  await cancel(incomplete);
  pass('Missing business/client/tax facts give actionable feedback and block issuance');
  for (const country of ['US', 'CA', 'GB', 'AU']) {
    const guide = await call(owner, 'tax_guide', { country });
    assert(guide.guidance);
  }
  await call(owner, 'tax_profile_set', { request_id: rid(), profile: { country: 'GB',
    registration_status: 'registered', registrations: [{ jurisdiction: 'GB', number: plan.tax_registration, effective_from: '2026-01-01' }],
    reviewed_on: plan.supply_date, notes: plan.note } });
  const clientInput = { client_id: client.id, name: plan.client_name, country: 'GB',
    customer_type: 'business', billing_address: plan.client_address, tax_evidence: plan.note };
  await call(owner, 'client_save', { ...clientInput, request_id: rid() });
  const tax = { treatment: 'taxable', jurisdiction: 'GB', reason: plan.note,
    service_category: 'Fictional software-test consulting', mode: 'exclusive', components: [{ name: 'QA VAT example', rate_ppm: 200000 }] };
  pass('Four country guides and explicit fictional seller/customer/tax setup');
  await call(owner, 'expense_record', { request_id: rid(), vendor: 'QA Office Supplies', category: 'office',
    description: plan.note, incurred_on: plan.supply_date, cost_minor: 500 });
  const expenseInput = { request_id: rid(), vendor: 'QA Travel', category: 'travel', description: plan.note,
    incurred_on: plan.supply_date, cost_minor: 10000, client_id: client.id, billable_amount_minor: 14000 };
  const expense = await call(owner, 'expense_record', expenseInput);
  assert.equal((await call(owner, 'expense_record', expenseInput)).id, expense.id);
  const expenseEdit = { ...expenseInput, request_id: rid(), expense_id: expense.id, cost_minor: 11000, billable_amount_minor: plan.expense_amount_minor };
  assert.equal((await call(owner, 'expense_record', expenseEdit)).billable_id, expense.billable_id);
  const aiInput = { request_id: rid(), client_id: client.id, kind: 'ai_usage', description: plan.note,
    quantity: '100000', unit: 'tokens', amount_minor: plan.ai_amount_minor, cost_minor: 500 };
  await rejected(owner, 'billable_record', aiInput, 'MEASUREMENT_REQUIRED');
  const ai = await call(owner, 'billable_record', { ...aiInput, request_id: rid(), measurement: 'estimated' });
  assert.equal((await allPages(owner, 'billables_list')).length, 3);
  assert.equal((await allPages(owner, 'expenses_list')).length, 2);
  await rejected(owner, 'business_set', { ...profile, request_id: rid(), currency: 'USD' }, 'CURRENCY_LOCKED');
  pass('Time edits, expense linking/edits, AI measurement labels, list pagination and currency lock');
  const stale = await draft([{ item_id: time.id, amount_minor: 10000, tax }]);
  clientInput.billing_address += ' — revised QA address';
  await call(owner, 'client_save', { ...clientInput, request_id: rid() });
  assert((await call(owner, 'invoice_check', { invoice_id: stale.id })).blockers.some(b => b.field === 'snapshot'));
  await cancel(stale);
  pass('Changing client facts makes an existing draft stale');
  const racing = await Promise.all([1, 2].map(() => raw(owner, 'invoice_draft', {
    request_id: rid(), client_id: client.id, supply_date: plan.supply_date, due_date: plan.due_date,
    lines: [{ item_id: time.id, amount_minor: 60000, tax }] })));
  assert.equal(racing.filter(r => r.ok).length, 1);
  assert.equal(racing.find(r => !r.ok).code, 'ALLOCATION_CONFLICT');
  await cancel(racing.find(r => r.ok).data);
  await rejected(owner, 'invoice_draft', { request_id: rid(), client_id: client.id,
    supply_date: plan.supply_date, due_date: plan.due_date,
    lines: [{ item_id: time.id, amount_minor: 50000, tax }, { item_id: 'qa-missing-item', amount_minor: 1, tax }] }, 'NOT_FOUND');
  assert.equal((await allPages(owner, 'billables_list')).find(r => r.id === time.id).remaining_minor, 100000);
  pass('Concurrent over-allocation rejected; failed multi-line draft rolls back all reservations');
  const first = await draft([
    { item_id: time.id, amount_minor: 50000, discount: { kind: 'percent', rate_ppm: 100000 }, tax },
    { item_id: expense.billable_id, amount_minor: plan.expense_amount_minor, tax },
    { item_id: ai.id, amount_minor: plan.ai_amount_minor, tax }
  ], { discount: { kind: 'fixed', amount_minor: 6500 } });
  for (const [field, expected] of Object.entries({ subtotal_minor: 70000, discount_minor: 11500, net_minor: 58500, tax_minor: 11700, total_minor: 70200 })) assert.equal(first[field], expected, field);
  assert.equal(first.number, undefined);
  assert.equal(first.note, plan.note);
  assert.equal((await call(owner, 'invoice_check', { invoice_id: first.id })).ready, true);
  await rejected(owner, 'billable_record', { ...correctedTime, request_id: rid() }, 'ITEM_LOCKED');
  await rejected(owner, 'expense_record', { ...expenseEdit, request_id: rid() }, 'ITEM_LOCKED');
  await rejected(owner, 'invoice_issue', { request_id: rid(), invoice_id: first.id, expected_total_minor: 70201, confirmed: true }, 'TOTAL_CHANGED');
  const issueInput = { request_id: rid(), invoice_id: first.id, expected_total_minor: 70200, confirmed: true };
  const issued = await Promise.all([call(owner, 'invoice_issue', issueInput), call(owner, 'invoice_issue', issueInput)]);
  assert.equal(issued[0].number, 1);
  assert.equal(issued[0].display_number, 'QA-ONLY-0001');
  assert.deepEqual(issued[0], issued[1]);
  await rejected(owner, 'invoice_cancel_draft', { request_id: rid(), invoice_id: first.id, reason: 'QA immutability test' }, 'DRAFT_REQUIRED');
  await rejected(owner, 'business_set', { ...profile, request_id: rid(), invoice_preferences: { ...profile.invoice_preferences, starting_number: 2 } }, 'NUMBERING_LOCKED');
  pass('£702 first invoice: partial work, line/invoice discounts, tax, approval-total guard and single numbering under retries');
  clientInput.name += ' — later edit';
  await call(owner, 'client_save', { ...clientInput, request_id: rid() });
  const fixed = await call(owner, 'invoice_get', { invoice_id: first.id });
  assert.equal(fixed.client_snapshot.name, plan.client_name);
  assert.equal(fixed.lines[0].source_snapshot.amount_minor, 100000);
  assert.equal(fixed.lines[0].amount_minor, 50000);
  const remaining = (await allPages(owner, 'billables_list')).find(r => r.id === time.id);
  assert.equal(remaining.remaining_minor, 50000);
  assert.equal(remaining.invoiced_minor, 50000);
  pass('Issued snapshots remain unchanged; discounts do not reopen source amounts for billing');
  const paymentInput = { invoice_id: first.id, amount_minor: plan.first_payment_minor,
    received_on: plan.supply_date, reference: `QA-ONLY-${runId}-payment-1` };
  const payments = await Promise.all([1, 2].map(() => call(owner, 'payment_record', { ...paymentInput, request_id: rid() })));
  assert.equal(payments[0].id, payments[1].id);
  await rejected(owner, 'payment_record', { ...paymentInput, request_id: rid(), amount_minor: 1 }, 'PAYMENT_REFERENCE_CONFLICT');
  assert.equal((await call(owner, 'invoice_get', { invoice_id: first.id })).balance_minor, 45200);
  await rejected(owner, 'payment_record', { ...paymentInput, request_id: rid(), reference: `QA-ONLY-${runId}-overpayment`, amount_minor: 45201 }, 'OVERPAYMENT');
  await call(owner, 'payment_record', { ...paymentInput, request_id: rid(), reference: `QA-ONLY-${runId}-payment-2`, amount_minor: plan.second_payment_minor });
  assert.equal((await call(owner, 'invoice_get', { invoice_id: first.id })).balance_minor, 0);
  assert.equal((await allPages(owner, 'payments_list')).length, 2);
  pass('Partial payment, duplicate-reference race, conflict/overpayment rejection and full settlement');
  const inclusive = await draft([{ item_id: time.id, amount_minor: 12000, tax: { ...tax, mode: 'inclusive' } }]);
  assert.equal(inclusive.net_minor, 10000); assert.equal(inclusive.tax_minor, 2000); assert.equal(inclusive.total_minor, 12000);
  await cancel(inclusive);
  const second = await draft([{ item_id: time.id, amount_minor: 50000, tax }]);
  assert.equal(second.total_minor, 60000);
  const secondIssued = await call(owner, 'invoice_issue', { request_id: rid(), invoice_id: second.id, expected_total_minor: 60000, confirmed: true });
  assert.equal(secondIssued.number, 2);
  assert((await allPages(owner, 'billables_list')).every(r => r.remaining_minor === 0 && r.reserved_minor === 0));
  await rejected(owner, 'invoice_draft', { request_id: rid(), client_id: client.id, supply_date: plan.supply_date,
    due_date: plan.due_date, lines: [{ item_id: time.id, amount_minor: 1, tax }] }, 'ALLOCATION_CONFLICT');
  assert.equal((await allPages(owner, 'invoices_list', { status: 'issued' })).length, 2);
  pass('Inclusive-tax draft, cancellation/release and £600 final invoice consume the remaining work exactly once');
  // Teams are off in production (TEAM_ENABLED "false"): no team tools, and a second identity never reaches this business.
  for (const name of ['team_list', 'team_invite', 'team_accept', 'team_member_set']) assert(!tools.tools.some(t => t.name === name), `${name} must not be offered`);
  await rejected(member, 'business_get', { business_id: businessId }, 'FORBIDDEN');
  await rejected(member, 'client_save', { request_id: rid(), business_id: businessId, name: 'QA ONLY — Shared client' }, 'FORBIDDEN');
  assert(!(await allPages(member, 'businesses_list')).some(b => b.business_id === businessId));
  pass('Two real identities: no team tools, and the second identity cannot read or change the first business');
  artifacts.exports = {};
  for (const kind of ['business', 'client', 'billable', 'expense', 'invoice', 'payment', 'audit']) {
    artifacts.exports[kind] = await allPages(owner, 'records_export', { kind });
  }
  assert.equal((await allPages(owner, 'clients_list')).length, 1);
  assert.equal(artifacts.exports.payment.length, 2);
  assert(artifacts.exports.audit.some(a => a.operation === 'invoice_issue'));
  assert(artifacts.exports.audit.some(a => a.operation === 'team_member_set'));
  assert.equal((await call(member, 'business_get')).setup_required, true);
  artifacts.invoices = [await call(owner, 'invoice_get', { invoice_id: first.id }), await call(owner, 'invoice_get', { invoice_id: second.id })];
  pass('All record/audit exports paginate; test teammate has no personal business records');
  await owner.client.close();
  owner.client = await connect(owner.tokens, 'reconnected-owner');
  assert.equal((await call(owner, 'invoice_get', { invoice_id: first.id })).balance_minor, 0);
  assert.equal((await call(owner, 'invoice_get', { invoice_id: second.id })).balance_minor, 60000);
  assert.deepEqual([...called].sort(), [...artifacts.tool_names].sort());
  pass('Reconnect preserves data; all 25 private tools exercised through live MCP');
} catch (error) {
  failure = error;
  console.error(`FAIL ${error.message}`);
} finally {
  // Remove test teammate access even if a later assertion failed.
  if (liveMember && owner?.client) {
    try { await call(owner, 'team_member_set', { request_id: rid(), member_id: liveMember, role: 'removed' }); }
    catch { checks.push('ATTENTION: QA teammate cleanup failed; inspect membership.'); }
  }
  const metadata = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json().catch(() => ({}));
  for (const session of sessions) {
    try {
      await session.client?.close();
      const refresh = await fetch(`${origin}/oauth/token`, { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: session.clientId,
          refresh_token: session.tokens.refresh_token, resource: `${origin}/mcp` }) });
      assert.equal(refresh.status, 200, `${session.role} refresh`);
      session.tokens = await refresh.json();
      assert(metadata.revocation_endpoint, 'Revocation endpoint must be advertised');
      const revoke = await fetch(metadata.revocation_endpoint, { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: session.clientId, token: session.tokens.refresh_token, token_type_hint: 'refresh_token' }) });
      assert.equal(revoke.status, 200, `${session.role} revocation`);
      const replay = await fetch(`${origin}/oauth/token`, { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: session.clientId,
          refresh_token: session.tokens.refresh_token, resource: `${origin}/mcp` }) });
      assert([400, 401].includes(replay.status), `${session.role} revoked refresh token must fail`);
      pass(`${session.role}: token refresh, revocation and rejected reuse`);
    } catch (error) { failure ??= error; checks.push(`FAIL ${session.role} auth cleanup: ${error.message}`); }
  }
  server.close();
  await mkdir(reportDir, { recursive: true });
  const report = { run_id: runId, completed_at: new Date().toISOString(), origin, status: failure ? 'failed' : 'passed',
    plan, checks, tools_exercised: [...called].sort(), ...artifacts, failure: failure?.message };
  const reportPath = new URL(`qa-${runId}.json`, reportDir);
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  const money = value => `£${(value / 100).toFixed(2)}`;
  const documents = (artifacts.invoices ?? []).map(invoice => [
    `# ${invoice.display_number} — SOFTWARE TEST ONLY`, '', plan.note, '',
    `Business: ${invoice.business_snapshot.name}`, `Client: ${invoice.client_snapshot.name}`, '',
    '| Source | Allocated | Discounts | Net | Tax | Total |', '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...invoice.lines.map(line => `| ${line.source_snapshot.kind} | ${money(line.amount_minor)} | ${money(line.line_discount_minor + line.invoice_discount_minor)} | ${money(line.net_minor)} | ${money(line.tax_minor)} | ${money(line.total_minor)} |`),
    '', `**Total: ${money(invoice.total_minor)}. Reported paid: ${money(invoice.paid_minor)}. Balance: ${money(invoice.balance_minor)}.**`, '',
    `Supply date: ${invoice.supply_date}. Due date: ${invoice.due_date}.`,
    'Generated from the authoritative issued MCP snapshot. No document was sent and no money moved.', ''
  ].join('\n')).join('\n---\n\n');
  if (documents) await writeFile(new URL(`qa-${runId}-invoices.md`, reportDir), documents);
  console.log(`REPORT ${reportPath.pathname}`);
  process.exitCode = failure ? 1 : 0;
}
