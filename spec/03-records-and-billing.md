# Records and billing

## Authority and scope

Otis preserves business facts across agents and conversations. The user or assistant supplies commercial inputs and tax treatment; Otis validates arithmetic and record integrity. It does not choose prices, infer tax liability, measure tokens, verify bank activity or generate documents.

Business profiles, client identity/billing/tax details, memberships (owner only while teams are off), expenses, time and AI usage, invoices, reported payments and audit events are implemented. Tool schemas are authoritative for field names and limits; this document explains the intended behavior behind them.

## Money and tax

Each business uses one ISO currency, locked once financial records exist. Amounts use integer minor units. Rates and taxable fractions use integer parts per million. Quantity × supplied rate is checked with half-up rounding.

Tax treatment is explicit: taxable, zero-rated, exempt, outside scope, reverse charge or not registered. Missing information means unknown, never zero tax. The business tax profile records country/region, registration status, numbers, effective dates and the user's notes. Customer location and business/consumer status are preserved. See [tax guidance](05-tax-guidance.md).

Line discounts apply before proportional invoice discounts. Remaining discount minor units are allocated by largest remainder, with line order breaking ties. Named tax components share a base without compounding; each component is rounded half up per line. Exclusive tax is added; inclusive tax is extracted. Totals sum recorded line results. The agent must establish that this arithmetic model applies to the transaction; conditional discounts, special rebates and jurisdiction-specific calculation variants are not silently approximated.

## Work and expenses

Time, billable expenses and AI usage share source amounts that can be allocated to invoices. Recorded cost and price are separate. AI usage states whether it is measured or estimated. An ordinary expense may have no client or billable amount.

An expense with a billable amount creates one linked billable atomically. Editing that expense updates the same linked item; agents must not create it again. Unreserved and uninvoiced source items can be replaced with audit history. Reserved or billed items cannot be edited. Cancel drafts before changing their source work; issued source facts remain locked. References can point to external documents. Uploaded files are not stored in this build.

### Timers

Timers (Stefan, 2026-10-23) track work live. `timer_start` records a start on Otis's clock for a client and task; `timer_stop` records the end. Several timers can run at once, for the same or different clients; each belongs to the member who started it, and only that member or the owner can stop it. A user may report an earlier start or stop ("I started at 9"): it must carry a UTC offset, lie within the last 7 days and not in the future, and the stop cannot precede the start; Otis keeps its own clock times beside the reported ones and marks which were reported. Tracked time is exact to the minute: the duration rounds to the nearest whole minute and becomes hours to six decimals (83 minutes = 1.383333 h). Stopping with an hourly `rate_minor` records the time as one time billable (unit hours, amount = hours × rate rounded half up) linked by `timer_id`, which survives later corrections through `billable_record`; stopping without a rate leaves the timer stopped until a second `timer_stop` supplies the rate. Under a minute records nothing. A timer can be discarded instead. A stop after more than 12 hours returns a warning to confirm with the user. Timers never invoice anything by themselves.

## Partial billing

Available amount equals original amount minus reserved and invoiced source amounts. The state label is a summary; agents must inspect remaining amounts to find partially billable work.

Each draft reserves explicit source amounts. Concurrent drafts cannot allocate more than the source contains. Reservations persist until issuance or explicit cancellation; they do not expire silently. Cancelling releases them. Issuing moves them from reserved to invoiced atomically.

Discounts do not make the discounted portion available for rebilling: allocating 400 units and discounting the invoice to 360 still consumes 400 source units. Exclusive tax is additional to the source allocation; for an inclusive price, the source allocation includes that tax. Partial billing is by amount. The original quantity remains a source snapshot and must not be represented as the whole quantity supplied again on each partial invoice.

## Invoice lifecycle

Drafts snapshot business/client facts, source lines, tax treatment and totals. A draft can be cancelled and recreated, but not silently rewritten. Changed business or client facts make a draft stale and require renewed review.

Before issuance, the agent reads readiness feedback, resolves missing facts and asks the user to approve the exact contents and total. The server checks required recorded facts, allocations, permissions and expected total. It cannot independently prove human approval from the caller's confirmation flag or certify legal tax treatment.

Issuance assigns a sequential number atomically within the business. The owner may set a starting number before first issuance, plus a display prefix and padding. Numbers are never reused or reset after issuance. Default invoice notes and payment instructions are configurable and preserved in snapshots.

Issued structured contents remain immutable. Later client or business edits cannot rewrite them. Issuance, document generation and delivery are distinct events. The assistant generates a document from the recorded snapshot; Otis does not deliver invoices or claim delivery occurred.

⚠️ UNRESOLVED: The minimum correction/void workflow for issued invoices. This build cannot correct issued invoices; credit notes remain explicitly deferred. Do not treat immutable issued records as a completed correction workflow.

## Payments, retries and history

Payments are reported facts associated with an issued invoice. Partial payments are supported. A stable business-wide payment reference prevents duplicate effects, including when agents use different request IDs. Reusing a reference with different facts fails. Overpayments are rejected; unapplied credits and reversals are unavailable.

Every write has an actor-scoped idempotency key within the business. Identical retries return the saved result; different input under the same key fails. Permissions are checked before replaying a result, so removing access also blocks old retries. Financial mutations, their source allocations and audit records commit together.

Invoice balances are calculated from stored payments. Records and audit history can be exported as paginated JSON. Multi-page exports are not transactional backups and can reflect concurrent changes.

⚠️ UNRESOLVED: Payment reversals, credit balances, automated reconciliation, aggregate reporting beyond invoice balances, and a consistent export/import recovery workflow.
