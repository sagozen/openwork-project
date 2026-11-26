import type { ReactNode } from "react";

import {
  createDarkTheme,
  createLightTheme,
  FluentProvider,
  type BrandVariants,
  type Theme,
} from "@fluentui/react-components";
import { useUserPrefs } from "@/lib/auth/user-prefs";

const dlpBrand: BrandVariants = {
  10: "#020816",
  20: "#07142a",
  30: "#0d2345",
  40: "#12315f",
  50: "#174174",
  60: "#1c528c",
  70: "#2464a5",
  80: "#3177bc",
  90: "#4b89c8",
  100: "#69a0d4",
  110: "#8bb7df",
  120: "#add0e9",
  130: "#cce3f1",
  140: "#e5f0f7",
  150: "#f1f7fb",
  160: "#f8fbfd",
};

const fluentTheme = createLightTheme(dlpBrand);

export const dlpPortalTheme: Theme = {
  ...fluentTheme,
  fontFamilyBase: '"Segoe UI", "Source Sans 3", sans-serif',
  fontFamilyMonospace: '"Cascadia Code", "SFMono-Regular", monospace',
  borderRadiusMedium: "6px",
  borderRadiusLarge: "8px",
  colorNeutralBackground1: "#ffffff",
  colorNeutralBackground2: "#f8f9fb",
  colorNeutralBackground3: "#f2f4f7",
  colorNeutralForeground1: "#10213d",
  colorNeutralForeground2: "#42526a",
  colorNeutralStroke1: "#d7dee8",
  colorPaletteYellowBackground2: "#fff5dc",
  colorPaletteYellowForeground2: "#7a4f00",
};

export const dlpDarkTheme: Theme = {
  ...createDarkTheme(dlpBrand),
  fontFamilyBase: dlpPortalTheme.fontFamilyBase,
  fontFamilyMonospace: dlpPortalTheme.fontFamilyMonospace,
  borderRadiusMedium: "6px",
  borderRadiusLarge: "8px",
  colorNeutralBackground1: "#121824",
  colorNeutralBackground2: "#182030",
};

export function DlpThemeProvider({ children }: { children: ReactNode }) {
  const { prefs } = useUserPrefs();
  return (
    <FluentProvider
      theme={prefs.theme === "dark" ? dlpDarkTheme : dlpPortalTheme}
      style={{ minHeight: "100vh", display: "flex", flexDirection: "column", width: "100%" }}
    >
      {children}
    </FluentProvider>
  );
}
