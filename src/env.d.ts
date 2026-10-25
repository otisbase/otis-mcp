// Secrets set with `wrangler secret put`, which `wrangler types` cannot see.
interface Env {
  /** The directory reviewer's sign-in address; with REVIEW_CODE it skips the emailed code (src/auth.ts). */
  REVIEW_EMAIL?: string;
  /** The reviewer's fixed six-digit sign-in code. Delete either secret to switch reviewer sign-in off. */
  REVIEW_CODE?: string;
  /** The domain-verification token from OpenAI's plugin portal, served at /.well-known/openai-apps-challenge. */
  OPENAI_APPS_CHALLENGE?: string;
  /** Comma-separated verified sign-in emails that get the admin tools (src/admin.ts). */
  ADMIN_EMAILS?: string;
  /** Comma-separated addresses that get the “New Otis sign-up” email. Unset: no sign-up emails. */
  SIGNUP_NOTICE_TO?: string;
  /** Comma-separated QA and test emails left out of the admin stats. */
  INTERNAL_EMAILS?: string;
  /** Read-only Cloudflare API token for the Analytics Engine SQL API, used by admin_usage. */
  ANALYTICS_API_TOKEN?: string;
}
