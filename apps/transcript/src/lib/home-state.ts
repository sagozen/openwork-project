import { safeNext } from "@templatedesign/platform/legacy-redirects";

export type AccountPanel = "wallet" | "api" | "settings";

/** Which panel of the landing page is open, read from and written to the query string. */
export interface HomeState {
  job: string | null;
  payment: string | null;
  topup: boolean;
  cancelled: boolean;
  account: AccountPanel | null;
  signin: boolean;
  /** Where sign-in returns to; always a same-origin path. */
  next: string;
}

export const EMPTY_STATE: HomeState = {
  job: null,
  payment: null,
  topup: false,
  cancelled: false,
  account: null,
  signin: false,
  next: "/",
};

const ACCOUNT_PANELS = new Set<AccountPanel>(["wallet", "api", "settings"]);
const ID = /^[A-Za-z0-9_-]{1,64}$/;

function id(value: string | null): string | null {
  return value && ID.test(value) ? value : null;
}

export function readHomeState(params: URLSearchParams): HomeState {
  const account = params.get("account");
  const topup = params.get("topup") === "1";
  return {
    job: id(params.get("job")),
    payment: id(params.get("payment")),
    topup,
    cancelled: topup && params.get("checkout") === "cancelled",
    account: account && ACCOUNT_PANELS.has(account as AccountPanel) ? (account as AccountPanel) : null,
    signin: params.get("signin") === "1",
    next: safeNext(params.get("next")),
  };
}

export function homeStateHref(state: HomeState): string {
  const query = new URLSearchParams();
  if (state.job) query.set("job", state.job);
  if (state.payment) query.set("payment", state.payment);
  if (state.topup) query.set("topup", "1");
  if (state.topup && state.cancelled) query.set("checkout", "cancelled");
  if (state.account) query.set("account", state.account);
  if (state.signin) query.set("signin", "1");
  if (state.signin && state.next !== "/") query.set("next", state.next);
  const text = query.toString();
  return text ? `/?${text}` : "/";
}

/** Personal states (a job, a payment, the account) must never be indexed. */
export function isPrivateState(params: URLSearchParams): boolean {
  return ["job", "payment", "account", "topup", "signin"].some((key) => params.has(key));
}
