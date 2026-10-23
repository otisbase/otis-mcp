import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { privateOperation } from "../src/mcp";
import { connected, localFetch, origin } from "./auth-fixture";

const labels = ["Create invoice", "Record work", "Add expense", "Clients", "Invoices", "Payments", "Business settings", "Tax settings", "Export"];
const names = ["create-invoice", "record-work", "add-expense", "clients", "invoices", "payments", "business-settings", "tax-settings", "export"];

describe("Otis conversational menu", () => {
  it.each([false, true])("discovers the prompt and tool with matching choices (demo=%s)", async demo => {
    const client = demo ? new Client({ name: "menu-test", version: "1" }) : (await connected()).client;
    if (demo) await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/demo/mcp`), { fetch: localFetch() }));
    try {
      expect(client.getInstructions()).toContain("otis_menu");
      expect(client.getInstructions()).toContain("without a menu detour");
      const prompts = (await client.listPrompts()).prompts;
      expect(prompts).toEqual(expect.arrayContaining([expect.objectContaining({ name: "otis", title: "Otis menu" }), expect.objectContaining({ name: "setup-business" })]));
      expect(prompts.map(p => p.name).sort()).toEqual(["otis", "setup-business", "invoices-and-payments", ...names].sort());
      const tools = (await client.listTools()).tools;
      expect(tools.find(tool => tool.name === "otis_menu")?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
      const response = await client.callTool({ name: "otis_menu", arguments: {} });
      expect(response.isError).not.toBe(true);
      const menu = (response.structuredContent as any).data;
      expect(menu.demo).toBe(demo);
      expect(menu.connection_url).toBe(`${origin}/mcp`);
      expect(menu.options.map((option: any) => option.label)).toEqual(labels);
      expect(menu.options.map((option: any) => option.prompt_name)).toEqual(names);
      expect(menu.options.map((option: any) => option.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(menu.text).not.toContain("&");
      expect(menu.options.find((option: any) => option.prompt_name === "invoices").tools).not.toContain("payment_record");
      expect(menu.options.find((option: any) => option.prompt_name === "business-settings").tools).not.toContain("tax_profile_set");
      for (const option of menu.options) for (const name of option.tools) {
        const tool = tools.find(t => t.name === name);
        expect(tool, `${option.label}: ${name}`).toBeDefined();
        if (demo) expect(tool?.annotations?.readOnlyHint).toBe(true);
      }
      for (const option of menu.options) {
        const workflow = await client.getPrompt({ name: option.prompt_name });
        const instructions = (workflow.messages[0].content as { text: string }).text;
        expect(workflow.messages).toHaveLength(1);
        expect(instructions).toContain(`Help me with Otis: ${option.label}.`);
        expect(instructions).toContain("does not approve unspecified writes or invoice issuance");
        for (const step of option.steps) expect(instructions).toContain(step);
        for (const tool of option.tools) expect(instructions).toContain(tool);
        if (demo) {
          expect(instructions).toContain("read-only demo account");
          expect(instructions).toContain("Do not collect real inputs to save here");
        } else {
          expect(instructions).toContain("businesses_list");
          expect(instructions).toContain("Team access is not available");
          if (option.prompt_name === "create-invoice") expect(instructions).toContain("A create-invoice command is not approval to issue");
        }
      }
      await expect(client.getPrompt({ name: "delete-all-records" })).rejects.toThrow();
      const prompt = await client.getPrompt({ name: "otis" });
      expect(prompt.messages).toHaveLength(1);
      expect(prompt.messages[0]).toMatchObject({ role: "user", content: { type: "text" } });
      const text = (prompt.messages[0].content as { text: string }).text;
      expect(text).toContain(menu.text);
      expect(text).toContain("wait for the user's choice");
      expect(text).toContain("approval of the exact draft and total");
      if (demo) {
        expect(text).toContain("fictional records");
        expect(text).not.toContain("Team");
        expect(text).toContain("Never ask for real business inputs to save in the demo");
      } else {
        expect(text).not.toContain("(demo)");
        expect(text).toContain("Team access is not available");
        expect(text).not.toContain("Viewers can read/export");
        expect((await client.callTool({ name: "business_get", arguments: {} })).structuredContent).toMatchObject({ ok: true, data: { setup_required: true } });
      }
      expect((await client.callTool({ name: "otis_menu", arguments: {} })).structuredContent).toEqual(response.structuredContent);
    } finally { await client.close(); }
  });

  it("returns navigation without any storage bindings or a configured business", async () => {
    const noStorage = { ORIGIN: origin } as Env;
    const result = await privateOperation(noStorage, { userId: "new-user-with-no-business" }, "otis_menu", {});
    expect(result).toMatchObject({ ok: true, data: { demo: false, options: expect.any(Array) } });
    expect(JSON.stringify(result)).not.toContain("new-user-with-no-business");
  });
});
