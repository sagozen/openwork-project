import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Button, Tag, TagGroup } from "@fluentui/react-components";
import { Add20Regular } from "@fluentui/react-icons";
import { NoAccess } from "@/components/lims/NoAccess";
import { EmptyState, PageHead, SearchInput } from "@/components/lims/common";
import { useAuth } from "@/lib/auth/AuthProvider";
import { useSupportStore } from "@/lib/support/support-store";
import {
  TICKET_KIND_TEXT,
  TICKET_PRIORITY_TEXT,
  TICKET_STATE_TEXT,
  type TicketKind,
  type TicketState,
} from "@/lib/support/support-data";
import { NewTicketDialog } from "@/components/lims/support/NewTicketDialog";
import { ArticleRow, StatusPill, SupportShell } from "@/components/lims/support/SupportUI";

export const Route = createFileRoute("/_app/ho-tro/yeu-cau/")({
  head: () => ({
    meta: [
      { title: "Yêu cầu hỗ trợ của tôi - DLP LIMS" },
      {
        name: "description",
        content:
          "Theo dõi trạng thái, mức ưu tiên và phản hồi cho các yêu cầu hỗ trợ, báo lỗi và đề xuất tính năng đã gửi.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: TicketListScreen,
});

const KINDS: TicketKind[] = ["bug", "help", "feature"];
const STATES: TicketState[] = ["new", "processing", "waiting", "resolved", "closed"];

function TicketListScreen() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const { tickets } = useSupportStore();
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<TicketKind | "all">("all");
  const [state, setState] = useState<TicketState | "all">("all");
  const [dialog, setDialog] = useState(false);

  const rows = useMemo(() => {
    const key = q.trim().toLowerCase();
    return tickets.filter(
      (t) =>
        (kind === "all" || t.kind === kind) &&
        (state === "all" || t.state === state) &&
        (!key || t.id.toLowerCase().includes(key) || t.title.toLowerCase().includes(key)),
    );
  }, [tickets, q, kind, state]);

  if (!can("support.view")) return <NoAccess screen="Yêu cầu hỗ trợ" />;

  return (
    <SupportShell>
      <PageHead
        crumbs={[{ label: "Hỗ trợ người dùng", to: "/ho-tro" }, { label: "Yêu cầu của tôi" }]}
        title="Yêu cầu của tôi"
        description="Toàn bộ yêu cầu hỗ trợ, báo lỗi và đề xuất tính năng bạn đã gửi."
        actions={
          <Button appearance="primary" icon={<Add20Regular />} onClick={() => setDialog(true)}>
            Gửi yêu cầu mới
          </Button>
        }
      />

      <div className="dlp-sup__panel">
        <div className="dlp-sup__panel-head" style={{ flexWrap: "wrap" }}>
          <div className="dlp-sup__filters">
            <TagGroup
              selectedValues={[kind]}
              onTagSelect={(_, d) => setKind(d.value as TicketKind | "all")}
            >
              <Tag value="all" appearance="outline" className={kind === "all" ? "dlp-chip--picked" : "dlp-chip--unpicked"}>
                {kind === "all" ? "✓ " : ""}Tất cả loại
              </Tag>
              {KINDS.map((k) => (
                <Tag key={k} value={k} appearance="outline" className={kind === k ? "dlp-chip--picked" : "dlp-chip--unpicked"}>
                  {kind === k ? "✓ " : ""}{TICKET_KIND_TEXT[k]}
                </Tag>
              ))}
            </TagGroup>
            <TagGroup
              selectedValues={[state]}
              onTagSelect={(_, d) => setState(d.value as TicketState | "all")}
            >
              <Tag value="all" appearance="outline" className={state === "all" ? "dlp-chip--picked" : "dlp-chip--unpicked"}>
                {state === "all" ? "✓ " : ""}Mọi trạng thái
              </Tag>
              {STATES.map((s) => (
                <Tag key={s} value={s} appearance="outline" className={state === s ? "dlp-chip--picked" : "dlp-chip--unpicked"}>
                  {state === s ? "✓ " : ""}{TICKET_STATE_TEXT[s].label}
                </Tag>
              ))}
            </TagGroup>
          </div>
          <SearchInput
            value={q}
            onChange={setQ}
            placeholder="Tìm theo mã HT-… hoặc tiêu đề"
            label="Tìm yêu cầu hỗ trợ"
          />
        </div>

        <div className="dlp-sup__list">
          {rows.map((t) => (
            <ArticleRow
              key={t.id}
              title={`${t.id} · ${t.title}`}
              desc={`${TICKET_KIND_TEXT[t.kind]} · ${t.screen} · ưu tiên ${TICKET_PRIORITY_TEXT[t.priority].toLowerCase()} · cập nhật ${t.updatedAt}`}
              meta={
                <>
                  {t.unread ? <StatusPill tone="info" label="Mới phản hồi" /> : null}
                  <StatusPill
                    tone={TICKET_STATE_TEXT[t.state].tone}
                    label={TICKET_STATE_TEXT[t.state].label}
                  />
                </>
              }
              onClick={() => void navigate({ to: "/ho-tro/yeu-cau/$id", params: { id: t.id } })}
            />
          ))}
          {rows.length === 0 ? (
            <EmptyState
              title="Chưa có yêu cầu nào khớp bộ lọc"
              hint="Thử bỏ bớt bộ lọc hoặc gửi yêu cầu mới."
              actionLabel="Gửi yêu cầu mới"
              onAction={() => setDialog(true)}
            />
          ) : null}
        </div>
      </div>

      <NewTicketDialog
        open={dialog}
        onOpenChange={setDialog}
        onCreated={(id) => void navigate({ to: "/ho-tro/yeu-cau/$id", params: { id } })}
      />
    </SupportShell>
  );
}
