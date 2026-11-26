import type { LedgerRow, Wallet } from "@templatedesign/platform/credits";
import { InlineNotice } from "@templatedesign/ui";
import { type ComponentProps, useEffect, useState } from "react";
import type { AccountPanel as Panel } from "../lib/home-state";
import type { AuthUser, Profile } from "../lib/types";
import { CreditsApp } from "./CreditsApp.js";
import { DevelopersApp } from "./DevelopersApp.js";
import { SettingsApp } from "./SettingsApp.js";

export interface AccountPanelProps {
  panel: Panel;
  locale: "en" | "vi";
  user: AuthUser;
  profile: Profile;
  csrfToken: string;
  credits: number;
}

type Loaded =
  | { panel: "wallet"; wallet: Wallet; ledger: LedgerRow[] }
  | {
      panel: "api";
      keys: ComponentProps<typeof DevelopersApp>["initialKeys"];
      webhooks: ComponentProps<typeof DevelopersApp>["initialWebhooks"];
    }
  | { panel: "settings"; deletion: ComponentProps<typeof SettingsApp>["initialDeletion"] };

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return (await response.json()) as T;
}

async function load(panel: Panel): Promise<Loaded> {
  if (panel === "wallet") {
    const body = await getJson<{ wallet: Wallet; ledger: LedgerRow[] }>("/api/v1/wallet");
    return { panel, wallet: body.wallet, ledger: body.ledger };
  }
  if (panel === "api") {
    const [keys, webhooks] = await Promise.all([
      getJson<{ data: Extract<Loaded, { panel: "api" }>["keys"] }>("/api/v1/api-keys"),
      getJson<{ data: Extract<Loaded, { panel: "api" }>["webhooks"] }>("/api/v1/webhook-endpoints"),
    ]);
    return { panel, keys: keys.data, webhooks: webhooks.data };
  }
  const body = await getJson<{ deletion: Extract<Loaded, { panel: "settings" }>["deletion"] }>(
    "/api/v1/account/delete",
  );
  return { panel, deletion: body.deletion };
}

/** Wallet, API keys and settings inside the account popup. Loaded on demand from the existing APIs. */
export default function AccountPanel({ panel, locale, user, profile, csrfToken, credits }: AccountPanelProps) {
  const vi = locale === "vi";
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setData(null);
    setFailed(false);
    load(panel)
      .then((loaded) => live && setData(loaded))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [panel]);

  if (failed) {
    return (
      <InlineNotice tone="danger">{vi ? "Không tải được. Hãy thử lại." : "Could not load. Try again."}</InlineNotice>
    );
  }
  if (!data || data.panel !== panel) return <p className="ta-muted">{vi ? "Đang tải…" : "Loading…"}</p>;

  const common = { locale, user, csrfToken, credits, embedded: true };
  if (data.panel === "wallet") {
    return <CreditsApp {...common} profile={profile} wallet={data.wallet} ledger={data.ledger} />;
  }
  if (data.panel === "api") {
    return <DevelopersApp {...common} profile={profile} initialKeys={data.keys} initialWebhooks={data.webhooks} />;
  }
  return <SettingsApp {...common} initialProfile={profile} initialDeletion={data.deletion} />;
}
