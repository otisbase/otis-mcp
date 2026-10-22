# Contributing to Otis MCP

Thank you for helping. Otis handles business records and invoices, so changes must keep the records correct.

## Report a problem or suggest a feature

Open an issue on GitHub. For a bug, include the tool name, the input you sent and the result you got. Do not include real client data.

You can also ask your assistant to send feedback to Otis. It uses the `feedback_send` tool.

## Before you change code

1. Read [spec/01-README.md](spec/01-README.md) and the spec files it lists. The spec defines what Otis does and the rules it enforces.
2. Rules marked `⚠️ UNRESOLVED` in the spec are not decided. Open an issue to discuss them before you write code.
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
- If your change alters product behavior, update the relevant file in `spec/`.

## Pull requests

Keep each pull request to one change. Describe what changed, why, and how you tested it. By contributing, you agree that your contribution is released under the [MIT License](LICENSE).
