// Colour scheme preference: "auto" follows the device. Base.astro applies the
// stored choice before first paint, so pages never flash the wrong scheme.
export type Scheme = "auto" | "light" | "dark";
export const SCHEME_KEY = "mytutor-scheme";

export function currentScheme(): Scheme {
  const value = document.documentElement.dataset.mtScheme;
  return value === "light" || value === "dark" ? value : "auto";
}

export function applyScheme(scheme: Scheme): void {
  document.documentElement.dataset.mtScheme = scheme;
  try {
    if (scheme === "auto") localStorage.removeItem(SCHEME_KEY);
    else localStorage.setItem(SCHEME_KEY, scheme);
  } catch {
    // Private windows may refuse storage; the choice still lasts this page.
  }
}
