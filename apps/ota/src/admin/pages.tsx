/**
 * One component per admin page. Each loads the workspace summary once, then renders its tabs.
 */

import type { ReactNode } from "react";
import type { OtaInfo } from "../domain/types.js";
import { ActivityTab } from "./activity.js";
import { AppsTab } from "./apps.js";
import { api } from "./client.js";
import { ApiTab } from "./docs.js";
import { ReleasesTab } from "./releases.js";
import { RetentionSection } from "./retention.js";
import { StorageTab, TokensTab } from "./settings.js";
import { bytes, Failure, Stat, useAsync } from "./shared.js";
import "./styles.css";

function WithInfo({ children }: { children: (info: OtaInfo, reload: () => void) => ReactNode }) {
  const info = useAsync<OtaInfo>((signal) => api.info(signal), []);
  if (!info.data) {
    return (
      <div className="ota-server">
        {info.loading ? <p role="status">Loading the OTA workspace…</p> : null}
        <Failure error={info.error} onRetry={info.reload} />
      </div>
    );
  }
  return (
    <div className="ota-server">
      <Failure error={info.error} onRetry={info.reload} />
      {children(info.data, info.reload)}
    </div>
  );
}

function Summary({ info }: { info: OtaInfo }) {
  return (
    <div className="ota-stats">
      <Stat label="Stored builds" value={String(info.counts.releases)} hint={`${info.counts.channels} channels`} />
      <Stat
        label="Bundle storage"
        value={bytes(info.counts.bytes)}
        hint={`limit ${bytes(info.limits.maxBundleBytes)} per build`}
      />
      <Stat label="Active tokens" value={String(info.counts.tokens)} />
      <Stat
        label="Storage mode"
        value={info.storage.mode === "platform" ? "Platform storage" : "Own bucket"}
        hint={info.storage.mode === "r2" ? info.storage.r2.bucket : "shared media bucket"}
      />
    </div>
  );
}

export function ReleasesPage() {
  return (
    <WithInfo>
      {(info) => (
        <>
          <Summary info={info} />
          <ReleasesTab info={info} />
        </>
      )}
    </WithInfo>
  );
}

export function SettingsPage() {
  return (
    <WithInfo>
      {(info, reload) => (
        <>
          {info.storage.mode === "r2" && !info.storage.keyConfigured ? (
            <div className="ota-banner" data-tone="warning">
              Bucket settings are stored but <code>OTA_SECRET_KEY</code> is missing on this deployment, so downloads and
              pushes fail until the secret is set and the storage settings are saved again.
            </div>
          ) : null}
          <AppsTab info={info} onChanged={reload} />
          <TokensTab info={info} />
          <StorageTab info={info} />
          <RetentionSection onChanged={reload} />
        </>
      )}
    </WithInfo>
  );
}

export function ActivityPage() {
  return (
    <div className="ota-server">
      <ActivityTab />
    </div>
  );
}

export function DocsPage() {
  return <WithInfo>{(info) => <ApiTab info={info} />}</WithInfo>;
}
