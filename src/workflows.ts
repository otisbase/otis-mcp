import type { Operation } from "./models";

type Workflow = {
  name: string; label: string; description: string;
  tools: Operation[]; demoTools: Operation[];
  steps: string[]; demoSteps: string[];
};

// One catalog for menu choices, MCP prompts and optional distribution packages.
export const workflows: Workflow[] = [
  {
    name: "create-invoice", label: "Create invoice", description: "Prepare an Otis invoice from available work, review tax and discounts, and issue only after exact-draft approval.",
    tools: ["clients_list", "client_save", "billables_list", "billable_record", "invoice_get", "invoice_draft", "invoice_check", "invoice_issue", "invoice_cancel_draft"],
    demoTools: ["invoices_list", "invoice_get", "invoice_check", "billables_list"],
    steps: [
      "Identify the client and requested work or existing draft. Read saved client details and billables, following pagination and remaining_minor rather than only state=unbilled. Ask for missing client, price, dates, partial amounts, discounts and tax facts. Record new work only if the user requests it; never create duplicate source items.",
      "Use invoice_draft for a new draft, or invoice_get for an existing one. Resolve invoice_check blockers; changed source facts may require cancelling and recreating the draft. Do not silently cancel another draft or reallocate its work.",
      "Show the exact draft contents, tax treatment, discounts and total. A create-invoice command is not approval to issue. Only after the user approves that specific draft and total, call invoice_issue with confirmed=true and expected_total_minor. Generate any document from the returned snapshot; issuance does not send it."
    ],
    demoSteps: ["List the demo invoices and available work. Read a selected demo invoice and invoice_check to explain the recorded lines, tax and readiness. Do not draft, issue or claim to save an invoice."]
  },
  {
    name: "record-work", label: "Record work", description: "Record or correct Otis billable time, services or reported AI usage, or start and stop a timer that tracks work time.",
    tools: ["clients_list", "client_save", "billables_list", "billable_record", "timer_start", "timer_stop", "timers_list"], demoTools: ["billables_list", "timers_list"],
    steps: ["When the user is starting work now, use timer_start for the client and task; when they say they stopped, use timers_list to find the running timer and timer_stop. Pass a reported time only if the user gives one. Ask for the hourly rate if it is not known, and pass rate_minor so the tracked hours are recorded as billable work. Several timers can run; never stop one the user did not mean.", "Identify the client, description, kind, quantity/unit, supplied amount and optional rate/cost. AI usage must be explicitly measured or estimated; do not measure or price it automatically. Inspect existing records when the request might be an edit or duplicate.", "Create with billable_record, or preserve item_id when correcting an unreserved, uninvoiced item. Do not edit linked expenses through this tool. Return the recorded facts and remaining billable amount; saving work does not invoice it."],
    demoSteps: ["List the demo billables and explain cost versus price, measured versus estimated usage, and remaining/reserved/invoiced amounts. Do not collect real work to save."]
  },
  {
    name: "add-expense", label: "Add expense", description: "Record or correct an Otis expense, optionally billable to a client.",
    tools: ["clients_list", "expenses_list", "expense_record"], demoTools: ["expenses_list"],
    steps: ["Collect vendor, category, description, date and cost. Ask whether the expense belongs to a client and whether it should be billable; cost and billable amount are separate facts. Inspect prior records if this might be an edit or duplicate.", "Use expense_record with expense_id for an edit. A billable_amount_minor creates or updates one linked billable atomically; do not call billable_record for it again. Preserve required existing values during replacement. Report what was saved; references are links, not uploaded attachments."],
    demoSteps: ["Read the demo expenses and explain their cost, client association and linked billables. Do not save expenses or claim to upload receipts."]
  },
  {
    name: "clients", label: "Clients", description: "Find Otis clients and maintain confirmed billing and tax details.",
    tools: ["clients_list", "client_save"], demoTools: ["clients_list"],
    steps: ["Clarify whether the user wants to find, add or edit a client. List and paginate first to identify existing matches; resolve ambiguity before writing.", "For a save, collect confirmed billing details and relevant country/region, business/consumer status, tax IDs and evidence. Use client_id for an edit and retain existing fields: client_save replaces details. Never infer country or tax status from currency. Explain that edits do not rewrite issued invoices and can make drafts stale."],
    demoSteps: ["List fictional clients and explain their available billing and tax facts. Do not save real client details."]
  },
  {
    name: "invoices", label: "Invoices", description: "Review Otis drafts, issued invoices and recorded balances, or cancel a specifically requested draft.",
    tools: ["invoices_list", "invoice_get", "invoice_check", "invoice_cancel_draft"], demoTools: ["invoices_list", "invoice_get", "invoice_check"],
    steps: ["Read and paginate invoices, then inspect the selected invoice or its readiness with invoice_get and invoice_check. Balances reflect reported payments, not verified bank activity.", "Cancel only a specifically requested unissued draft with its reason; explain released reservations. Issued corrections and voids are unavailable. Creating or issuing an invoice uses the create-invoice workflow with separate exact-draft approval. Reporting a payment uses the payments workflow."],
    demoSteps: ["Read the demo invoices and readiness, then show the recorded contents and balances. Do not cancel or issue anything, and never imply these fictional records are the user's."]
  },
  {
    name: "payments", label: "Payments", description: "Review or record reported partial/full payments for issued Otis invoices.",
    tools: ["invoices_list", "invoice_get", "payments_list", "payment_record"], demoTools: ["invoices_list", "invoice_get", "payments_list"],
    steps: ["Clarify whether the user wants to review payments or record one. Read the relevant invoice and payments; paginate results. These are reported facts, not verified bank activity.", "Before payment_record, establish the issued invoice, actual received amount/date and stable business-wide reference. Reuse that reference for the same payment. Resolve mismatches or overpayments rather than splitting them to hide a conflict. Payment reversals and unapplied credits are unavailable. Return the recorded payment and updated invoice balance."],
    demoSteps: ["Read the demo payments and their invoices, then explain recorded paid and outstanding balances. Do not record a payment or imply bank verification."]
  },
  {
    name: "business-settings", label: "Business settings", description: "Review or set up Otis business identity, currency and invoice preferences; only owners can save changes.",
    tools: ["business_get", "business_set"], demoTools: ["business_get"],
    steps: ["Read business_get and ask only for missing or explicitly changed facts: business name, currency, billing address and invoice preferences. Show the profile before saving with business_set. Preserve existing values; currency locks after financial records and the starting number locks after first issuance. Only owners can save changes.", "Keep tax registration and treatment in the separate tax-settings workflow. Do not infer tax facts from currency or imply business setup completes tax setup."],
    demoSteps: ["Read the fictional business and explain identity, currency and invoice preferences. Do not save a real business profile."]
  },
  {
    name: "tax-settings", label: "Tax settings", description: "Review Otis tax guidance and confirmed registrations; only owners can save a tax profile.",
    tools: ["business_get", "tax_guide", "tax_profile_set"], demoTools: ["business_get", "tax_guide"],
    steps: ["Read the saved business tax profile and tax_guide for the confirmed country. Establish seller location, registrations, customer location/status, service and dates as relevant; do not infer these from currency.", "For a requested change, confirm registration details, effective/review dates and notes before tax_profile_set. Unknown remains unknown; never default to not registered or zero tax. Only owners can save tax settings. Country guidance and field validation do not certify legal liability or select an automatic rate."],
    demoSteps: ["Read the fictional tax profile and tax_guide for a selected country. Explain missing facts and dated guidance without saving a real profile or inferring tax liability."]
  },
  {
    name: "export", label: "Export", description: "Export Otis records or audit history as paginated JSON using current read permissions.",
    tools: ["records_export"], demoTools: ["records_export"],
    steps: ["Ask which record kinds to export: business, client, billable, expense, invoice, payment or audit. Use records_export for each selected kind and follow next_offset until null; do not silently present one page as the whole export.", "Keep the selected business clear and preserve recorded values and currency. State which kinds were exported and any incomplete pages. Exports are not transactional backups and cannot be imported/restored by Otis. Viewers may export records they can access."],
    demoSteps: ["Export selected fictional record kinds with records_export and follow next_offset. Label the output as the fictional demo account; do not imply it is a backup of a real business."]
  }
];

export function workflowText(workflow: Workflow, demo: boolean, origin: string): string {
  return [
    `Help me with Otis: ${workflow.label}.`, "",
    demo
      ? `This is the read-only demo account, Northstar Studio, with fictional records. Use only the listed demo tools. For real records and saving, the user must connect ${origin}/mcp. Do not collect real inputs to save here.`
      : `Use the connected Otis MCP at ${origin}/mcp. If its tools are unavailable, explain connection and email-code sign-in in the browser; never ask for codes in chat or simulate a successful action.`,
    ...(!demo ? ["First find the business with businesses_list and pass its business_id on scoped calls. Read business_get for missing setup."] : []),
    "Read otis://docs/workflows when available. Ask only for missing facts. Never invent prices, payments, tax treatment or consent. Monetary values use integer currency minor units. Reuse a stable request_id for identical write retries; follow structured blockers instead of guessing.",
    `Workflow tools: ${(demo ? workflow.demoTools : workflow.tools).join(", ") || "none — connection guidance only"}.`, "",
    ...(demo ? workflow.demoSteps : workflow.steps).map((step, index) => `${index + 1}. ${step}`),
    "", "Stay within the requested workflow. A command starts guided work; it does not approve unspecified writes or invoice issuance. Show the recorded result and any remaining steps."
  ].join("\n");
}

/** The Team workflow, kept for a possible Pro plan; not in the menu or the plugins while teams are off (see TEAM_OPERATIONS). */
export const teamWorkflow: Workflow = {
    name: "team", label: "Team", description: "Review Otis invitations and team access; owners can invite or change editor/viewer membership.",
    tools: ["businesses_list", "team_list", "team_accept", "team_invite", "team_member_set"], demoTools: [],
    steps: ["Use businesses_list to distinguish pending invitations from active access. Ask which invitation to accept if needed, then use its business_id and invitation_id with team_accept only when the user requests acceptance.", "For an active business, read team_list. Only owners can invite or change membership. Confirm the exact person and editor/viewer role or removal before writing; the owner cannot be removed or downgraded.", "Invitations last seven days and are discovered through MCP. No invitation email is sent. Explain how the recipient connects using the invited email and accepts; do not claim delivery or accepted access before it occurs."],
    demoSteps: ["Explain owner/editor/viewer roles and invitation acceptance. Team records are not exposed in the demo account. Offer the private MCP connection without creating or sending an invitation."]
  };
