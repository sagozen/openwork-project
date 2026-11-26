import { createContext, type ReactNode, useContext, useMemo } from "react";
import { type Locale, type MessageKey, messages, t as translate } from "./copy.js";

interface LocaleContextValue {
  locale: Locale;
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
}

const LocaleContext = createContext<LocaleContextValue>({
  locale: "en",
  t: (key, values) => translate("en", key, values),
});

export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const value = useMemo<LocaleContextValue>(
    () => ({ locale, t: (key, values) => translate(locale, key, values) }),
    [locale],
  );
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}

export type { Locale, MessageKey };
export { messages };
