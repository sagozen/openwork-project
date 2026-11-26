import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  Checkbox,
  Field,
  MessageBar,
  MessageBarBody,
  Textarea,
} from "@fluentui/react-components";
import { Phone20Regular } from "@fluentui/react-icons";
import { NoAccess } from "@/components/lims/NoAccess";
import { EmptyState, PageHead, useDlpToast } from "@/components/lims/common";
import { ConnectedApprovalScreen } from "@/components/lims/approval/ConnectedApprovalScreen";
import { useAuth } from "@/lib/auth/AuthProvider";
import { PERM } from "@/lib/admin/rbac";
import { APPROVAL_SAMPLES } from "@/lib/admin/approval-data";

export const Route = createFileRoute("/_app/phe-duyet")({
  head: () => ({
    meta: [
      { title: "Phê duyệt mẫu - DLP LIMS" },
      {
        name: "description",
        content:
          "Theo dõi mẫu đã gửi, phê duyệt mẫu sau kiểm tra kỹ thuật hoặc trả mẫu về lab theo chỉ tiêu cần sửa.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ApprovalScreen,
});

function ApprovalScreen() {
  const { can, usesClerk } = useAuth();
  if (!can(PERM.REVIEW_APPROVE)) return <NoAccess screen="Phê duyệt mẫu" />;
  const canWrite = can(PERM.REVIEW_APPROVE);
  const canTrace = can(PERM.REVIEW_VERSION_HISTORY);
  if (usesClerk) return <ConnectedApprovalScreen canApprove={canWrite} canTrace={canTrace} />;
  return <DemoApprovalScreen canWrite={canWrite} canTrace={canTrace} />;
}

function DemoApprovalScreen({ canWrite, canTrace }: { canWrite: boolean; canTrace: boolean }) {
  const toast = useDlpToast();
  const [selected, setSelected] = useState<string>();
  const [decided, setDecided] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [failed, setFailed] = useState<string[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [phone, setPhone] = useState(false);
  const queue = APPROVAL_SAMPLES.filter((sample) => !decided.includes(sample.sampleCode));
  const sample = queue.find((item) => item.sampleCode === selected) ?? queue[0];
  const picked = sample?.sampleCode;
  const canDecide = canWrite && sample?.status === "REVIEWED";
  useEffect(() => {
    setNote("");
    setFailed([]);
    setHistoryOpen(false);
  }, [picked]);

  return (
    <div style={{ display: "grid", gap: 16, maxWidth: 1400 }}>
      <PageHead
        title="Phê duyệt mẫu"
        description="Duyệt kết quả từng mẫu sau kiểm tra kỹ thuật."
        actions={
          <Button icon={<Phone20Regular />} onClick={() => setPhone((value) => !value)}>
            {phone ? "Xem bản desktop" : "Xem bản điện thoại"}
          </Button>
        }
      />
      <MessageBar intent="info">
        <MessageBarBody>
          Dữ liệu minh họa. Phê duyệt mẫu và phát hành phiếu là hai bước riêng.
        </MessageBarBody>
      </MessageBar>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 16,
          justifyContent: phone ? "center" : undefined,
        }}
      >
        {!phone ? (
          <section
            className="dlp-card"
            style={{
              padding: 16,
              flex: "1 1 300px",
              display: "grid",
              alignContent: "start",
              gap: 8,
            }}
          >
            <strong>{queue.length} mẫu trong hàng chờ</strong>
            {queue.map((item) => (
              <Button
                key={item.sampleCode}
                appearance={picked === item.sampleCode ? "primary" : "subtle"}
                onClick={() => setSelected(item.sampleCode)}
              >
                {item.sampleCode} · {item.productName} · {item.parameters.length} chỉ tiêu ·{" "}
                {item.status === "SUBMITTED" ? "Chờ kiểm tra kỹ thuật" : "Chờ phê duyệt"}
              </Button>
            ))}
          </section>
        ) : null}
        <section
          className="dlp-card"
          style={{
            padding: 16,
            width: phone ? 390 : undefined,
            maxWidth: "100%",
            flex: phone ? undefined : "2 1 500px",
            display: "grid",
            alignContent: "start",
            gap: 12,
          }}
        >
          {phone ? (
            <Field label="Chọn mẫu">
              <select
                value={picked ?? ""}
                onChange={(event) => setSelected(event.target.value)}
                style={{ width: "100%", minHeight: 40 }}
              >
                {!picked ? <option value="">Không có mẫu</option> : null}
                {queue.map((item) => (
                  <option key={item.sampleCode} value={item.sampleCode}>
                    {item.sampleCode} · {item.productName} ·{" "}
                    {item.status === "SUBMITTED" ? "Chờ kiểm tra kỹ thuật" : "Chờ phê duyệt"}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          {!sample ? (
            <EmptyState
              title="Không có mẫu chờ phê duyệt"
              hint="Các mẫu đã quyết định được loại khỏi hàng chờ."
            />
          ) : (
            <>
              <h2>
                {sample.sampleCode} · {sample.productName}
              </h2>
              <span>
                Hồ sơ {sample.requestCode} · v{sample.version}
              </span>
              <Badge
                appearance="tint"
                color={sample.status === "SUBMITTED" ? "informative" : "warning"}
              >
                {sample.status === "SUBMITTED" ? "Chờ kiểm tra kỹ thuật" : "Chờ phê duyệt"}
              </Badge>
              {sample.status === "SUBMITTED" ? (
                <MessageBar intent="info">
                  <MessageBarBody>
                    Mẫu đang chờ kiểm tra kỹ thuật. Chưa thể phê duyệt hoặc trả mẫu.
                  </MessageBarBody>
                </MessageBar>
              ) : null}
              {sample.parameters.map((parameter) => (
                <article
                  key={parameter.code}
                  style={{
                    borderBottom: "1px solid var(--border-subtle)",
                    paddingBottom: 12,
                    display: "grid",
                    gap: 8,
                  }}
                >
                  <strong>
                    {parameter.code} · {parameter.name}
                  </strong>
                  <span>{parameter.method}</span>
                  <span>
                    Kết quả: {parameter.result} {parameter.unit}
                  </span>
                  <Checkbox
                    label="Cần sửa"
                    disabled={!canDecide}
                    checked={failed.includes(parameter.code)}
                    onChange={(_, data) =>
                      setFailed((current) =>
                        data.checked
                          ? [...current, parameter.code]
                          : current.filter((code) => code !== parameter.code),
                      )
                    }
                  />
                </article>
              ))}
              {canTrace ? (
                <Button onClick={() => setHistoryOpen((value) => !value)}>
                  {historyOpen ? "Đóng lịch sử" : "Lịch sử phiên bản"}
                </Button>
              ) : null}
              {historyOpen && canTrace ? (
                <div>
                  <strong>Lịch sử {sample.sampleCode}</strong>
                  {sample.history.map((version) => (
                    <p key={version.version}>
                      v{version.version} · {version.comment}
                    </p>
                  ))}
                </div>
              ) : null}
              <Field label="Ghi chú / lý do trả mẫu">
                <Textarea
                  disabled={!canDecide}
                  value={note}
                  onChange={(_, data) => setNote(data.value)}
                />
              </Field>
              <span>Trả mẫu: nhập lý do và chọn chỉ tiêu cần sửa.</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <Button
                  appearance="primary"
                  disabled={!canDecide}
                  onClick={() => {
                    if (
                      !window.confirm(
                        `Phê duyệt mẫu ${sample.sampleCode}? Các mẫu khác không bị thay đổi.`,
                      )
                    )
                      return;
                    setDecided((current) => [...current, sample.sampleCode]);
                    setSelected(undefined);
                    toast(
                      `Đã phê duyệt mẫu ${sample.sampleCode}`,
                      "Quyết định minh họa chỉ áp dụng cho mẫu đã chọn.",
                      "success",
                    );
                  }}
                >
                  Phê duyệt mẫu
                </Button>
                <Button
                  disabled={!canDecide || !note.trim() || !failed.length}
                  onClick={() => {
                    if (
                      !window.confirm(
                        `Trả mẫu ${sample.sampleCode} về lab để sửa ${failed.join(", ")}? Lý do: ${note.trim()}.`,
                      )
                    )
                      return;
                    setDecided((current) => [...current, sample.sampleCode]);
                    setSelected(undefined);
                    toast(
                      `Đã trả mẫu ${sample.sampleCode} về lab`,
                      "Các mẫu khác trong hồ sơ không bị thay đổi.",
                      "warning",
                    );
                  }}
                >
                  Trả mẫu về lab
                </Button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
