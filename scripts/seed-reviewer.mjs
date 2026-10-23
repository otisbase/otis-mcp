// Fill the directory reviewer's business with the Northstar Studio records (the demo account in src/demo.ts),
// through the real sign-in and the real MCP tools, so reviewers test a fully populated private account.
// Signs in with the REVIEW_EMAIL / REVIEW_CODE Worker secrets; refuses to run if that business is already set up.
//
//   OTIS_REVIEW_EMAIL=review@otisbase.com OTIS_REVIEW_CODE=123456 node scripts/seed-reviewer.mjs
//
// OTIS_ORIGIN defaults to https://mcp.otisbase.com. To try it on `npm run dev` first, set OTIS_TARGET to the local
// address (for example http://127.0.0.1:8788) and keep OTIS_ORIGIN, which wrangler dev serves as its route.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const origin = process.env.OTIS_ORIGIN ?? 'https://mcp.otisbase.com';
const target = process.env.OTIS_TARGET ?? origin;
const email = process.env.OTIS_REVIEW_EMAIL;
const code = process.env.OTIS_REVIEW_CODE;
assert(email && /^\d{6}$/.test(code ?? ''), 'Set OTIS_REVIEW_EMAIL and the six-digit OTIS_REVIEW_CODE.');

async function signIn() {
  const redirect = 'http://127.0.0.1:8913/callback';
  const registration = await fetch(`${target}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Otis reviewer seed', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], token_endpoint_auth_method: 'none' }) });
  assert.equal(registration.status, 201, 'client registration');
  const { client_id } = await registration.json();
  const verifier = randomBytes(48).toString('base64url');
  const query = new URLSearchParams({ client_id, redirect_uri: redirect, response_type: 'code', scope: 'otis:records', state: randomUUID(),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: `${origin}/mcp` });
  const page = await fetch(`${target}/authorize?${query}`);
  assert.equal(page.status, 200, 'authorization page');
  const html = await page.text();
  const flow = html.match(/name="flow" value="([^"]+)"/)[1], csrf = html.match(/name="csrf" value="([^"]+)"/)[1];
  const cookie = page.headers.get('set-cookie').split(';')[0];
  const post = (path, fields) => fetch(`${target}${path}`, { method: 'POST', redirect: 'manual',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ flow, csrf, ...fields }) });
  assert.equal((await post('/authorize/start', { email })).status, 200, 'reviewer email accepted');
  const verified = await post('/authorize/verify', { code });
  assert.equal(verified.status, 303, 'reviewer code accepted (are REVIEW_EMAIL and REVIEW_CODE set on the Worker?)');
  const token = await fetch(`${target}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id, redirect_uri: redirect, resource: `${origin}/mcp`,
      code: new URL(verified.headers.get('location')).searchParams.get('code'), code_verifier: verifier }) });
  assert.equal(token.status, 200, 'token exchange');
  const { access_token } = await token.json();
  const client = new Client({ name: 'otis-reviewer-seed', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${target}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${access_token}` } } }));
  return client;
}

const client = await signIn();
async function call(name, args = {}) {
  const result = (await client.callTool({ name, arguments: name.endsWith('_list') || name.endsWith('_get') ? args : { request_id: randomUUID(), ...args } })).structuredContent;
  assert.equal(result.ok, true, `${name}: ${result.code ?? ''} ${result.message ?? ''}`);
  return result.data;
}

assert((await call('business_get')).setup_required, 'The reviewer business is already set up; nothing was changed.');

const tax = (client) => ({ treatment: 'not_registered', jurisdiction: client.region ? `US-${client.region}` : client.country,
  reason: 'Northstar Studio is not registered to collect sales tax or VAT; confirmed in its tax profile.', service_category: 'Consulting services' });
await call('business_set', { name: 'Northstar Studio', currency: 'USD',
  billing_address: 'Northstar Studio LLC, 1200 Example Avenue, Suite 300, Portland, OR 97204, United States',
  invoice_preferences: { prefix: 'NS-', number_padding: 1, starting_number: 1038, default_note: 'Thank you for working with Northstar Studio.',
    payment_instructions: 'Pay by bank transfer to Northstar Studio LLC by the due date. Use the invoice number as the payment reference.' } });
await call('tax_profile_set', { profile: { country: 'US', region: 'OR', registration_status: 'not_registered', registrations: [], reviewed_on: '2026-08-01',
  notes: "Northstar Studio is not registered to collect sales tax or VAT anywhere. Oregon has no general sales tax. Confirmed with the studio's accountant on 1 August 2026." } });

const clients = {
  'fernhill-coffee': { name: 'Fernhill Coffee', email: 'accounts@fernhill.example.com', billing_address: '418 Alder Street, Portland, OR 97205, United States', country: 'US', region: 'OR' },
  'harbor-pine': { name: 'Harbor & Pine Architects', email: 'billing@harborpine.example.com', billing_address: '92 Wharf Road, Seattle, WA 98101, United States', country: 'US', region: 'WA' },
  'lumen-health': { name: 'Lumen Health Clinic', email: 'finance@lumenhealth.example.com', billing_address: '2700 Larkspur Way, Boise, ID 83702, United States', country: 'US', region: 'ID' },
  'kestrel-labs': { name: 'Kestrel Labs Ltd', email: 'accounts@kestrellabs.example.com', billing_address: '14 Canal Street, Manchester M1 3HE, United Kingdom', country: 'GB', tax_ids: ['GB 123 4567 89'] },
};
// Otis assigns record IDs on create, so the keys below are only this script's names for the records.
const ids = {};
for (const [key, record] of Object.entries(clients)) ids[key] = (await call('client_save', { customer_type: 'business', ...record })).id;

// Work recorded directly; billed-back expenses and timed work get their items from expense_record and timer_stop below.
const work = [
  ['fernhill-brand-sprint', 'fernhill-coffee', 'time', 'Brand strategy sprint', '1', 'project', 100000, { rate_minor: 100000 }],
  ['fernhill-menu-pricing', 'fernhill-coffee', 'time', 'Menu pricing review', '2', 'hour', 24000, { rate_minor: 12000 }],
  ['fernhill-menu-photos', 'fernhill-coffee', 'ai_usage', 'Menu photo generation', '2000000', 'token', 1200, { cost_minor: 1200, measurement: 'estimated' }],
  ['harbor-design-system', 'harbor-pine', 'time', 'Design system build, August', '20', 'hour', 240000, { rate_minor: 12000 }],
  ['harbor-permit-reviews', 'harbor-pine', 'time', 'Permit drawing reviews, September', '12', 'hour', 156000, { rate_minor: 13000 }],
  ['lumen-intake-redesign', 'lumen-health', 'time', 'Patient intake form redesign', '1', 'project', 180000, { rate_minor: 180000 }],
  ['lumen-accessibility-research', 'lumen-health', 'ai_usage', 'Accessibility research with Claude', '1800000', 'token', 3600, { cost_minor: 1800, measurement: 'measured' }],
  ['lumen-copy-review', 'lumen-health', 'time', 'Clinic website copy review', '6', 'hour', 72000, { rate_minor: 12000 }],
  ['kestrel-strategy-workshop', 'kestrel-labs', 'time', 'Product strategy workshop', '8', 'hour', 120000, { rate_minor: 15000 }],
  ['kestrel-interview-synthesis', 'kestrel-labs', 'ai_usage', 'Customer interview synthesis', '4500000', 'token', 4500, { cost_minor: 2700, measurement: 'measured' }],
  ['kestrel-roadmap-session', 'kestrel-labs', 'time', 'Roadmap follow-up session', '4', 'hour', 60000, { rate_minor: 15000 }],
];
const items = {};
for (const [key, client, kind, description, quantity, unit, amount_minor, extra] of work) {
  items[key] = { id: (await call('billable_record', { client_id: ids[client], kind, description, quantity, unit, amount_minor, ...extra })).id, amount: amount_minor };
}

const expenses = [
  ['expense-fernhill-supplies', 'Paper & Co', 'Supplies', 'Workshop supplies', '2026-09-12', 7500, 'fernhill-coffee', 7500],
  ['expense-harbor-mileage', 'Personal vehicle', 'Travel', 'Mileage for the Seattle site visit', '2026-09-24', 6400, 'harbor-pine', 6400],
  ['expense-fernhill-proofs', 'Copy Corner', 'Printing', 'Printed menu proofs', '2026-09-26', 4800, 'fernhill-coffee'],
  ['expense-coworking', 'Alder Street Cowork', 'Office', 'Coworking desk, October', '2026-10-01', 32000],
  ['expense-design-software', 'Design software', 'Software', 'Monthly subscription', '2026-10-01', 1900],
  ['expense-ai-subscription', 'AI assistant', 'Software', 'AI assistant subscription, October', '2026-10-03', 2000],
  ['expense-harbor-stock', 'Stock library', 'Stock media', 'Stock photography for the client presentation', '2026-10-08', 4500, 'harbor-pine', 4500],
];
for (const [key, vendor, category, description, incurred_on, cost_minor, client, billable_amount_minor] of expenses) {
  const expense = await call('expense_record', { vendor, category, description, incurred_on, cost_minor,
    ...(client ? { client_id: ids[client] } : {}), ...(billable_amount_minor ? { billable_amount_minor } : {}) });
  if (expense.billable_id) items[key] = { id: expense.billable_id, amount: billable_amount_minor };
}

// Timers within the last week (reported times may go back at most seven days): three recorded, one stopped, one discarded.
const ago = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString();
async function timed(client, description, startHoursAgo, minutes, rate_minor) {
  const timer = await call('timer_start', { client_id: ids[client], description, started_at: ago(startHoursAgo) });
  return call('timer_stop', { timer_id: timer.id, stopped_at: ago(startHoursAgo - minutes / 60), ...(rate_minor ? { rate_minor } : {}) });
}
await timed('fernhill-coffee', 'Brand workshop facilitation', 120, 180, 12000);
await timed('kestrel-labs', 'Discovery call', 96, 45, 15000);
await timed('lumen-health', 'Accessibility review', 72, 90, 12000);
await timed('fernhill-coffee', 'Menu photography brief', 30, 40);
const discarded = await call('timer_start', { client_id: ids['harbor-pine'], description: 'Site visit notes', started_at: ago(48) });
await call('timer_stop', { timer_id: discarded.id, discard: true });

async function invoice(client, keys, supply_date, due_date, extra = {}) {
  const lines = keys.map(key => ({ item_id: items[key].id, amount_minor: items[key].amount, tax: tax(clients[client]) }));
  return call('invoice_draft', { client_id: ids[client], lines, supply_date, due_date, ...extra });
}
async function issued(...args) {
  const draft = await invoice(...args);
  return call('invoice_issue', { invoice_id: draft.id, expected_total_minor: draft.total_minor, confirmed: true });
}
const i1038 = await issued('harbor-pine', ['harbor-design-system'], '2026-08-31', '2026-09-30', { discount: { kind: 'percent', rate_ppm: 50000 } });
const i1039 = await issued('lumen-health', ['lumen-intake-redesign', 'lumen-accessibility-research'], '2026-09-05', '2026-09-20');
const i1040 = await issued('kestrel-labs', ['kestrel-strategy-workshop', 'kestrel-interview-synthesis'], '2026-09-10', '2026-10-10');
const i1041 = await issued('fernhill-coffee', ['fernhill-brand-sprint'], '2026-09-15', '2026-10-01');
const i1042 = await issued('harbor-pine', ['harbor-permit-reviews', 'expense-harbor-mileage'], '2026-09-30', '2026-10-30');
const cancelled = await invoice('kestrel-labs', ['kestrel-roadmap-session'], '2026-10-09', '2026-11-08');
await call('invoice_cancel_draft', { invoice_id: cancelled.id, reason: "Kestrel asked to bill this with next month's work." });
await invoice('lumen-health', ['lumen-copy-review'], '2026-10-20', '2026-11-19');

for (const [record, amount_minor, received_on, reference] of [[i1038, i1038.total_minor, '2026-09-14', 'HP-ACH-0914'], [i1039, i1039.total_minor, '2026-09-18', 'LHC-4471'],
  [i1041, 40000, '2026-09-20', 'FC-TRANSFER-0920'], [i1040, i1040.total_minor, '2026-09-28', 'KL-BACS-2809'], [i1042, 80000, '2026-10-15', 'HP-ACH-1015']]) {
  await call('payment_record', { invoice_id: record.id, amount_minor, received_on, reference });
}

const invoices = await call('invoices_list');
console.log(`Seeded ${email} on ${target}: ${invoices.records.length} invoices (${invoices.records.map(i => i.display_number ?? i.status).join(', ')}).`);
await client.close();
