import { useCallback, useEffect, useRef, useState } from "react";

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value);
}

export function formatDate(value: string | Date, locale: string, options?: Intl.DateTimeFormatOptions): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat(locale, options ?? { day: "2-digit", month: "short", year: "numeric" }).format(date);
}

export function useControllableState<T>(
  controlled: T | undefined,
  defaultValue: T,
  onChange?: (value: T) => void,
): [T, (value: T) => void] {
  const [uncontrolled, setUncontrolled] = useState(defaultValue);
  const value = controlled ?? uncontrolled;
  const setValue = useCallback(
    (next: T) => {
      if (controlled === undefined) setUncontrolled(next);
      onChange?.(next);
    },
    [controlled, onChange],
  );
  return [value, setValue];
}

export function useCopyToClipboard(resetMs = 2000) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const copy = useCallback(
    async (value: string) => {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(value);
        } else {
          const textarea = document.createElement("textarea");
          textarea.value = value;
          textarea.setAttribute("readonly", "");
          textarea.style.position = "fixed";
          textarea.style.opacity = "0";
          document.body.appendChild(textarea);
          textarea.select();
          const ok = document.execCommand("copy");
          textarea.remove();
          if (!ok) throw new Error("copy failed");
        }
        setState("copied");
      } catch {
        setState("failed");
      }
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setState("idle"), resetMs);
    },
    [resetMs],
  );

  return { copy, state };
}

/** Inline SVG data URI used as a neutral document thumbnail in the gallery and prototype. */
export function documentPreviewDataUri(
  options: { kind?: "certificate" | "cfo" | "logistics"; variant?: number; title?: string } = {},
): string {
  const kind = options.kind ?? "certificate";
  const variant = options.variant ?? 0;
  const accent = ["#0F5C57", "#B5400F", "#6B4FA0", "#8A6A00"][variant % 4];
  const title = (options.title ?? (kind === "certificate" ? "CERTIFICATE" : "COST REPORT"))
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
  const rows =
    kind === "cfo"
      ? Array.from({ length: 7 }, (_, index) => {
          const y = 150 + index * 22;
          return `<rect x="36" y="${y}" width="${260 - (index % 3) * 24}" height="7" rx="1" fill="#DCD6CB"/>`;
        }).join("")
      : "";
  const body =
    kind === "certificate"
      ? `<rect x="120" y="120" width="160" height="9" rx="1" fill="#DCD6CB"/><rect x="96" y="140" width="208" height="6" rx="1" fill="#E6E1D8"/><rect x="140" y="205" width="120" height="5" rx="1" fill="#E6E1D8"/><circle cx="320" cy="250" r="18" fill="none" stroke="${accent}" stroke-width="2"/><circle cx="320" cy="250" r="12" fill="none" stroke="${accent}" stroke-width="1"/>`
      : `<rect x="36" y="110" width="120" height="8" rx="1" fill="#DCD6CB"/>${rows}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300"><rect width="400" height="300" fill="#F2EFE8"/><rect x="46" y="26" width="308" height="248" fill="#FFFFFF" stroke="#E6E1D8"/><rect x="46" y="26" width="308" height="4" fill="${accent}"/><text x="200" y="78" text-anchor="middle" font-family="Georgia, serif" font-size="18" fill="#1A1915">${title}</text><rect x="120" y="92" width="160" height="3" rx="1" fill="${accent}"/>${body}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
