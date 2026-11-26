import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Button, Tab, TabList, Tag, TagGroup } from "@fluentui/react-components";
import { ArrowDownload20Regular, Rocket20Regular } from "@fluentui/react-icons";
import { NoAccess } from "@/components/lims/NoAccess";
import { EmptyState, PageHead, useDlpToast } from "@/components/lims/common";
import { useAuth } from "@/lib/auth/AuthProvider";
import { SupportPanel, SupportShell } from "@/components/lims/support/SupportUI";
import {
  APP_BUILD,
  APP_RELEASED_AT,
  APP_VERSION,
  CHANGE_KIND_LABEL,
  RELEASES,
  UPCOMING,
  type ChangeKind,
  type ReleaseEntry,
} from "@/lib/support/release-data";

export const Route = createFileRoute("/_app/phien-ban")({
  head: () => ({
    meta: [
      { title: "Ghi chú phiên bản - DLP LIMS" },
      {
        name: "description",
        content: "Phiên bản hiện tại, lịch sử thay đổi và lộ trình tính năng sắp tới của DLP LIMS.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ReleaseNotesScreen,
});

const KINDS: ChangeKind[] = ["new", "improve", "fix"];

function ReleaseList({ entries, kind }: { entries: ReleaseEntry[]; kind: ChangeKind | "all" }) {
  const filtered = useMemo(
    () =>
      entries
        .map((r) => ({
          ...r,
          changes: kind === "all" ? r.changes : r.changes.filter((c) => c.kind === kind),
        }))
        .filter((r) => r.changes.length > 0),
    [entries, kind],
  );

  if (filtered.length === 0) {
    return <EmptyState title="Không có thay đổi phù hợp" hint="Thử chọn loại thay đổi khác." />;
  }

  return (
    <div className="dlp-rel__timeline">
      {filtered.map((r) => (
        <article
          key={r.version}
          className={
            r.status === "current" ? "dlp-rel__item dlp-rel__item--current" : "dlp-rel__item"
          }
        >
          <div className="dlp-rel__side">
            <span className="dlp-rel__ver">{r.version}</span>
            <span className="dlp-rel__date">{r.date}</span>
          </div>
          <div>
            <div className="dlp-rel__name">
              {r.name}
              {r.status === "current" ? (
                <span className="dlp-sup__pill dlp-sup__pill--success" style={{ marginLeft: 8 }}>
                  Đang dùng
                </span>
              ) : null}
              {r.status === "planned" ? (
                <span className="dlp-sup__pill dlp-sup__pill--info" style={{ marginLeft: 8 }}>
                  Dự kiến
                </span>
              ) : null}
            </div>
            <p className="dlp-rel__sum">{r.summary}</p>
            <div className="dlp-rel__changes">
              {r.changes.map((c, i) => (
                <div key={`${r.version}-${i}`} className="dlp-rel__change">
                  <span className={`dlp-rel__kind dlp-rel__kind--${c.kind}`}>
                    {CHANGE_KIND_LABEL[c.kind]}
                  </span>
                  <span className="dlp-rel__area">{c.area}</span>
                  <span>{c.text}</span>
                </div>
              ))}
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}

function ReleaseNotesScreen() {
  const { can } = useAuth();
  const toast = useDlpToast();
  const [tab, setTab] = useState<"history" | "upcoming">("history");
  const [kind, setKind] = useState<ChangeKind | "all">("all");

  if (!can("support.view")) return <NoAccess screen="Ghi chú phiên bản" />;

  return (
    <SupportShell>
      <PageHead
        crumbs={[{ label: "Ghi chú phiên bản" }]}
        title="Ghi chú phiên bản"
        description="Phiên bản đang chạy, lịch sử thay đổi và những gì sắp tới."
      />

      <div className="dlp-rel__now">
        <span className="dlp-rel__now-badge">
          <Rocket20Regular /> {APP_VERSION}
        </span>
        <div className="dlp-rel__now-meta">
          <span className="dlp-rel__now-name">{RELEASES[0]?.name}</span>
          <span>
            Phát hành {APP_RELEASED_AT} · {APP_BUILD}
          </span>
        </div>
        <div style={{ flex: 1 }} />
        <Button
          appearance="secondary"
          icon={<ArrowDownload20Regular />}
          onClick={() =>
            toast("Đang tải ghi chú phiên bản", `Release notes ${APP_VERSION} (PDF)`, "success")
          }
        >
          Tải ghi chú (PDF)
        </Button>
      </div>

      <SupportPanel
        title={tab === "history" ? "Lịch sử thay đổi" : "Lộ trình sắp tới"}
        action={
          <TagGroup
            selectedValues={[kind]}
            onTagSelect={(_, d) => setKind(d.value as ChangeKind | "all")}
          >
            <Tag value="all" appearance="outline" className={kind === "all" ? "dlp-chip--picked" : "dlp-chip--unpicked"}>
              {kind === "all" ? "✓ " : ""}Tất cả
            </Tag>
            {KINDS.map((k) => (
              <Tag key={k} value={k} appearance="outline" className={kind === k ? "dlp-chip--picked" : "dlp-chip--unpicked"}>
                {kind === k ? "✓ " : ""}{CHANGE_KIND_LABEL[k]}
              </Tag>
            ))}
          </TagGroup>
        }
        padded
      >
        <TabList
          selectedValue={tab}
          onTabSelect={(_, d) => setTab(d.value as "history" | "upcoming")}
          style={{ marginBottom: 8 }}
        >
          <Tab value="history">Đã phát hành ({RELEASES.length})</Tab>
          <Tab value="upcoming">Sắp tới ({UPCOMING.length})</Tab>
        </TabList>
        <ReleaseList entries={tab === "history" ? RELEASES : UPCOMING} kind={kind} />
      </SupportPanel>
    </SupportShell>
  );
}
