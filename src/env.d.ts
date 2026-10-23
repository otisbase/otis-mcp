// Secrets set with `wrangler secret put`, which `wrangler types` cannot see.
interface Env {
  /** The directory reviewer's sign-in address; with REVIEW_CODE it skips the emailed code (src/auth.ts). */
  REVIEW_EMAIL?: string;
  /** The reviewer's fixed six-digit sign-in code. Delete either secret to switch reviewer sign-in off. */
  REVIEW_CODE?: string;
}
