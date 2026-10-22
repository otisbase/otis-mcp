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
          // workerd does not implement Durable Object jurisdictions; production uses "eu".
          DO_JURISDICTION: "local"
        }
      }
    })
  ],
  test: { include: ["test/**/*.test.ts"] }
});
