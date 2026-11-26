/* Tuỳ chọn cá nhân của người dùng (mock, lưu localStorage).
   Dùng chung cho menu profile và dialog Hồ sơ cá nhân. */
import { useCallback, useSyncExternalStore } from "react";

const KEY = "dlp.user-prefs";

export interface UserPrefs {
  name: string;
  phone: string;
  lang: "vi" | "en";
  timezone: string;
  theme: "light" | "dark";
}

export const DEFAULT_PREFS: UserPrefs = {
  name: "",
  phone: "",
  lang: "vi",
  timezone: "Asia/Ho_Chi_Minh",
  theme: "light",
};

export const TIMEZONES: { id: string; label: string }[] = [
  { id: "Asia/Ho_Chi_Minh", label: "(GMT+7) Hồ Chí Minh - Việt Nam" },
  { id: "Asia/Bangkok", label: "(GMT+7) Bangkok" },
  { id: "Asia/Singapore", label: "(GMT+8) Singapore" },
  { id: "Asia/Shanghai", label: "(GMT+8) Thượng Hải" },
  { id: "Asia/Tokyo", label: "(GMT+9) Tokyo" },
  { id: "Europe/London", label: "(GMT+0/+1) London" },
  { id: "UTC", label: "(GMT+0) UTC" },
];

let cache: UserPrefs = DEFAULT_PREFS;
const listeners = new Set<() => void>();

function read(): UserPrefs {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PREFS;
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<UserPrefs>) };
  } catch {
    return DEFAULT_PREFS;
  }
}

function emit() {
  for (const l of listeners) l();
}

export function applyTheme(theme: UserPrefs["theme"]) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
  if (theme === "dark") {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
}

if (typeof document !== "undefined") {
  applyTheme(read().theme);
}

function subscribe(cb: () => void) {
  if (listeners.size === 0) {
    cache = read();
    applyTheme(cache.theme);
  }
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function setUserPrefs(patch: Partial<UserPrefs>) {
  cache = { ...cache, ...patch };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* bỏ qua khi storage bị chặn */
  }
  applyTheme(cache.theme);
  emit();
}

export function useUserPrefs() {
  const prefs = useSyncExternalStore(
    subscribe,
    () => cache,
    () => DEFAULT_PREFS,
  );
  const update = useCallback((patch: Partial<UserPrefs>) => setUserPrefs(patch), []);
  return { prefs, update };
}

/* Giờ hiện tại theo múi giờ đã chọn - dùng cho dòng xem trước trong dialog. */
export function formatNowIn(timezone: string): string {
  try {
    return new Intl.DateTimeFormat("vi-VN", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone,
    }).format(new Date());
  } catch {
    return "-";
  }
}
