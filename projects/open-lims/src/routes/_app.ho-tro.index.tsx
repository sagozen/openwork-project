import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Button } from "@fluentui/react-components";
import {
  BookQuestionMark24Regular,
  BugRegular,
  DocumentPdf24Regular,
  Lightbulb24Regular,
  TaskListSquareLtr24Regular,
} from "@fluentui/react-icons";
import { useSupportStore } from "@/lib/support/support-store";
import {
  FAQ_ITEMS,
  SUPPORT_DOCS,
  TICKET_KIND_TEXT,
  TICKET_STATE_TEXT,
} from "@/lib/support/support-data";
import { NewTicketDialog } from "@/components/lims/support/NewTicketDialog";
import {
  ArticleRow,
  StatusPill,
  SupportCard,
  SupportCta,
  SupportHero,
  SupportPanel,
  SupportShell,
} from "@/components/lims/support/SupportUI";
import type { TicketKind } from "@/lib/support/support-data";

export const Route = createFileRoute("/_app/ho-tro/")({
  head: () => ({
    meta: [
      { title: "Trung tâm hỗ trợ - DLP LIMS" },
      {
        name: "description",
        content:
          "Tìm câu trả lời, tải tài liệu hướng dẫn sử dụng, gửi yêu cầu hỗ trợ hoặc đề xuất tính năng cho DLP LIMS.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: SupportHome,
});

const HOT_CHIPS = [
  "in tem mẫu",
  "thu hồi phiếu",
  "quên mật khẩu",
  "nhập kết quả từ Excel",
  "phân công lab",
];

function SupportHome() {
  const navigate = useNavigate();
  const { tickets } = useSupportStore();
  const [q, setQ] = useState("");
  const [dialog, setDialog] = useState<TicketKind | null>(null);

  const results = useMemo(() => {
    const key = q.trim().toLowerCase();
    if (!key) return null;
    return {
      faqs: FAQ_ITEMS.filter(
        (f) => f.q.toLowerCase().includes(key) || f.a.toLowerCase().includes(key),
      ).slice(0, 5),
      docs: SUPPORT_DOCS.filter(
        (d) => d.title.toLowerCase().includes(key) || d.desc.toLowerCase().includes(key),
      ).slice(0, 5),
      tickets: tickets
        .filter((t) => t.id.toLowerCase().includes(key) || t.title.toLowerCase().includes(key))
        .slice(0, 5),
    };
  }, [q, tickets]);

  const recent = tickets.slice(0, 4);
  const popular = FAQ_ITEMS.slice(0, 5);

  return (
    <SupportShell>
      <SupportHero
        title="Chúng tôi có thể giúp gì?"
        subtitle="Tra cứu hướng dẫn, tải tài liệu hoặc gửi yêu cầu tới đội hỗ trợ DLP LIMS."
        value={q}
        onChange={setQ}
        chips={HOT_CHIPS}
        onChipClick={setQ}
      />

      {results ? (
        <SupportPanel title={`Kết quả cho “${q}”`}>
          <div className="dlp-sup__list">
            {results.faqs.map((f) => (
              <ArticleRow
                key={f.id}
                title={f.q}
                desc={f.a.slice(0, 110) + "…"}
                meta={<span>{f.cat}</span>}
                onClick={() => void navigate({ to: "/ho-tro/faq" })}
              />
            ))}
            {results.docs.map((d) => (
              <ArticleRow
                key={d.id}
                title={d.title}
                desc={d.desc}
                meta={<span>Tài liệu · {d.version}</span>}
                onClick={() => void navigate({ to: "/ho-tro/tai-lieu" })}
              />
            ))}
            {results.tickets.map((t) => (
              <ArticleRow
                key={t.id}
                title={`${t.id} · ${t.title}`}
                desc={t.summary}
                meta={
                  <StatusPill
                    tone={TICKET_STATE_TEXT[t.state].tone}
                    label={TICKET_STATE_TEXT[t.state].label}
                  />
                }
                onClick={() =>
                  void navigate({
                    to: "/ho-tro/yeu-cau/$id",
                    params: { id: t.id },
                  })
                }
              />
            ))}
            {results.faqs.length + results.docs.length + results.tickets.length === 0 ? (
              <div style={{ padding: "18px", color: "var(--foreground-secondary)" }}>
                Không có kết quả phù hợp. Bạn có thể gửi yêu cầu hỗ trợ ở cuối trang.
              </div>
            ) : null}
          </div>
        </SupportPanel>
      ) : null}

      <div className="dlp-sup__cards">
        <SupportCard
          icon={<DocumentPdf24Regular />}
          title="Tài liệu phần mềm"
          desc="HDSD theo vai trò, quy trình nghiệp vụ, biểu mẫu và ghi chú phiên bản."
          count={`${SUPPORT_DOCS.length} tài liệu`}
          to="/ho-tro/tai-lieu"
        />
        <SupportCard
          icon={<BugRegular fontSize={24} />}
          title="Báo lỗi phần mềm"
          desc="Gửi lỗi kèm màn hình, các bước tái hiện và ảnh bằng chứng."
          count="Phản hồi trong 4 giờ làm việc"
          onClick={() => setDialog("bug")}
        />
        <SupportCard
          icon={<Lightbulb24Regular />}
          title="Đề xuất tính năng"
          desc="Chia sẻ ý tưởng giúp công việc hằng ngày nhanh và ít sai sót hơn."
          count="Được xem xét hằng tháng"
          onClick={() => setDialog("feature")}
        />
        <SupportCard
          icon={<TaskListSquareLtr24Regular />}
          title="Yêu cầu của tôi"
          desc="Theo dõi tiến độ và trao đổi với đội hỗ trợ."
          count={`${tickets.length} yêu cầu`}
          to="/ho-tro/yeu-cau"
        />
      </div>

      <div className="dlp-sup__cards dlp-sup__cards--two">
        <SupportPanel
          title="Yêu cầu gần đây"
          action={
            <Button
              appearance="transparent"
              size="small"
              onClick={() => void navigate({ to: "/ho-tro/yeu-cau" })}
            >
              Xem tất cả
            </Button>
          }
        >
          <div className="dlp-sup__list">
            {recent.map((t) => (
              <ArticleRow
                key={t.id}
                title={`${t.id} · ${t.title}`}
                desc={`${TICKET_KIND_TEXT[t.kind]} · cập nhật ${t.updatedAt}`}
                meta={
                  <StatusPill
                    tone={TICKET_STATE_TEXT[t.state].tone}
                    label={TICKET_STATE_TEXT[t.state].label}
                  />
                }
                onClick={() =>
                  void navigate({
                    to: "/ho-tro/yeu-cau/$id",
                    params: { id: t.id },
                  })
                }
              />
            ))}
          </div>
        </SupportPanel>

        <SupportPanel
          title="Câu hỏi hay xem"
          action={
            <Button
              appearance="transparent"
              size="small"
              icon={<BookQuestionMark24Regular fontSize={16} />}
              onClick={() => void navigate({ to: "/ho-tro/faq" })}
            >
              Tất cả FAQ
            </Button>
          }
        >
          <div className="dlp-sup__list">
            {popular.map((f) => (
              <ArticleRow
                key={f.id}
                title={f.q}
                meta={<span>{f.cat}</span>}
                onClick={() => void navigate({ to: "/ho-tro/faq" })}
              />
            ))}
          </div>
        </SupportPanel>
      </div>

      <SupportCta onCreate={() => setDialog("help")} />

      <NewTicketDialog
        open={dialog !== null}
        defaultKind={dialog ?? "help"}
        onOpenChange={(o) => setDialog(o ? dialog : null)}
        onCreated={(id) => void navigate({ to: "/ho-tro/yeu-cau/$id", params: { id } })}
      />
    </SupportShell>
  );
}
