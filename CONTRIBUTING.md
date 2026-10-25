# Contributing to Otis MCP

Thank you for helping. Otis handles business records and invoices, so changes must keep the records correct.

## Report a problem or suggest a feature

Open an issue on GitHub. For a bug, include the tool name, the input you sent and the result you got. Do not include real client data.

You can also ask your assistant to send feedback to Otis. It uses the `feedback_send` tool.

## Before you change code

1. Read the [MCP docs](https://otisbase.com/docs) and the tests in `test/`. Together they define what Otis does and the rules it enforces.
2. For a change in behavior, open an issue to discuss it before you write code.
3. Otis is MCP-only. Pull requests that add a dashboard, an operational web UI or a client portal will not be merged.
4. Otis runs no AI model. The assistant supplies the business facts; Otis stores and checks them.

## Make a change

```bash
npm ci
npm run check
npm test
```

- Add or update tests in `test/` for every change in behavior.
- Keep amounts as integers in minor units.
- Keep each write idempotent through its `request_id`.
- If you change `src/workflows.ts`, run `npm run plugins:build`.
- If your change alters product behavior, update the agent docs in `src/docs.ts` and the tool descriptions to match.

## Pull requests

Keep each pull request to one change. Describe what changed, why, and how you tested it. By contributing, you agree that your contribution is released under the [MIT License](LICENSE).
