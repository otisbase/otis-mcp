export const taxGuidance = {
  reviewed_on: "2026-10-20",
  purpose: "Invoice sales tax, GST and VAT setup guidance for consultants and small agencies. Not income tax, filing, or an automatic legal tax determination.",
  general_rule: "Never infer a tax rate or no-tax treatment from a country, currency, client name or missing field. Establish the facts, verify the applicable authority guidance, record the user's confirmed treatment, then calculate.",
  setup_questions: [
    "Where is the business established, including state/province? Where else is it registered or required to collect?",
    "What registrations, numbers and effective dates apply? Unknown is different from not registered.",
    "Where does the customer belong, are they a business or consumer, and what evidence supports that?",
    "What exactly was supplied, where, and on what date? Separate consulting, software, digital services and reimbursed expenses where relevant.",
    "What is the applicable place of supply, tax treatment, rate, taxable fraction and reason?",
    "Are agreed prices tax-inclusive or exclusive? Do the discounts affect the taxable base under these rules?"
  ],
  agent_contract: [
    "Use tax_guide during setup and when jurisdiction, customer type, service or registration changes.",
    "Treat rates and thresholds here as dated orientation, not automatic defaults. Recheck the linked official source for the transaction date.",
    "If facts or treatment remain unclear, ask the user or their accountant. Save a draft; do not issue by guessing.",
    "Read invoice_check blockers and use their next_tool instructions. Show the exact draft total and tax treatment before requesting issue approval.",
    "An invoice_check success establishes arithmetic and required recorded fields, not legal compliance. Records in Otis alone cannot prove total turnover or nexus.",
    "Do not equate zero-rated, exempt, outside scope, reverse charge and not registered. Record the specific treatment and reason."
  ],
  countries: {
    US: {
      title: "United States",
      orientation: "Sales tax depends on state and local rules, collection obligations (nexus), service classification and exemptions. There is no single rate to apply from US alone. New York generally exempts services unless specifically taxable; Texas distinguishes ordinary consulting from taxable data processing. Consult the relevant state authority.",
      checks: ["Seller and customer state, locality and sourcing", "Physical/economic nexus and registrations", "Exact service and taxable portion", "Exemption evidence and invoice date"],
      sources: [
        { title: "New York registration and service taxability", url: "https://www.tax.ny.gov/pubs_and_bulls/tg_bulletins/st/do_i_need_to_register_for_sales_tax.htm" },
        { title: "Texas taxable data processing and consulting distinction", url: "https://comptroller.texas.gov/taxes/publications/94-127.php/1000" }
      ]
    },
    CA: {
      title: "Canada",
      orientation: "Check GST/HST registration and place of supply; the applicable province affects the rate. GST/HST is separate from provincial PST/QST obligations. As an illustration, CRA lists Ontario HST at 13%. Show HST as one combined component. The general small-supplier test involves C$30,000 of taxable supplies in a single calendar quarter or over four consecutive quarters, with exceptions and distinct effective-date rules; voluntary registration is possible.",
      checks: ["GST/HST registration and effective date", "Separate provincial registrations", "Place of supply and customer province", "Taxable, zero-rated or exempt supply; export conditions"],
      sources: [
        { title: "CRA charging GST/HST and invoice information", url: "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-which-rate.html" },
        { title: "CRA voluntary registration and small suppliers", url: "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/account-register-voluntarily.html" },
        { title: "CRA when to register and start charging", url: "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/when-register-charge.html" }
      ]
    },
    GB: {
      title: "United Kingdom",
      orientation: "The standard VAT rate is 20%. For general-rule services, place of supply usually follows the customer for B2B and supplier for B2C, but special rules must be checked first. Overseas services can involve outside-scope treatment or reverse charge. The general UK-established registration threshold is £90,000 taxable turnover, tested over a rolling 12 months and separately for expected turnover in the next 30 days; non-established suppliers have different rules.",
      checks: ["VAT registration, number and effective date", "B2B evidence or B2C status", "Specific service exceptions before the general place-of-supply rule", "Cross-border treatment, reverse-charge wording and evidence"],
      sources: [
        { title: "HMRC VAT rates", url: "https://www.gov.uk/vat-rates" },
        { title: "HMRC registration", url: "https://www.gov.uk/register-for-vat" },
        { title: "HMRC place of supply for services", url: "https://www.gov.uk/guidance/vat-place-of-supply-of-services-notice-741a" }
      ]
    },
    AU: {
      title: "Australia",
      orientation: "GST is generally 10% on taxable sales. The general business GST registration threshold is A$75,000 GST turnover, with exceptions; voluntary registration is possible. Check exports and GST-free or input-taxed treatment separately before applying a rate.",
      checks: ["GST registration and ABN", "Current and projected GST turnover, including exceptions", "Customer location and supply type", "GST-free/export evidence, price inclusivity and invoice requirements"],
      sources: [
        { title: "ATO registering for GST", url: "https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/registering-for-gst" },
        { title: "ATO GST registration and charging summary", url: "https://www.ato.gov.au/api/public/content/0-997b3cca-be74-4b06-ac13-7064a2e7852c" }
      ]
    }
  }
} as const;
export function guideFor(country?: string) {
  const { countries, ...general } = taxGuidance;
  return { ...general, ...(country ? { country, guidance: countries[country as keyof typeof countries] ?? null,
    ...(country in countries ? {} : { message: "No country-specific guide is maintained yet. Use the general checklist and that jurisdiction's tax authority." }) } : { countries }) };
}
export function taxGuideMarkdown(): string {
  return `# Invoice tax setup\n\nReviewed ${taxGuidance.reviewed_on}.\n\n${taxGuidance.purpose}\n\n${taxGuidance.general_rule}\n\n## Questions to establish\n\n${taxGuidance.setup_questions.map(q => `- ${q}`).join("\n")}\n\n## Agent behavior\n\n${taxGuidance.agent_contract.map(q => `- ${q}`).join("\n")}\n\n${Object.values(taxGuidance.countries).map(c => `## ${c.title}\n\n${c.orientation}\n\n${c.checks.map(q => `- ${q}`).join("\n")}\n\n${c.sources.map(s => `[${s.title}](${s.url})`).join(" · ")}`).join("\n\n")}\n`;
}
