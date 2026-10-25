import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { FAILED_CODES_PER_DAY, SIGN_IN_EMAILS_PER_HOUR } from "../src/auth";
import { networkKey, oneLine } from "../src/html";
import { eu } from "../src/regions";
import { authFlow, origin, rid } from "./auth-fixture";

describe("sign-in abuse limits", () => {
  it("locks an email for a day after repeated wrong codes, across flows", async () => {
    const email = `${rid()}@example.com`;
    for (let flow = 0; flow < FAILED_CODES_PER_DAY / 5; flow++) {
      const f = await authFlow({ email });
      expect((await f.send()).status).toBe(200);
      const wrong = f.code() === "000000" ? "111111" : "000000";
      for (let guess = 0; guess < 5; guess++) expect((await f.post("/authorize/verify", { code: wrong })).status).toBe(400);
    }
    const locked = await authFlow({ email });
    const refused = await locked.send();
    expect(refused.status).toBe(429);
    expect(await refused.text()).toContain("Too many wrong codes.");
    expect(locked.deliveries).toHaveLength(0);
  });

  it("stops sending code emails at the hourly total", async () => {
    const all = eu(env.SIGN_INS).getByName("send:all");
    for (let i = 0; i < SIGN_IN_EMAILS_PER_HOUR; i++) await all.allow(SIGN_IN_EMAILS_PER_HOUR, 3_600_000);
    const f = await authFlow();
    expect((await f.send()).status).toBe(503);
    expect(f.deliveries).toHaveLength(0);
  }, 30_000);

  it("keys IPv6 by its /64 and leaves IPv4 alone", () => {
    expect(networkKey("2001:db8:abcd:12:1:2:3:4")).toBe("2001:db8:abcd:12::/64");
    expect(networkKey("2001:0db8:abcd:0012::99")).toBe("2001:db8:abcd:12::/64");
    expect(networkKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(networkKey("203.0.113.7")).toBe("203.0.113.7");
  });

  it("names the client in one short line and shows where access goes", async () => {
    expect(oneLine("Claude\n Official  app")).toBe("Claude Official app");
    expect(oneLine("x".repeat(200))).toHaveLength(80);
    const f = await authFlow();
    expect(await (await f.fetcher(`${origin}/authorize?${f.parameters}`)).text()).toContain("<strong>Local security checks</strong> at <strong>127.0.0.1:8912</strong> wants to read and change your business records.");
  });
});
