import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ORIGIN: "https://otis.test",
          SITE_ORIGIN: "https://site.otis.test",
          SIGN_IN_ENABLED: "false",
          // The team logic stays tested; test/team-off.test.ts covers production, where teams are off.
          TEAM_ENABLED: "true",
          // workerd does not implement Durable Object jurisdictions; production uses "eu".
          DO_JURISDICTION: "local"
        }
      }
    })
  ],
  test: { include: ["test/**/*.test.ts"] }
});
