import { fail, type Discount, type InvoiceLine, type Invoice, type Blocker, type Business, type ClientRecord } from "./models";
const PPM = 1_000_000n;
export function round(n: bigint, d: bigint): number { return Number((2n * n + d) / (2n * d)); }
function discountAmount(amount: number, discount?: Discount): number {
  const value = !discount ? 0 : discount.kind === "fixed" ? discount.amount_minor : round(BigInt(amount) * BigInt(discount.rate_ppm), PPM);
  if (value > amount) fail("DISCOUNT_TOO_LARGE", "The discount exceeds the available amount.");
  return value;
}
export function calculate(lines: Pick<InvoiceLine, "item_id" | "source_snapshot" | "amount_minor" | "discount" | "tax">[], discount?: Discount) {
  const bases = lines.map(l => l.amount_minor - discountAmount(l.amount_minor, l.discount));
  const subtotal = bases.reduce((a, b) => a + b, 0);
  const invoiceDiscount = discountAmount(subtotal, discount);
  // Largest remainder allocation conserves every minor unit; input line order breaks ties.
  const shares = bases.map((base, i) => ({ i, value: subtotal ? Number(BigInt(base) * BigInt(invoiceDiscount) / BigInt(subtotal)) : 0,
    remainder: subtotal ? BigInt(base) * BigInt(invoiceDiscount) % BigInt(subtotal) : 0n }));
  let remaining = invoiceDiscount - shares.reduce((sum, s) => sum + s.value, 0);
  for (const share of [...shares].sort((a, b) => a.remainder === b.remainder ? a.i - b.i : a.remainder > b.remainder ? -1 : 1)) {
    if (remaining-- > 0) share.value++;
  }
  const computed: InvoiceLine[] = lines.map((line, i) => {
    const price = bases[i] - shares[i].value;
    const components = line.tax?.components ?? [];
    if (line.tax && ((line.tax.treatment === "taxable") !== (components.length > 0))) {
      fail("TAX_COMPONENTS_INVALID", "Taxable lines require components. Non-taxable treatments must have no charged tax components.");
    }
    const inclusive = line.tax?.mode === "inclusive";
    const denominator = PPM * PPM + components.reduce((sum, c) => sum + BigInt(c.rate_ppm) * BigInt(c.taxable_fraction_ppm), 0n);
    const taxes = components.map(c => ({ ...c, amount_minor: round(BigInt(price) * BigInt(c.rate_ppm) * BigInt(c.taxable_fraction_ppm), inclusive ? denominator : PPM * PPM) }));
    const tax = taxes.reduce((sum, c) => sum + c.amount_minor, 0);
    if (inclusive && tax > price) fail("TAX_ROUNDING_INVALID", "The inclusive tax components exceed this very small line. Combine the allocation or use a larger line amount.");
    return { ...line, line_discount_minor: line.amount_minor - bases[i], invoice_discount_minor: shares[i].value,
      net_minor: inclusive ? price - tax : price, tax_minor: tax, taxes, total_minor: inclusive ? price : price + tax };
  });
  const sum = (key: "amount_minor" | "net_minor" | "tax_minor" | "total_minor") => computed.reduce((s, l) => s + l[key], 0);
  if (sum("total_minor") > 1_000_000_000_000) fail("AMOUNT_LIMIT", "Invoice total exceeds the supported per-record amount.");
  return { lines: computed, subtotal_minor: sum("amount_minor"), discount_minor: sum("amount_minor") - bases.reduce((a, b) => a + b, 0) + invoiceDiscount,
    net_minor: sum("net_minor"), tax_minor: sum("tax_minor"), total_minor: sum("total_minor") };
}
export function taxBlockers(invoice: Invoice, business: Business, client: ClientRecord): Blocker[] {
  const blockers: Blocker[] = [];
  const add = (field: string, message: string, next_tool: string) => blockers.push({ field, message, next_tool });
  const profile = business.tax_profile;
  if (!profile || profile.registration_status === "unknown") add("tax_profile", "Ask for the business country, region and confirmed tax registration status. Read tax_guide first.", "tax_profile_set");
  if (profile && ["US", "CA"].includes(profile.country) && !profile.region) add("tax_profile.region", "Ask for the business state or province.", "tax_profile_set");
  if (profile?.registration_status === "registered" && !profile.registrations.length) add("tax_profile.registrations", "Record the applicable tax registration numbers and effective dates.", "tax_profile_set");
  if (!client.country) add("client.country", "Ask which country the customer belongs in.", "client_save");
  if (client.country && ["US", "CA"].includes(client.country) && !client.region) add("client.region", "Ask for the customer's state or province; a country alone cannot establish tax treatment.", "client_save");
  if (client.customer_type === "unknown") add("client.customer_type", "Ask whether the customer is a business or consumer.", "client_save");
  for (const [index, line] of invoice.lines.entries()) {
    if (!line.tax) add(`lines[${index}].tax`, "Confirm treatment, jurisdiction, service category and the reason; do not default missing tax to zero. Cancel and rebuild this draft after review.", "invoice_cancel_draft");
    if (line.tax?.treatment === "taxable" && profile?.registration_status !== "registered") add(`lines[${index}].tax`, "Charged tax requires a recorded registration. Resolve registration status before issuing.", "tax_profile_set");
  }
  return blockers;
}
