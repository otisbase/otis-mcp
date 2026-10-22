# Product

## Purpose and audience

Otisbase is a free, headless business records service accessed through AI assistants using MCP. Otis is the conversational shorthand. It preserves business facts across conversations, sessions, and AI clients.

The initial audience is independent consultants and small agencies, initially oriented toward the US market. Their central workflow is to record work and expenses, identify unbilled items, issue invoices, and track payments.

Team sharing, taxes, discounts and partial billing belong to the initial product and are documented from day one, even when discovery copy emphasizes the simpler workflow.

The audience focus does not add a general accounting suite or remove the agreed record types below.

## Identity

| Item | Value |
| --- | --- |
| Website and public brand | Otisbase |
| Conversational shorthand | Otis |
| Plugin name and shorthand | `/otis` |
| MCP server name | `otis` |
| Home and documentation domain | `otisbase.com` |
| MCP endpoint host | `mcp.otisbase.com` |
| Secondary domain | `otisbase.dev`, redirects to `otisbase.com` |

These names describe the intended distribution; they do not imply deployed endpoints, registered domains, or published plugins. Slash-command availability depends on the AI client.

The website uses Otisbase as its name and Otis naturally in example prompts and conversation guidance. The branding distinction does not rename the MCP server or its tools, resources, plugin identifiers, or existing endpoints.

## Product boundary

AI assistants are the only operational interface. Otis has no application dashboard, operational widgets, or client portal.

The assistant generates invoices, documents, reports, visualizations, and descriptions. Otis preserves structured records and returns authoritative recorded facts.

The assistant or user supplies prices, rates, amounts, estimates, usage, and costs. Otis enforces record integrity and validates financial arithmetic; these checks are distinct from choosing commercial prices or running an advanced calculation engine.

## Agreed record scope

| Area | Persistent business information |
| --- | --- |
| Business identity | Company identity, address, billing details, currency, invoice preferences, and numbering configuration |
| Team access | Verified identities, owner/editor/viewer roles, invitations and current permissions |
| Clients | Identity, billing details, and relationships to invoices and billable records |
| Tax and discounts | Confirmed tax profiles, explicit line treatments/components, line/invoice discounts and recorded calculations |
| Invoices | Stable identifiers, sequential invoice numbers, metadata, structured issued contents, status, references, and balances |
| Payments | Manually or AI-reported payments, partial payments, dates, amounts, and relationships to invoice balances |
| Expenses | Vendors, categories, costs, attachments or references, and optional client association |
| Billable expenses | Client attribution, billable amount, billing state, and invoice relationships |
| Billable time | Hours, client, project or work description, supplied rate and amount, and billing state |
| Billable AI usage | Reported tokens or other units, client/project attribution, approximate cost, billable amount, and whether usage is measured or estimated |
| Quotes / estimates | Optional structured records, revisions, status, and invoice relationships |

⚠️ UNRESOLVED: Quotes / estimates remain optional; inclusion in the first release is not decided.

## Commercial posture

Otis offers only free access. The version launching now is free permanently (Stefan, 2026-10-21); the website says it stays free. There is no approved paid plan, trial-to-paid conversion, premium feature list, or monetization model.

The free offering is intended to be generous for the initial audience. Staying free is not a promise of unlimited usage.

The user's existing AI client supplies the conversational intelligence and document generation. Otis does not run model inference or bundle an AI subscription into its free service.

Early infrastructure costs are supported by Stefan's existing Cloudflare startup grant. The planning assumption is coverage for Workers, databases, and storage for the initial six months and potentially a year without inference. This is founder-provided context, not a verified grant balance or expiry.

Startup support from Cloudflare and Anthropic is credited publicly on the website as what covers running costs.

A path to monetization may come later, but it cannot take away what the launch version offers for free. Defining or implementing it is deferred; it does not block launching and distributing the free product.

⚠️ UNRESOLVED: The eventual monetization model, if any. No future paid offering is approved.

Fair-use limits per business (Stefan, 2026-10-21): 10,000 requests a day, 1,000 new records a day and 100,000 records in total, published on `/pricing` as set far above normal use. The website presents the free plan beside a Pro placeholder tagged “Maybe later”, with no price or features; a future paid extra may only add to Free.

The server enforces these limits per business, from the same figures `/pricing` shows (`FAIR_USE` in `src/models.ts`):

- A request counts when someone with access to the business makes it, whether or not it succeeds. Calls from people without access, invalid input, and the menu, tax guide and business discovery tools count toward no business.
- A new record is any business record an operation creates: the business, a membership or invitation, a client, billable, expense, invoice or payment. Edits and the audit trail do not count. Stored records count toward the total for as long as they exist.
- Daily limits reset at 00:00 UTC.
- At a limit the server refuses the call with `FAIR_USE_LIMIT`, naming the limit, the allowance, the amount used and when it resets (never, for the total). At the request limit every call is refused, reads included. At either record limit, reads and edits keep working; an operation that would create records beyond the limit is refused as a whole and saves nothing.
- There is no warning before a limit is reached (Stefan, 2026-10-21); the refusal at the limit is the only signal.

⚠️ UNRESOLVED: What a business can do after reaching the record total, since records cannot be deleted. Support expectations and the support contact are undecided; the site has no contact address.

## Feedback to the team

People send feature requests, problem reports and other feedback by asking their assistant, through the `feedback_send` tool on the private MCP connection. There is no feedback form or page. Assistants offer it when someone wants something Otis cannot do, asks for a feature or hits a problem; they show the exact message and send only after the person approves it, and never send it unprompted.

- What is sent: the kind (feature, problem or other), the message the person approved (up to 4,000 characters), the assistant's name if known, and an opaque account reference. The person's verified email is included only when they agree to a reply (`reply_ok`); the assistant asks first. Business records, chat history and anything the person did not write or approve are never sent.
- Where it goes: each message is saved in a single feedback store on Cloudflare, then emailed to support@otisbase.com with the subject `Otis feedback: <kind>`. Saving does not depend on the email; the result says whether the email went out, and repeating the same `request_id` retries a failed email without counting twice.
- Who can send: any signed-in person, whatever their role. Feedback changes no business records and does not count toward the business fair-use limits.
- Limit: 20 messages per person per UTC day, refused at the limit with `FEEDBACK_LIMIT` and `resets_at`.

## Explicitly deferred

Open banking; automatic AI usage measurement or model price lists; advanced calculations; Otis-provided AI intelligence or premium capabilities; credit notes; purchase orders; a recurring billing engine; CRM pipelines; contracts; payroll; ERP; and any dedicated operational UI.

Minimal invoice correction semantics still need definition despite credit notes being deferred; see [records and billing](03-records-and-billing.md).
