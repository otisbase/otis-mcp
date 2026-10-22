import { env } from "cloudflare:workers";

/**
 * Every Durable Object lives in Cloudflare's EU jurisdiction (`DO_JURISDICTION` = "eu" in wrangler.jsonc), so
 * business records, accounts, sign-ins and feedback are stored and processed in the European Union. Local dev and
 * tests set it to "local", because workerd does not implement jurisdictions. Objects created before the switch
 * (2026-10-22) sit outside any jurisdiction; Cloudflare cannot move them, and the same name maps to a new object here.
 */
export function eu<T extends Rpc.DurableObjectBranded | undefined>(namespace: DurableObjectNamespace<T>): DurableObjectNamespace<T> {
  return env.DO_JURISDICTION === "eu" ? namespace.jurisdiction("eu") : namespace;
}
