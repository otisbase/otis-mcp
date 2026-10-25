import { describe, expect, it } from "vitest";
import { authFlow } from "./auth-fixture";

describe("directory reviewer sign-in", () => {
  const reviewer = { REVIEW_EMAIL: "Review@Otis.test", REVIEW_CODE: "482915" };

  it("accepts the fixed code for the reviewer address without sending email", async () => {
    const flow = await authFlow({ email: "review@otis.test", bindings: reviewer });
    expect((await flow.send()).status).toBe(200);
    expect(flow.deliveries).toHaveLength(0);
    const verified = await flow.post("/authorize/verify", { code: "482915" });
    expect(verified.status).toBe(303);
    const exchanged = await flow.exchange(new URL(verified.headers.get("Location")!).searchParams.get("code")!);
    expect(exchanged.status).toBe(200);
  });

  it("lets the shared reviewer address start more sign-ins than the per-email sending limit", async () => {
    for (let i = 0; i < 7; i++) {
      const flow = await authFlow({ email: "review@otis.test", bindings: reviewer });
      expect((await flow.send()).status).toBe(200);
    }
  });

  it("rejects a wrong code for the reviewer address", async () => {
    const flow = await authFlow({ email: "review@otis.test", bindings: reviewer });
    expect((await flow.send()).status).toBe(200);
    expect((await flow.post("/authorize/verify", { code: "111111" })).status).toBe(400);
  });

  it("emails a code to every other address, and to the reviewer once the code secret is gone", async () => {
    const other = await authFlow({ bindings: reviewer });
    expect((await other.send()).status).toBe(200);
    expect(other.deliveries).toHaveLength(1);
    const off = await authFlow({ email: "review@otis.test", bindings: { REVIEW_EMAIL: reviewer.REVIEW_EMAIL } });
    expect((await off.send()).status).toBe(200);
    expect(off.deliveries).toHaveLength(1);
    expect((await off.post("/authorize/verify", { code: "482915" })).status).toBe(400);
  });
});

describe("OpenAI domain verification", () => {
  it("serves only the token, and nothing until it is set", async () => {
    const { localFetch, origin } = await import("./auth-fixture");
    const { env } = await import("cloudflare:workers");
    const path = `${origin}/.well-known/openai-apps-challenge`;
    expect((await localFetch()(path)).status).toBe(404);
    const response = await localFetch({ ...env, OPENAI_APPS_CHALLENGE: "token-123" })(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("token-123");
  });
});
