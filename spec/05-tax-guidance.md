# Tax guidance and agent feedback

## Purpose

Otis helps an agent collect and preserve invoice-tax facts. It does not decide tax liability, register a business, calculate income tax, file returns or act as a legal tax certification service.

Guides cover the US, Canada, UK and Australia as an additional example. Each guide records its review date, points to official authorities and identifies questions to investigate. Current guide text and citations live in src/tax-guidance.ts and are served through both docs and the tax_guide MCP tool. That shared source prevents the website and MCP from giving different guidance.

## General rule

Establish seller location and registrations, customer location and business/consumer status, exact service, transaction date and applicable place-of-supply rules before choosing treatment. Country or currency alone never determines a tax rate. Missing facts remain unknown. Agents ask the user or their accountant when necessary and can retain a draft without issuing it.

US guidance highlights state/local collection obligations and service classification. Canadian guidance distinguishes GST/HST place-of-supply rules from separate provincial obligations. UK guidance highlights registration, B2B/B2C status and cross-border service rules. Australia provides a GST example. Examples and thresholds are dated orientation, never hardcoded automatic invoice defaults.

## Responsibility boundary

The user/agent supplies and confirms the treatment, rationale, components and evidence. Otis stores them and checks arithmetic. Required fields and a registration-status check are not proof of correct liability, jurisdiction, rate, tax point or valid registration. The business may have revenue or obligations outside Otis; its records alone cannot establish registration thresholds or nexus.

Agents recheck official guidance when jurisdiction, service type, registration or relevant law changes. The guide is not automatically refreshed. Do not advertise the set of country guides as complete tax-engine coverage.

Readiness feedback identifies missing fields, why they matter and the next tool. Unknown tax blocks issuance rather than becoming zero. Zero-rated, exempt, outside-scope, reverse-charge and not-registered treatments remain distinct even when no tax is charged.
