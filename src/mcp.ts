import { McpServer } from "@modelcontextprotocol/server";
import { eu } from "./regions";
import { oneLine } from "./html";
import { notifyInvite } from "./notify";
import { createMcpHandler } from "agents/mcp/server";
import { schemas, READ_OPERATIONS, TEAM_OPERATIONS, offeredOperations, teamEnabled, type Operation, type DomainResult } from "./models";
import { demoResult } from "./demo";
import { digest, type Identity } from "./auth";
import { guideFor, taxGuideMarkdown } from "./tax-guidance";
import { operationDocs } from "./docs";
import { otisMenu, menuInstructions } from "./menu";
import { workflows, workflowText } from "./workflows";
import { sendFeedback } from "./feedback";
import { z } from "zod";
import { descriptions } from "./descriptions";

export async function privateOperation(env: Env, identity: Identity, operation: Operation, input: unknown): Promise<DomainResult> {
  const parsed = schemas[operation].parse(input);
  if (operation === "otis_menu") return otisMenu(false, env.ORIGIN);
  if (operation === "tax_guide") return { ok: true, data: guideFor(schemas.tax_guide.parse(parsed).country) };
  // A separate opaque identifier avoids exposing the authentication subject as a business ID.
  const team = teamEnabled(env);
  if (!team && TEAM_OPERATIONS.has(operation)) return { ok: false, code: "NOT_AVAILABLE", message: "Team access is not available." };
  const homeId = await digest(`otis-business:${identity.userId}`);
  if (operation === "feedback_send") return sendFeedback(env, identity, homeId, schemas.feedback_send.parse(parsed));
  const account = eu(env.ACCOUNTS).getByName(identity.userId);
  if (operation === "businesses_list") {
    await account.add(homeId);
    const p = schemas.businesses_list.parse(parsed), list = await account.list(p.limit, p.offset);
    const records = [];
    for (const businessId of list.ids) {
      const member = await eu(env.BUSINESSES).getByName(businessId).membership(identity.userId);
      // An invitation's business name is set by whoever invited you: pass it on as a short, one-line label.
      // Teams off: list only businesses this person owns.
      if (member && !team && member.role !== "owner") continue;
      if (member) records.push({ business_id: businessId, ...member, ...(member.status === "invited" && member.business_name ? { business_name: oneLine(member.business_name) } : {}) });
      else if (businessId === homeId) records.push({ business_id: businessId, setup_required: true });
    }
    return { ok: true, data: { records, next_offset: list.next_offset } };
  }
  const businessId = "business_id" in parsed && parsed.business_id ? String(parsed.business_id) : homeId;
  const inviteeId = operation === "team_invite" ? await digest(`otis-user:${schemas.team_invite.parse(parsed).email}`) : undefined;
  const result = JSON.parse(await eu(env.BUSINESSES).getByName(businessId).execute(operation, parsed, { userId: identity.userId, home: businessId === homeId, inviteeId, team })) as DomainResult;
  if (result.ok) {
    // Retrying an acknowledged business operation repairs an interrupted index write.
    await account.add(businessId);
    if (inviteeId) {
      await eu(env.ACCOUNTS).getByName(inviteeId).add(businessId);
      const invite = schemas.team_invite.parse(parsed);
      if (identity.email) await notifyInvite(env, identity.email, invite.email, invite.role);
    }
    return { ok: true, data: { ...(result.data as object), business_id: businessId } };
  }
  return result;
}
export async function handleMcp(request: Request, env: Env, ctx: ExecutionContext, identity?: Identity): Promise<Response> {
  const demo = !identity;
  const factory = () => {
    const server = new McpServer({ name: demo ? "otis-demo" : "otis", version: "0.1.0" }, {
      instructions: `${demo ? `Demo account with fictional records, read-only. Never present them as the user's data. Connect ${env.ORIGIN}/mcp to save records.` : "Otis stores business records. The agent supplies facts and creates documents. Call businesses_list to find your business."} ${menuInstructions} Read otis://docs/workflows or tax_guide for setup guidance. Ask for missing facts; never invent prices, payments, tax treatment or consent. Stable request_id on retries. Money uses integer minor units. Check remaining_minor for partial billing. Read invoice_check, resolve blockers, and ask approval of the exact draft before invoice_issue.${demo ? "" : " When the user wants something Otis cannot do, asks for a feature or hits a problem, offer feedback_send; show the exact message and send only with their approval."} Guidance is advisory; server checks enforce data and permission rules.`
    });
    server.registerResource("workflows", "otis://docs/workflows", { mimeType: "text/markdown", description: "Otis setup, billing and error workflows." }, async uri => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: operationDocs }] }));
    server.registerResource("tax-setup", "otis://docs/tax", { mimeType: "text/markdown", description: "Dated official-source guidance for US, Canada, UK and Australia. Never automatic tax determination." }, async uri => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: taxGuideMarkdown() }] }));
    server.registerPrompt("setup-business", { description: "Guide a business through Otis setup using confirmed facts." }, async () => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: "Help me set up Otis. Read otis://docs/workflows, call business_get, and ask only for missing business facts. Read tax_guide for my country before collecting registrations. Never infer tax treatment from my currency. Show me the profile before saving it." } }] }));
    server.registerPrompt("otis", { title: "Otis menu", description: "Open the Otis chat menu: invoices, work, expenses, clients, payments, settings and export." }, async () => {
      const menu = otisMenu(demo, env.ORIGIN).data;
      return { messages: [{ role: "user" as const, content: { type: "text" as const, text: `Show me this Otis menu:\n\n${menu.text}\n\nGuidance for the assistant:\n${menu.guidance.join("\n")}` } }] };
    });
    for (const workflow of workflows) {
      server.registerPrompt(workflow.name, { title: workflow.label, description: demo ? `Explore ${workflow.label.toLowerCase()} in the fictional demo account. Read-only; saving requires the private connection.` : workflow.description }, async () => ({
        messages: [{ role: "user" as const, content: { type: "text" as const, text: workflowText(workflow, demo, env.ORIGIN) } }]
      }));
    }
    // Compatibility for the earlier combined prompt; keep it out of the menu and plugin skills.
    server.registerPrompt("invoices-and-payments", { description: "Legacy shortcut. Choose the independent Invoices or Payments workflow." }, async () => ({
      messages: [{ role: "user" as const, content: { type: "text" as const, text: `Help me choose between the Otis invoices and payments workflows. Ask which task I need, then use its named prompt or the mapped steps from otis_menu. ${demo ? "This connection is a read-only fictional demo." : "Do not perform a write merely because I opened this shortcut."}` } }]
    }));
    for (const operation of offeredOperations(teamEnabled(env))) {
      if (demo && (!READ_OPERATIONS.has(operation) || ["businesses_list", "team_list"].includes(operation))) continue;
      server.registerTool(operation, {
        description: descriptions[operation], inputSchema: schemas[operation].shape,
        annotations: { readOnlyHint: READ_OPERATIONS.has(operation), destructiveHint: !READ_OPERATIONS.has(operation) && operation !== "feedback_send", idempotentHint: true, openWorldHint: operation === "feedback_send" }
      }, async (input: unknown) => {
        try {
          const result = operation === "otis_menu" ? otisMenu(demo, env.ORIGIN)
            : operation === "tax_guide" ? { ok: true, data: guideFor(schemas.tax_guide.parse(input).country) }
            : demo ? demoResult(operation, input) : await privateOperation(env, identity!, operation, input);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown>, isError: (result as { ok: boolean }).ok === false };
        } catch (e) {
          const result = { ok: false, code: e instanceof z.ZodError ? "INVALID_INPUT" : "RETRY", message: e instanceof z.ZodError ? z.prettifyError(e) : "Otis could not complete the request. Retry with the same request_id." };
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result, isError: true };
        }
      });
    }
    return server;
  };
  return createMcpHandler(factory, { route: demo ? "/demo/mcp" : "/mcp", allowedHostnames: [new URL(env.ORIGIN).hostname], allowedOriginHostnames: [new URL(env.ORIGIN).hostname, new URL(env.SITE_ORIGIN).hostname] })(request, env, ctx);
}
