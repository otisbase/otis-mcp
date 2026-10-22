# Spec guide

## Status and authority

Otis has a deployed backend with public and authenticated MCP verification. These files describe the agreed product contract and explicit remaining gaps. They cover the MCP service in this repository; the otisbase.com website is maintained separately.

## Reading order

1. [Product](02-product.md): audience, purpose, scope, and commercial posture.
2. [Records and billing](03-records-and-billing.md): authority, integrity, and unsettled lifecycle rules.
3. [Service](04-service.md): Cloudflare, the MCP interface, onboarding, and distribution.
4. [Tax guidance](05-tax-guidance.md): country guides and the boundary between guidance and enforcement.

## Editing rules

- Write the spec in the present tense and edit it in place. Do not accumulate history here.
- Include intent, definitions, commercial rules, invariants, and deliberate choices an agent could otherwise misunderstand.
- Keep schemas and implementation details in code when implementation exists. The spec does not duplicate code.
- Rules marked `⚠️ UNRESOLVED` are not decided. Discussion proposals are not approved scope.
- Never describe an unimplemented plan as a working result.

There is no operational UI. The sign-in and consent pages are the only web pages this service renders.
