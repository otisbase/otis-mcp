import { workflows } from "./workflows";

/** Static navigation only: opening the menu never reads or changes business records. */
export function otisMenu(demo: boolean, origin: string) {
  const options = workflows.map((choice, index) => ({
    number: index + 1, label: choice.label, description: choice.description, prompt_name: choice.name,
    tools: demo ? choice.demoTools : choice.tools, steps: demo ? choice.demoSteps : choice.steps
  }));
  const text = ["Otis — what would you like to do?", "",
    ...(demo ? ["Demo account: explore Northstar Studio, a fictional consultancy. Saving records requires the private connection.", ""] : []),
    ...options.map(option => `${option.number}. ${option.label}${demo ? option.tools.length ? " (demo)" : " (connect to use)" : ""}`),
    "", "Reply with a number, name an option, or describe what you need."
  ].join("\n");
  const guidance = [
    "Show the menu as a short numbered list in the conversation, then wait for the user's choice. Showing this menu does not authorize any business action.",
    "Use the selected option's tools only after the user chooses a task. Ask only for missing facts; never invent prices, payments, tax treatment or consent.",
    demo
      ? `Only read the demo account's fictional records. Never ask for real business inputs to save in the demo. For saving, explain how to connect ${origin}/mcp; reading a website does not install it.`
      : "Before a business task, use businesses_list to find the business. Use business_get to find missing setup.",
    "Read otis://docs/workflows for the selected workflow. For invoices, inspect remaining_minor, establish tax treatment, call invoice_check, resolve blockers, and obtain approval of the exact draft and total before invoice_issue. Issuance does not send an invoice.",
    "Users can ask 'show Otis menu' at any time. A host may expose the otis prompt as /otis, a namespaced command or a prompt picker; do not promise a particular slash-command UI."
  ];
  return { ok: true as const, data: { title: "Otis menu", demo, text, options, guidance, connection_url: `${origin}/mcp` } };
}

export const menuInstructions = "At first relevant use, briefly introduce the Otis menu. If the user has no task yet, or asks for /otis or 'show Otis menu', call otis_menu and present its choices. If the user already requested a task, proceed with it without a menu detour. Opening the menu never authorizes business actions.";
