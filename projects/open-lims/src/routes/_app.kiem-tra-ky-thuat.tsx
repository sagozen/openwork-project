import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { NoAccess } from "@/components/lims/NoAccess";
import { PageHead, StatStrip, useDlpToast } from "@/components/lims/common";
import { ReviewQueue } from "@/components/lims/review/ReviewQueue";
import { ReviewDetail } from "@/components/lims/review/ReviewDetail";
import { ConnectedReviewScreen } from "@/components/lims/review/ConnectedReviewScreen";
import { useAuth } from "@/lib/auth/AuthProvider";
import { PERM } from "@/lib/admin/rbac";
import { REVIEW_ITEMS, reviewStats, type ReviewState } from "@/lib/admin/review-data";

export const Route = createFileRoute("/_app/kiem-tra-ky-thuat")({
  head: () => ({
    meta: [
      { title: "Kiểm tra kỹ thuật - DLP LIMS" },
      {
        name: "description",
        content:
          "Trưởng nhóm kiểm tra toàn bộ chỉ tiêu của mẫu, xem lịch sử và quyết định chấp nhận hoặc trả lại mẫu.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: TechReviewScreen,
});

function TechReviewScreen() {
  const { can, usesClerk } = useAuth();
  if (!can(PERM.REVIEW_TECHNICAL)) return <NoAccess screen="Kiểm tra kỹ thuật" />;
  const canWrite = can(PERM.REVIEW_TECHNICAL);
  const canTrace = can(PERM.REVIEW_VERSION_HISTORY);
  if (usesClerk) return <ConnectedReviewScreen canWrite={canWrite} canTrace={canTrace} />;
  return <DemoTechReviewScreen canWrite={canWrite} canTrace={canTrace} />;
}

function DemoTechReviewScreen({ canWrite, canTrace }: { canWrite: boolean; canTrace: boolean }) {
  const toast = useDlpToast();
  const [states, setStates] = useState<Record<string, ReviewState>>({ vo: "wait", cd: "wait" });
  const [picked, setPicked] = useState("vo");
  const [note, setNote] = useState("");
  const [traceOpen, setTraceOpen] = useState(false);
  const item = (REVIEW_ITEMS.find((i) => i.id === picked) ?? REVIEW_ITEMS[0])!;
  const state = states[item.id] ?? "wait";

  const decide = (id: string, next: ReviewState, title: string, body: string) => {
    setStates((s) => ({ ...s, [id]: next }));
    setNote("");
    toast(title, body, next === "back" ? "warning" : "success");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 1400, minWidth: 0 }}>
      <PageHead
        title="Kiểm tra kỹ thuật"
        description="Cổng 1 · kiểm tra kết quả ở cấp analysis task; không hiển thị dữ liệu khách hàng."
      />

      <StatStrip items={reviewStats(states)} />

      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <ReviewQueue
          items={REVIEW_ITEMS}
          states={states}
          picked={picked}
          canWrite={canWrite}
          onPick={(id) => {
            setPicked(id);
            setNote("");
            setTraceOpen(false);
          }}
          onQuick={(id) =>
            decide(
              id,
              "ok",
              `Đã xác nhận kỹ thuật ${REVIEW_ITEMS.find((i) => i.id === id)?.task.split(" - ")[0] ?? ""}`,
              "Hành động được ghi nhận độc lập cùng thời gian thực hiện.",
            )
          }
        />

        <ReviewDetail
          item={item}
          state={state}
          note={note}
          canWrite={canWrite}
          canTrace={canTrace}
          traceOpen={traceOpen}
          onNote={setNote}
          onTrace={(open) => {
            setTraceOpen(open);
            if (open) {
              toast(
                "Đã mở lịch sử lưu vết",
                "Lượt truy cập được ghi nhận trong nhật ký dữ liệu nhạy cảm.",
                "info",
              );
            }
          }}
          onAccept={() =>
            decide(
              item.id,
              "ok",
              "Đã chấp nhận kết quả",
              "Chỉ tiêu đã chuyển sang hàng chờ phê duyệt.",
            )
          }
          onReturn={() =>
            decide(
              item.id,
              "back",
              "Đã trả lại phòng lab",
              "Nhân viên lab nhập lại trên phiên bản mới; phiên bản cũ giữ nguyên.",
            )
          }
        />
      </div>
    </div>
  );
}
