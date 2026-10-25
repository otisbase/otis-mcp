import { DurableObject } from "cloudflare:workers";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";

type Flow = {
  request: AuthRequest;
  clientName: string;
  cookieHash: string;
  csrf: string;
  expires: number;
  attempts: number;
  email?: string;
  codeHash?: string;
  used: boolean;
};

export class SignInStore extends DurableObject<Env> {
  async create(flow: Omit<Flow, "attempts" | "used">): Promise<void> {
    this.ctx.storage.kv.put("flow", { ...flow, attempts: 0, used: false } satisfies Flow);
    await this.ctx.storage.setAlarm(flow.expires);
  }

  read(cookieHash: string, csrf: string): Flow | null {
    const flow = this.ctx.storage.kv.get<Flow>("flow");
    return flow && flow.expires > Date.now() && !flow.used &&
      flow.cookieHash === cookieHash && flow.csrf === csrf ? flow : null;
  }

  setCode(cookieHash: string, csrf: string, email: string, codeHash: string): boolean {
    const flow = this.read(cookieHash, csrf);
    // One delivery per flow: starting again creates a new, rate-limited flow.
    if (!flow || flow.codeHash) return false;
    this.ctx.storage.kv.put("flow", { ...flow, email, codeHash });
    return true;
  }

  cancel(cookieHash: string, csrf: string): boolean {
    const flow = this.read(cookieHash, csrf);
    if (!flow) return false;
    this.ctx.storage.kv.put("flow", { ...flow, used: true });
    return true;
  }

  verify(cookieHash: string, csrf: string, codeHash: string): Flow | null {
    const flow = this.read(cookieHash, csrf);
    if (!flow || !flow.email || !flow.codeHash || flow.attempts >= 5) return null;
    const valid = flow.codeHash === codeHash;
    this.ctx.storage.kv.put("flow", { ...flow, attempts: flow.attempts + 1, used: valid });
    return valid ? flow : null;
  }

  /** Whether this limiter has reached its limit, without counting a new attempt. */
  blocked(limit: number): boolean {
    const rate = this.ctx.storage.kv.get<{ count: number; until: number }>("rate");
    return !!rate && rate.until > Date.now() && rate.count >= limit;
  }

  async allow(limit: number, windowMs: number): Promise<boolean> {
    const now = Date.now();
    const previous = this.ctx.storage.kv.get<{ count: number; until: number }>("rate");
    const rate = previous && previous.until > now ? previous : { count: 0, until: now + windowMs };
    if (rate.count >= limit) return false;
    this.ctx.storage.kv.put("rate", { count: rate.count + 1, until: rate.until });
    await this.ctx.storage.setAlarm(rate.until);
    return true;
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
