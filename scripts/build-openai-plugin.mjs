// Build the ZIP for OpenAI's plugin directory (ChatGPT and Codex), from the generated Codex plugin in plugins/codex/otis.
// The public Codex package stays as it is; this adds the listing (interface) and review material OpenAI's portal
// reads from extensions.com.openai. Test credentials never go in the ZIP: they are entered in the portal.
//
//   npm run plugins:build && node scripts/build-openai-plugin.mjs
//   OPENAI_DEMO_RECORDING_URL=https://… node scripts/build-openai-plugin.mjs   (once the walkthrough video exists)
//
// The ZIP lands in reports/openai/, which is private: it is uploaded by hand at platform.openai.com/plugins.
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const project = fileURLToPath(new URL('../', import.meta.url));
const source = join(project, 'plugins/codex/otis');
const out = join(project, 'reports/openai');
const codex = JSON.parse(await readFile(join(source, '.codex-plugin/plugin.json'), 'utf8'));
const site = 'https://otisbase.com';

// OpenAI rejects listing text that advertises pricing, so nothing here says "free".
const description = 'Client billing records for consultants and small agencies: clients, billable work, timers, expenses, invoices and payments, kept by Otis and used from your chat.';
const longDescription = [
  'Otis keeps the billing records of a consultant or small agency: clients, billable hours and timers, expenses, invoices and payments. Your assistant is the interface. Tell it what you worked on, what you spent or who paid, and Otis stores it as structured records.',
  'When you are ready to bill, the assistant drafts the invoice from unbilled work. Otis numbers it, calculates totals and tax, and checks it against the business\'s tax profile before it can be issued. An invoice is issued only after you approve its exact total, and an issued invoice is never rewritten. Payments are recorded against invoices, so the assistant can tell you what is unpaid and what is ready to invoice.',
  'Otis records billing facts. It does not send invoices, move money or connect to bank accounts. It runs no AI model of its own: every answer comes from your records and the rules on the server. Sign in with your email; records can be exported in full at any time.',
].join('\n\n');

const manifest = {
  ...codex,
  description,
  author: { name: 'Boon IT SRL', url: site },
  interface: {
    displayName: 'Otis',
    shortDescription: 'Client billing in your chat',
    longDescription,
    developerName: 'Boon IT SRL',
    category: 'Finance',
    capabilities: [
      'Record billable hours, fixed fees and AI usage per client',
      'Time work with a timer and record it at an hourly rate',
      'Record expenses and bill them back to clients',
      'Draft, check and issue invoices after you approve the exact total',
      'Record payments and see what is unpaid or ready to invoice',
      'Export all business records',
    ],
    defaultPrompt: [
      'Which invoices are still unpaid, and how much is due on each?',
      'What can I invoice Fernhill Coffee for?',
      'Record 2 hours of permit review for Harbor & Pine at $130 an hour.',
    ],
    websiteURL: site,
    supportURL: `${site}/about`,
    privacyPolicyURL: `${site}/privacy`,
    termsOfServiceURL: `${site}/terms`,
    logo: './assets/logo.png',
    composerIcon: './assets/logo.png',
  },
  extensions: {
    'com.openai': {
      review: {
        commerce_description: 'This plugin does not sell products or process payments. It records invoices and the payments a user reports.',
        ...(process.env.OPENAI_DEMO_RECORDING_URL ? { demo_recording_url: process.env.OPENAI_DEMO_RECORDING_URL } : {}),
        test_cases: {
          positive: [
            { description: 'List unpaid invoices with the amount due on each.', prompt: 'Which invoices are still unpaid, and how much is due on each?',
              tools_triggered: ['invoices_list'], expected_behavior: 'Lists NS-1041 (Fernhill Coffee, $600 due of $1,000) and NS-1042 (Harbor & Pine Architects, $824 due), plus the open $720 draft for Lumen Health Clinic as not yet issued.' },
            { description: 'Show unbilled work for one client.', prompt: 'What can I invoice Fernhill Coffee for?',
              tools_triggered: ['clients_list', 'billables_list'], expected_behavior: 'Lists Fernhill Coffee\'s unbilled work and billable expenses with their amounts and a total, and offers to draft an invoice.' },
            { description: 'Record billable time for a client.', prompt: 'Record 2 hours of permit review for Harbor & Pine at $130 an hour.',
              tools_triggered: ['clients_list', 'billable_record'], expected_behavior: 'Asks to confirm, then records 2 hours at $130 ($260) for Harbor & Pine Architects and reports it as unbilled.' },
            { description: 'Start and stop a timer.', prompt: 'Start a timer for Lumen Health copy edits. Then stop it and record it at $120 an hour.',
              tools_triggered: ['clients_list', 'timer_start', 'timer_stop'], expected_behavior: 'Starts a timer for Lumen Health Clinic, then stops it and records the tracked minutes as billable time at $120 an hour.' },
            { description: 'Draft an invoice and check it before issuing.', prompt: 'Draft an invoice for Kestrel Labs\' unbilled work and check whether it is ready to issue.',
              tools_triggered: ['clients_list', 'billables_list', 'invoice_draft', 'invoice_check'], expected_behavior: 'Shows the draft lines and exact total, creates the draft after confirmation, and reports whether it is ready. It does not issue the invoice without the user approving the exact total.' },
          ],
          negative: [
            { description: 'Moving money is out of scope: Otis records payments, it does not make them.', prompt: 'Transfer $500 from my bank account to Fernhill Coffee.' },
            { description: 'Sending email is out of scope: Otis does not send invoices.', prompt: 'Email invoice NS-1041 to Fernhill Coffee.' },
            { description: 'An unrelated request should not use Otis.', prompt: 'What is the weather in Portland tomorrow?' },
          ],
        },
      },
      publication: { release_notes: 'First release in the OpenAI plugin directory.' },
    },
  },
};
const mcp = { mcpServers: { otis: { url: 'https://mcp.otisbase.com/mcp' } } };
// The portal wants tools_triggered as one string, not a list (its upload check, 2026-10-24).
for (const item of manifest.extensions['com.openai'].review.test_cases.positive) item.tools_triggered = item.tools_triggered.join(', ');

// Every file of the Codex package except its manifest and MCP file, which are replaced above, and its README.
async function files(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await files(path));
    else if (entry.isFile() && entry.name !== '.DS_Store') found.push(path);
  }
  return found;
}
const entries = {};
for (const path of await files(source)) {
  const name = relative(source, path);
  // The Codex README describes the Codex marketplace and mentions pricing; the listing text above replaces it.
  if (!['.codex-plugin/plugin.json', '.mcp.json', 'README.md'].includes(name)) entries[name] = (await readFile(path)).toString('base64');
}
entries['.codex-plugin/plugin.json'] = Buffer.from(JSON.stringify(manifest, null, 2) + '\n').toString('base64');
entries['.mcp.json'] = Buffer.from(JSON.stringify(mcp, null, 2) + '\n').toString('base64');
entries['assets/logo.png'] = (await readFile(join(project, 'site/src/images/icon-512.png'))).toString('base64');

// Limits from OpenAI's submission rules, checked here so the portal does not reject the upload.
const limits = [['displayName', 30], ['shortDescription', 30], ['longDescription', 4000], ['developerName', 80]];
for (const [field, max] of limits) if (manifest.interface[field].length > max) throw new Error(`${field} is over ${max} characters`);
if (manifest.description.length > 1024) throw new Error('description is over 1,024 characters');
if (manifest.interface.defaultPrompt.some(prompt => prompt.length > 128)) throw new Error('a default prompt is over 128 characters');
if (manifest.interface.capabilities.some(item => item.length > 120)) throw new Error('a capability is over 120 characters');
const cases = manifest.extensions['com.openai'].review.test_cases;
if (cases.positive.length !== 5 || cases.negative.length !== 3) throw new Error('OpenAI needs exactly five positive and three negative test cases');
if (/\bfree\b/i.test(JSON.stringify(manifest.interface) + manifest.description)) throw new Error('Listing text mentions "free"');

await mkdir(out, { recursive: true });
const archive = join(out, `otis-openai-${codex.version}.zip`);
execFileSync('python3', ['-c', `
import base64, json, sys, zipfile
args = json.load(sys.stdin)
with zipfile.ZipFile(args['archive'], 'w') as z:
    for name, data in sorted(args['entries'].items()):
        info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        z.writestr(info, base64.b64decode(data))
with zipfile.ZipFile(args['archive']) as z:
    assert z.testzip() is None
    print(len(z.namelist()), 'files')
`], { input: JSON.stringify({ archive, entries }), stdio: ['pipe', 'inherit', 'inherit'] });
console.log(`Built ${relative(project, archive)}${process.env.OPENAI_DEMO_RECORDING_URL ? '' : ' (no demo recording URL yet)'}`);
