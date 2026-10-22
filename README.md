# Otis MCP

The source code of [Otisbase](https://otisbase.com), a free MCP server for client billing, built for consultants and small agencies.

Otis has no app or dashboard. Your AI assistant is the interface: it records clients, work, expenses and payments in Otis, and issues the invoices you approve. Otis stores the records and enforces the rules. It numbers invoices, calculates totals, requires your exact total before it issues an invoice, and never rewrites an issued invoice. Otis runs no AI model; every result comes from the records and the rules in this repository.

This repository is the complete service that runs at mcp.otisbase.com: the MCP server, email sign-in and the storage layer. It runs on Cloudflare Workers. The otisbase.com website is maintained separately.

## Use the hosted service

Add this URL as a remote MCP server in your assistant:

```
https://mcp.otisbase.com/mcp
```

Sign-in uses OAuth with an email code, so there is no API key. [How to install](https://otisbase.com/connect) has a guide for Claude, ChatGPT, Claude Code, Codex, Cursor, Muse, Grok Bot and Mistral Vibe. The hosted service is free. Records are stored in the EU.

- [MCP docs](https://otisbase.com/docs): the endpoint, the rules and all 26 tools.
- [Otis Plugins](https://github.com/otisbase/otis-plugins): the plugin for Claude and Codex, with eleven workflow skills.
- [Skills](https://otisbase.com/skills): what each skill does.

## What Otis records

| Area | Records |
| --- | --- |
| Business | Business details, tax settings, invoice numbering, members and invitations |
| Clients | Clients and their billing details |
| Work | Billable time, services, reported AI usage and expenses |
| Invoices | Drafts, issued invoices with immutable contents, discounts and tax |
| Payments | Full and partial payments, with references that prevent duplicates |
| Export | A complete export of the business records |

## How it works

| Part | Implementation |
| --- | --- |
| Runtime | One Cloudflare Worker (`src/index.ts`) |
| MCP server | `@modelcontextprotocol/server` over Streamable HTTP at `/mcp` (`src/mcp.ts`) |
| Sign-in | `@cloudflare/workers-oauth-provider` with an email code (`src/auth.ts`) |
| Business records | SQLite in one Durable Object per business (`src/business-store.ts`) |
| Accounts and sign-ins | Durable Objects (`src/account-store.ts`, `src/sign-in-store.ts`) |
| OAuth state | Workers KV |
| Email | Cloudflare Email Sending, for sign-in codes and security notices |
| Data location | Durable Objects in the EU jurisdiction (`src/regions.ts`) |
| Sign-in pages | Server-rendered HTML with its own small stylesheet (`src/html.ts`, `src/shell.ts`) |

Every business operation checks the caller's current membership. Amounts are integers in minor units. Writes take a request ID, so a retried call does not record the same fact twice.

## Repository layout

| Path | Contents |
| --- | --- |
| `src/` | Worker, MCP tools, sign-in, storage, billing rules and public docs |
| `test/` | Integration tests in Cloudflare's local runtime |
| `scripts/` | Live endpoint checks, sign-in check and the plugin generator |
| `spec/` | The product specification: scope, billing rules, service and design |

Read the spec before you change behavior. Start with [spec/01-README.md](spec/01-README.md). The spec wins over the decision log.

## Develop

You need Node 24 or newer.

```bash
npm ci
npm run check
npm test
```

Tests run in Cloudflare's local runtime. Email delivery is simulated in tests.

To run the Worker locally:

```bash
npm run dev -- --local --ip 127.0.0.1 --port 8788
```

Then open http://127.0.0.1:8788/health. The local runtime uses local storage only.

`npm run plugins:build` generates the Claude and Codex plugins into `plugins/` from `src/workflows.ts`. They are published to [otisbase/otis-plugins](https://github.com/otisbase/otis-plugins).

## Self-host

You can run your own copy on a Cloudflare account. Edit `wrangler.jsonc` before you deploy:

1. Set `account_id` to your Cloudflare account.
2. Create a KV namespace for OAuth state and put its ID in `kv_namespaces`. For EU storage, create it in the EU jurisdiction.
3. Replace the two `routes` with your own domains.
4. Set the `vars`:
   - `ORIGIN`: the URL of the MCP host.
   - `SITE_ORIGIN`: the URL of your website. Website pages opened on the MCP host redirect there, and the sign-in pages link to its Terms and Privacy Policy.
   - `EMAIL_FROM`: the sender for sign-in codes. The domain must be set up for Cloudflare Email Sending.
   - `FEEDBACK_TO`: the address that receives feedback sent through the `feedback_send` tool.
   - `DO_JURISDICTION`: `eu` keeps Durable Objects in the EU. Remove it to let Cloudflare choose.
   - `SIGN_IN_ENABLED`: `true` to allow sign-in.
5. Set `ratelimits.namespace_id` to an ID that is unique in your account.

Then deploy:

```bash
npx wrangler login
npm run deploy
```

The sign-in pages and emails name Otisbase. Change them in `src/html.ts`, `src/auth.ts` and `src/notify.ts`, and publish your own terms and privacy policy, before you offer your copy to other people.

## Contribute

Bug reports, fixes and ideas are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). To report a security problem, see [SECURITY.md](SECURITY.md). You can also send feedback from your assistant: ask it to send feedback to Otis.

## License

The code is released under the [MIT License](LICENSE).

These items are not covered by the MIT License:

- The Otisbase and Otis names and logos.
- The Geist fonts in `src/fonts/`, under the [SIL Open Font License](src/fonts/OFL.txt).

The copy and check icons in `src/html.ts` come from [Phosphor Icons](https://phosphoricons.com) (MIT).
