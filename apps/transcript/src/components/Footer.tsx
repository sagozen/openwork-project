import { LocaleProvider, SiteFooter } from "@templatedesign/ui";

/** Server-rendered footer; the provider gives the shared footer its language. */
export function Footer({ locale, contactEmail }: { locale: "en" | "vi"; contactEmail: string }) {
  return (
    <LocaleProvider locale={locale}>
      <SiteFooter contactEmail={contactEmail} byline="a SAGOZEN Labs product" />
    </LocaleProvider>
  );
}
