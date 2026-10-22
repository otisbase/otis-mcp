import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { workflows, workflowText } from '../src/workflows.ts';

const root = fileURLToPath(new URL('../plugins/', import.meta.url));
const check = process.argv.includes('--check');
const origin = 'https://mcp.otisbase.com';
const version = '0.2.1';
const description = 'Free business records through your AI: clients, work, expenses, invoices, payments, team, business settings, tax settings and export.';
const json = value => JSON.stringify(value, null, 2) + '\n';
const skill = (name, description, body) => `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`;
const expected = new Map();
// MIT, for the public plugin repository and each package (Stefan, 2026-10-22).
const license = `MIT License

Copyright (c) 2026 Stefan Szakal

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
expected.set('LICENSE', license);
for (const host of ['codex', 'claude']) {
  const folder = `${host}/otis`;
  const manifest = { name: 'otis', version, description, author: { name: 'Otis', url: 'https://otisbase.com' }, homepage: 'https://otisbase.com/skills', repository: 'https://github.com/otisbase/otis-plugins', license: 'MIT' };
  expected.set(`${folder}/LICENSE`, license);
  if (host === 'codex') {
    expected.set(`${folder}/.codex-plugin/plugin.json`, json({ ...manifest, skills: './skills/', mcpServers: './.mcp.json' }));
  } else {
    expected.set(`${folder}/.claude-plugin/plugin.json`, json({ ...manifest, displayName: 'Otis' }));
  }
  expected.set(`${folder}/.mcp.json`, json({ mcpServers: { otis: { type: 'http', url: `${origin}/mcp` } } }));
  for (const workflow of workflows) {
    const body = workflowText(workflow, false, origin).replace(`Help me with Otis: ${workflow.label}.`, `# ${workflow.label} with Otis`);
    expected.set(`${folder}/skills/${workflow.name}/SKILL.md`, skill(workflow.name, workflow.description, body));
  }
  const menu = [
    '# Otis menu', '',
    "Use when the user asks for /otis, the Otis menu, or help choosing an Otis task. If a task is already explicit, use its workflow without a menu detour.", '',
    "Call the connected Otis otis_menu tool and show its numbered choices. Wait for a number, an action name or a natural-language task. Showing the menu does not authorize a write or invoice issuance.", '',
    "If Otis is not connected, label this as a navigation preview, show the choices below, and explain how to connect the bundled remote MCP. Sign-in uses an email code in the browser; never ask for the code in chat. Do not invent business records or imply the user is authenticated.", '',
    ...workflows.map((w, i) => `${i + 1}. ${w.label} — workflow: ${w.name}`), '',
    "After the user selects a task, use its matching workflow skill or the mapped steps returned by otis_menu. Discover the business and current permissions before accessing records. The public demo is fictional and read-only; these packaged workflow skills target the private connection.", '',
    "Use the host's actual skill picker or namespace. Do not promise that /otis or a hyphenated alias is installed universally."
  ].join('\n');
  expected.set(`${folder}/skills/menu/SKILL.md`, skill('menu', 'Show the Otis menu and route a user to an independent business workflow when they ask for /otis or need help choosing a task.', menu));
  const usage = host === 'claude'
    ? 'In Claude Code, install it from the Otis marketplace in one step with `/plugin install otis --marketplace otisbase/otis-plugins`, or run `claude plugin marketplace add otisbase/otis-plugins` and then `claude plugin install otis@otis`. In Claude chat or Cowork, upload the release ZIP through Customize > Plugins > Add > Upload plugin. Then connect its remote connector and finish email-code sign-in. Use `/otis:menu`, `/otis:create-invoice`, or the other skills from the slash picker.'
    : 'This package uses the supported `.codex-plugin/plugin.json` compatibility format. Add the Otis marketplace with `codex plugin marketplace add otisbase/otis-plugins`, install with `codex plugin add otis@otis` (or from `codex /plugins` or the ChatGPT desktop app’s Plugins tab), then connect its remote MCP and finish email-code sign-in. Start a new session, then select a bundled skill from the picker or use a `$` skill mention such as `$otis:create-invoice` when that qualified name is shown by the host.';
  const body = [`# Otis for ${host === 'claude' ? 'Claude' : 'Codex'}`, '', description, '',
    'The package contains one menu skill, ten independent workflow skills, and a remote MCP connection. It runs no local backend, model inference, hooks or shell scripts. Business records remain in the existing Cloudflare service. Authentication and permissions are enforced by that service.', '', usage, '',
    'Use a single intended Otis connection in each client. If you already connected Otis directly, inspect that connection before enabling another copy; do not silently remove user configuration. Plugin and MCP namespaces can differ. Refresh the host after an update.', '',
    '| Skill | Purpose |', '| --- | --- |', '| menu | Open the menu |',
    ...workflows.map(w => `| ${w.name} | ${w.label} |`), '',
    'Commands start guided workflows. Invoice preparation is not issuance approval; the assistant must show the exact draft and total before issuing. Payments are reported facts. Tax guidance is not automatic tax determination. The service offers free access at launch.', '',
    'The Otis marketplace is github.com/otisbase/otis-plugins. The plugin is not in the Anthropic or OpenAI plugin directories. Manifest and skill validation does not establish end-to-end behavior in every host.', '',
    'Generated from the Otis workflow catalog. Edit src/workflows.ts and scripts/build-plugins.mjs in the source project, then run `npm run plugins:build`. Do not edit generated skills independently.', '',
    'Official references: https://code.claude.com/docs/en/mcp#use-mcp-prompts-as-commands · https://claude.com/docs/plugins/build · https://developers.openai.com/plugins/build/plugins · https://learn.chatgpt.com/docs/build-skills', ''
  ].join('\n');
  expected.set(`${folder}/README.md`, body);
}

// The plugins folder is also the public marketplace repository, github.com/otisbase/otis-plugins: one catalog
// for Claude (.claude-plugin/marketplace.json) and one for Codex (.agents/plugins/marketplace.json).
const repo = 'otisbase/otis-plugins';
expected.set('.claude-plugin/marketplace.json', json({
  name: 'otis', description: 'The Otis plugin: skills for client billing with the Otis MCP server.',
  owner: { name: 'Otisbase', url: 'https://otisbase.com' },
  plugins: [{ name: 'otis', source: './claude/otis', description, version, category: 'productivity', homepage: 'https://otisbase.com/skills' }],
}));
expected.set('.agents/plugins/marketplace.json', json({
  name: 'otis', interface: { displayName: 'Otis' },
  plugins: [{ name: 'otis', source: { source: 'local', path: './codex/otis' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }],
}));
expected.set('.gitignore', '*.zip\n.DS_Store\n');
expected.set('README.md', [
  '# Otis Plugins', '', description, '',
  '[Otisbase](https://otisbase.com) is a free MCP server for client billing, built for consultants and small agencies. There is no app or dashboard: your AI assistant is the interface. You tell it what happened, it records the work, expenses and payments in Otis, and Otis issues the invoices you approve. Otis stores the records and enforces the rules, such as invoice numbering, totals and exact-total approval. Issued invoices cannot be rewritten.', '',
  'This repository is the plugin marketplace for Otis. Each plugin bundles the remote Otis MCP connection with a menu skill and ten workflow skills, so the assistant knows how to run each job step by step. Nothing runs on your computer; records stay in the Otis service, stored in the EU on Cloudflare.', '',
  '| Plugin | Folder | For |', '| --- | --- | --- |',
  '| Otis for Claude | [`claude/otis`](claude/otis) | Claude Code, Claude and Cowork |',
  '| Otis for Codex | [`codex/otis`](codex/otis) | Codex CLI and the ChatGPT desktop app |', '',
  '## Install', '',
  'Full steps for every assistant are on [How to install](https://otisbase.com/connect).', '',
  '### Claude Code', '', '```bash', `claude plugin marketplace add ${repo}`, 'claude plugin install otis@otis', '```', '', `Or in one step inside Claude Code: \`/plugin install otis --marketplace ${repo}\`.`, '',
  'Then type `/otis:menu`. Sign-in uses an email code in your browser.', '',
  '### Claude and Cowork', '', `Download \`otis-claude-${version}.zip\` from the [latest release](https://github.com/${repo}/releases/latest), upload it under Customize, Plugins, and connect Otis.`, '',
  '### Codex', '', '```bash', `codex plugin marketplace add ${repo}`, 'codex plugin add otis@otis', '```', '',
  'Or run `codex /plugins`, or use the Plugins tab in the ChatGPT desktop app. Start a new session, then type `$otis:` to pick a skill.', '',
  '## Connect without a plugin', '',
  `The plugins are optional. Any assistant that supports remote MCP servers can add Otis directly with this URL:`, '',
  '```', `${origin}/mcp`, '```', '',
  'Sign-in uses OAuth with an email code, so there is no API key to copy. [How to install](https://otisbase.com/connect) has a guide for Claude, ChatGPT, Claude Code, Codex, Cursor, Muse, Grok Bot and Mistral Vibe.', '',
  '## Skills', '', '| Skill | Purpose |', '| --- | --- |', '| menu | Open the menu |',
  ...workflows.map(w => `| ${w.name} | ${w.label} |`), '',
  'Choosing a skill never approves an action: issuing an invoice still needs your exact total. Details are on [otisbase.com/skills](https://otisbase.com/skills).', '',
  '## Links', '',
  '- [Otisbase](https://otisbase.com)',
  '- [How to install](https://otisbase.com/connect)',
  '- [MCP docs](https://otisbase.com/docs): the endpoint, the rules and every tool',
  '- [Privacy Policy](https://otisbase.com/privacy) and [Terms of Service](https://otisbase.com/terms)',
  '- Support: [support@otisbase.com](mailto:support@otisbase.com)', '',
  '## License', '',
  'Released under the [MIT License](LICENSE). These files are generated from the Otis workflow catalog by `npm run plugins:build` in the Otis source project. Do not edit them by hand.', ''
].join('\n'));

for (const [relative, contents] of expected) {
  const path = join(root, relative);
  if (check) {
    if (await readFile(path, 'utf8') !== contents) throw new Error(`Generated package is stale: ${relative}`);
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
}
// Detect stale or injected package files instead of silently distributing them.
async function inspect(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await inspect(join(directory, entry.name), relative);
    else if (!entry.isFile() || !expected.has(relative)) throw new Error(`Unexpected package file: ${relative}`);
  }
}
for (const host of ['codex', 'claude']) await inspect(join(root, host), host);
// Python's standard-library ZIP support avoids adding a packaging dependency.
execFileSync('python3', ['-c', `
import json, sys, zipfile
from pathlib import Path
args = json.load(sys.stdin)
root = Path(args['root'])
for host in ['codex', 'claude']:
    prefix = host + '/'
    files = {name[len(prefix):]: (root / name).read_bytes() for name in args['files'] if name.startswith(prefix)}
    archive = root / ('otis-' + host + '-' + args['version'] + '.zip')
    if not args['check']:
        with zipfile.ZipFile(archive, 'w') as z:
            for name, data in sorted(files.items()):
                info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                z.writestr(info, data)
    with zipfile.ZipFile(archive) as z:
        assert len(z.namelist()) == len(files) and set(z.namelist()) == set(files), str(archive)
        assert z.testzip() is None, str(archive)
        for name, data in files.items():
            assert z.read(name) == data, 'Stale archive entry: ' + name
print('Both ZIP archives verified against the generated package files.')
`], { input: JSON.stringify({ root, version, files: [...expected.keys()], check }), stdio: ['pipe', 'inherit', 'inherit'] });
console.log(`${check ? 'Verified' : 'Generated'} ${expected.size} files: two Otis packages, each with 11 skills and remote MCP configuration.`);
