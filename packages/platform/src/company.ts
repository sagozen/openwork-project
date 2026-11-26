/**
 * The legal entity behind the product. Every page, footer and legal text reads these values,
 * so a change of address or contact happens here only.
 */
export const COMPANY = {
  name: "SAGOZEN LLC",
  address: "Ste N, 30 N Gould St, Sheridan, WY 82801, US",
  phone: "+1 307-424-2696",
  email: "hello@sagozen.digital",
  byline: "a SAGOZEN Labs product",
} as const;

/** Tokens allowed in `legal.md`; each is replaced by the matching company value. */
const TOKENS: Record<string, string> = {
  COMPANY_NAME: COMPANY.name,
  COMPANY_ADDRESS: COMPANY.address,
  COMPANY_PHONE_TEL: COMPANY.phone.replace(/[^+\d]/g, ""),
  COMPANY_PHONE: COMPANY.phone,
  COMPANY_EMAIL: COMPANY.email,
  COMPANY_BYLINE: COMPANY.byline,
};

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Replaces the `COMPANY_*` tokens in rendered HTML with escaped company values. */
export function fillCompany(html: string): string {
  return html.replace(/\bCOMPANY_[A-Z_]+\b/g, (token) => {
    const value = TOKENS[token];
    if (value === undefined) throw new Error(`Unknown company token ${token}`);
    return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
  });
}
