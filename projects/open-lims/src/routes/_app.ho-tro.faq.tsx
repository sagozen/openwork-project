import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Button,
  Tag,
  TagGroup,
} from "@fluentui/react-components";
import { ThumbDislike20Regular, ThumbLike20Regular } from "@fluentui/react-icons";
import { NoAccess } from "@/components/lims/NoAccess";
import { EmptyState, PageHead, useDlpToast } from "@/components/lims/common";
import { useAuth } from "@/lib/auth/AuthProvider";
import { FAQ_CATS, FAQ_ITEMS } from "@/lib/support/support-data";
import { NewTicketDialog } from "@/components/lims/support/NewTicketDialog";
import { SupportCta, SupportHero, SupportShell } from "@/components/lims/support/SupportUI";

export const Route = createFileRoute("/_app/ho-tro/faq")({
  head: () => ({
    meta: [
      { title: "Câu hỏi thường gặp - Hỗ trợ DLP LIMS" },
      {
        name: "description",
        content:
          "Giải đáp nhanh về tài khoản, tiếp nhận mẫu, kết quả, phê duyệt và in ấn trong DLP LIMS.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: FaqScreen,
});

function FaqScreen() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const toast = useDlpToast();
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("all");
  const [dialog, setDialog] = useState(false);

  const items = useMemo(() => {
    const key = q.trim().toLowerCase();
    return FAQ_ITEMS.filter(
      (f) =>
        (cat === "all" || f.cat === cat) &&
        (!key || f.q.toLowerCase().includes(key) || f.a.toLowerCase().includes(key)),
    );
  }, [q, cat]);

  if (!can("support.view")) return <NoAccess screen="Câu hỏi thường gặp" />;

  return (
    <SupportShell>
      <PageHead
        crumbs={[{ label: "Hỗ trợ người dùng", to: "/ho-tro" }, { label: "Câu hỏi thường gặp" }]}
        title="Câu hỏi thường gặp"
        description="Những vướng mắc phổ biến nhất khi vận hành DLP LIMS."
      />

      <SupportHero
        title="Bạn đang thắc mắc điều gì?"
        subtitle="Tìm theo từ khoá hoặc chọn danh mục bên dưới."
        value={q}
        onChange={setQ}
        placeholder="Ví dụ: thu hồi phiếu, quên mật khẩu, in tem…"
      />

      <div className="dlp-sup__panel">
        <div className="dlp-sup__panel-head" style={{ flexWrap: "wrap" }}>
          <TagGroup selectedValues={[cat]} onTagSelect={(_, d) => setCat(String(d.value))}>
            <Tag value="all" appearance="outline" className={cat === "all" ? "dlp-chip--picked" : "dlp-chip--unpicked"}>
              {cat === "all" ? "✓ " : ""}Tất cả
            </Tag>
            {FAQ_CATS.map((c) => (
              <Tag key={c} value={c} appearance="outline" className={cat === c ? "dlp-chip--picked" : "dlp-chip--unpicked"}>
                {cat === c ? "✓ " : ""}{c}
              </Tag>
            ))}
          </TagGroup>
          <Button
            appearance="transparent"
            size="small"
            onClick={() => void navigate({ to: "/ho-tro/tai-lieu" })}
          >
            Xem tài liệu chi tiết
          </Button>
        </div>

        {items.length === 0 ? (
          <EmptyState
            title="Chưa có câu hỏi phù hợp"
            hint="Thử từ khoá khác hoặc gửi yêu cầu hỗ trợ."
            actionLabel="Gửi yêu cầu hỗ trợ"
            onAction={() => setDialog(true)}
          />
        ) : (
          <Accordion collapsible multiple>
            {items.map((f) => (
              <AccordionItem key={f.id} value={f.id}>
                <AccordionHeader>{f.q}</AccordionHeader>
                <AccordionPanel>
                  <div className="dlp-sup__faq-answer">{f.a}</div>
                  <div className="dlp-sup__faq-vote">
                    <span>Câu trả lời này có hữu ích không?</span>
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<ThumbLike20Regular />}
                      onClick={() => toast("Cảm ơn phản hồi của bạn", f.q, "success")}
                    >
                      Hữu ích
                    </Button>
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<ThumbDislike20Regular />}
                      onClick={() => setDialog(true)}
                    >
                      Chưa rõ
                    </Button>
                  </div>
                </AccordionPanel>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </div>

      <SupportCta onCreate={() => setDialog(true)} />

      <NewTicketDialog open={dialog} onOpenChange={setDialog} />
    </SupportShell>
  );
}
