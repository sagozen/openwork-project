import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Badge,
  Button,
  Checkbox,
  Field,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  Textarea,
} from "@fluentui/react-components";
import { Phone20Regular } from "@fluentui/react-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiErrorMessage, useApiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth/AuthProvider";
import { PERM } from "@/lib/admin/rbac";
import { sampleApi, statusLabel, type SampleApprovalList } from "@/features/sample/sample-api";
import { invalidateRequestRecords } from "@/features/request";
import { technicalReviewKeys } from "@/features/review";
import { labKeys } from "@/features/lab";
import { getReportPreview, reportApi } from "@/features/report/api";
import { reportKeys } from "@/features/report/hooks";
import { EmptyState, FieldLabel, PageHead, useDlpToast } from "@/components/lims/common";
import { toneToColor } from "@/lib/admin/tone";
import { formatDateTime } from "@/lib/format";

type ApprovalDecision =
  | { code: string; version: number; decision: "APPROVE"; note?: string }
  | {
      code: string;
      version: number;
      decision: "REJECT";
      comment: string;
      failedParameters: string[];
    };

export function ConnectedApprovalScreen({
  canApprove,
  canTrace,
}: {
  canApprove: boolean;
  canTrace: boolean;
}) {
  const api = useApiClient();
  const cache = useQueryClient();
  const { can } = useAuth();
  const toast = useDlpToast();
  const navigate = useNavigate();
  const [approvedSample, setApprovedSample] = useState<{
    requestCode: string;
    sampleCode: string;
  }>();
  const canReadReports = can(PERM.REPORT_READ);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string>();
  const [note, setNote] = useState("");
  const [failed, setFailed] = useState<string[]>([]);
  const [phone, setPhone] = useState(false);
  const [historyCode, setHistoryCode] = useState<string>();
  const [previewSelection, setPreviewSelection] = useState<{
    sampleCode: string;
    reportId: string;
  }>();
  const queue = useQuery({
    queryKey: ["sample-approval-queue", page],
    queryFn: () => sampleApi.approvalQueue(api, page, 50),
  });
  // Never retain a selected sample that has left this page or the approval queue.
  const queueItem =
    queue.data?.content.find((item) => item.sampleCode === selected) ?? queue.data?.content[0];
  const picked = queueItem?.sampleCode;
  const detail = useQuery({
    queryKey: ["sample-approval", picked],
    queryFn: () => sampleApi.approval(api, picked!),
    enabled: !!picked,
  });
  const history = useQuery({
    queryKey: ["sample-result-versions", picked],
    queryFn: () => sampleApi.resultVersions(api, picked!),
    enabled: !!picked && historyCode === picked && canTrace,
  });
  const reports = useQuery({
    queryKey: reportKeys.list({ sampleCode: picked ?? "" }),
    queryFn: () => reportApi.listForSample(api, picked!),
    enabled: !!picked && canReadReports,
  });
  const report = reports.data?.find((item) => item.current) ?? reports.data?.[0];
  const previewRequested =
    !!picked && previewSelection?.sampleCode === picked && previewSelection.reportId === report?.id;
  const preview = useQuery({
    queryKey: ["report-preview", picked, report?.id, "DRAFT"],
    queryFn: () => getReportPreview(api, report!.id, "DRAFT"),
    enabled: previewRequested && !!report && canReadReports,
  });
  const [previewUrl, setPreviewUrl] = useState<string>();
  useEffect(() => {
    if (!preview.data || !previewRequested || !canReadReports) {
      setPreviewUrl(undefined);
      return;
    }
    const url = URL.createObjectURL(preview.data);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [preview.data, previewRequested, canReadReports]);

  const action = useMutation({
    mutationFn: (input: ApprovalDecision) =>
      input.decision === "APPROVE"
        ? sampleApi.approve(api, input.code, { version: input.version, note: input.note })
        : sampleApi.rejectApproval(api, input.code, {
            version: input.version,
            comment: input.comment,
            failedParameters: input.failedParameters,
          }),
    onSuccess: async (workspace, input) => {
      if (input.decision === "APPROVE") {
        setApprovedSample({ requestCode: workspace.requestCode, sampleCode: workspace.sampleCode });
      }
      // Remove only the decided sample immediately; the refetch replenishes the page.
      cache.setQueryData<SampleApprovalList>(["sample-approval-queue", page], (current) =>
        current
          ? {
              ...current,
              content: current.content.filter((item) => item.sampleCode !== input.code),
            }
          : current,
      );
      setSelected(undefined);
      setNote("");
      setFailed([]);
      setHistoryCode(undefined);
      setPreviewSelection(undefined);
      await Promise.all([
        ...[
          "sample-approval-queue",
          "sample-approval",
          "sample-review-queue",
          "sample-review",
          "sample-results",
          "sample-result-versions",
          "managed-samples",
          "managed-sample",
          "reception-sample",
          "report-preview",
        ].map((key) => cache.invalidateQueries({ queryKey: [key] })),
        cache.invalidateQueries({ queryKey: technicalReviewKeys.all }),
        cache.invalidateQueries({ queryKey: labKeys.all }),
        cache.invalidateQueries({ queryKey: reportKeys.all }),
        invalidateRequestRecords(cache),
      ]);
      toast(
        input.decision === "APPROVE"
          ? `Đã phê duyệt mẫu ${input.code}`
          : `Đã trả mẫu ${input.code} về lab`,
        input.decision === "APPROVE"
          ? "Quyết định lãnh đạo được lưu riêng với kiểm tra kỹ thuật. Phát hành phiếu là bước riêng."
          : "Lab chỉ được sửa các chỉ tiêu đã chọn; mẫu phải qua kiểm tra kỹ thuật lại trước khi phê duyệt.",
        input.decision === "APPROVE" ? "success" : "warning",
      );
    },
  });
  useEffect(() => {
    setNote("");
    setFailed([]);
    setHistoryCode(undefined);
    setPreviewSelection(undefined);
  }, [picked, page]);
  useEffect(() => {
    if (queue.data && page > Math.max(1, queue.data.page.totalPages)) {
      setSelected(undefined);
      setPage(Math.max(1, queue.data.page.totalPages));
    }
  }, [queue.data, page]);

  const workspace = detail.data;
  const reviewed =
    !!workspace &&
    (typeof workspace.status === "string" ? workspace.status : workspace.status.code) ===
      "REVIEWED" &&
    workspace.approvalStatus.code === "AWAITING_APPROVAL";
  const mayApprove =
    reviewed &&
    canApprove &&
    !!queueItem?.allowedActions.includes("approval:approve") &&
    !!workspace?.allowedActions.includes("approval:approve") &&
    (workspace?.blockingReasons.length ?? 0) === 0;
  const mayReject =
    reviewed &&
    canApprove &&
    !!queueItem?.allowedActions.includes("approval:reject") &&
    !!workspace?.allowedActions.includes("approval:reject");
  const changePage = (next: number) => {
    action.reset();
    setSelected(undefined);
    setPage(next);
  };
  const pagination = queue.data ? (
    <div style={{ padding: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <Button
        size="small"
        disabled={page <= 1 || action.isPending}
        onClick={() => changePage(page - 1)}
      >
        Trước
      </Button>
      <span>
        Trang {queue.data.page.number}/{queue.data.page.totalPages || 1} ·{" "}
        {queue.data.page.totalElements} mẫu
      </span>
      <Button
        size="small"
        disabled={page >= queue.data.page.totalPages || action.isPending}
        onClick={() => changePage(page + 1)}
      >
        Sau
      </Button>
    </div>
  ) : null;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr)",
        gap: 16,
        maxWidth: 1400,
        minWidth: 0,
      }}
    >
      <PageHead
        title="Phê duyệt mẫu"
        description="Duyệt kết quả từng mẫu sau kiểm tra kỹ thuật."
        actions={
          <Button icon={<Phone20Regular />} onClick={() => setPhone((value) => !value)}>
            {phone ? "Xem bản desktop" : "Xem bản điện thoại"}
          </Button>
        }
      />
      {approvedSample ? (
        <MessageBar intent="success">
          <MessageBarBody>
            <MessageBarTitle>Đã phê duyệt mẫu {approvedSample.sampleCode}</MessageBarTitle>
            Phê duyệt chưa phải phát hành. Dựng phiếu, in để ký tay và đóng dấu, tải bản scan rồi
            phát hành.
            {canReadReports ? (
              <Button
                appearance="primary"
                onClick={() =>
                  void navigate({
                    to: "/tra-ket-qua",
                    search: {
                      code: approvedSample.requestCode,
                      sampleCode: approvedSample.sampleCode,
                    },
                  })
                }
              >
                Mở trả kết quả mẫu {approvedSample.sampleCode}
              </Button>
            ) : null}
          </MessageBarBody>
        </MessageBar>
      ) : null}
      {queue.isLoading ? <Spinner label="Đang tải mẫu chờ phê duyệt…" /> : null}
      {[queue.error, detail.error, action.variables?.code === picked ? action.error : null]
        .filter(Boolean)
        .map((error, index) => (
          <MessageBar key={index} intent="error">
            <MessageBarBody>{apiErrorMessage(error)}</MessageBarBody>
          </MessageBar>
        ))}
      <div
        style={{
          display: "flex",
          gap: phone ? 0 : 12,
          justifyContent: phone ? "center" : undefined,
          alignItems: "flex-start",
          flexWrap: "wrap",
        }}
      >
        {!phone ? (
          <section
            className="dlp-pane"
            style={{
              flex: "1 1 330px",
              border: "1px solid var(--border-subtle)",
              borderRadius: 8,
              overflow: "hidden",
            }}
          >
            {(queue.data?.content ?? []).map((item) => (
              <button
                key={item.sampleCode}
                type="button"
                disabled={action.isPending}
                onClick={() => {
                  action.reset();
                  setSelected(item.sampleCode);
                }}
                aria-pressed={picked === item.sampleCode}
                style={{
                  width: "100%",
                  textAlign: "left",
                  border: 0,
                  borderBottom: "1px solid var(--border-subtle)",
                  padding: 14,
                  background:
                    picked === item.sampleCode
                      ? "var(--background-selected)"
                      : "var(--background-card)",
                  cursor: "pointer",
                  display: "grid",
                  gap: 5,
                  color: "inherit",
                }}
              >
                <strong>
                  {item.sampleCode} · {item.productName}
                </strong>
                <span>
                  Hồ sơ {item.requestCode} · {item.parameterCount} chỉ tiêu · v{item.version}
                </span>
                <Badge appearance="tint" color={toneToColor(item.status.tone)}>
                  {item.status.name}
                </Badge>
                {item.status.code === "SUBMITTED" ? <span>Đang chờ kiểm tra kỹ thuật</span> : null}
              </button>
            ))}
            {pagination}
          </section>
        ) : null}
        <section
          className="dlp-pane"
          style={{
            width: phone ? 390 : undefined,
            maxWidth: "100%",
            flex: phone ? undefined : "2 1 600px",
            border: "1px solid var(--border-subtle)",
            borderRadius: phone ? 22 : 8,
            overflow: "hidden",
            background: "var(--background-card)",
          }}
        >
          {phone ? (
            <div
              style={{
                padding: 16,
                background: "var(--action-primary)",
                color: "white",
                fontWeight: 700,
              }}
            >
              Phê duyệt mẫu trên điện thoại
            </div>
          ) : null}
          <div
            style={{ padding: 16, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 14 }}
          >
            {phone ? (
              <>
                <Field label="Chọn mẫu">
                  <select
                    value={picked ?? ""}
                    disabled={action.isPending || !queue.data?.content.length}
                    onChange={(event) => {
                      action.reset();
                      setSelected(event.target.value);
                    }}
                    style={{ width: "100%", minHeight: 40 }}
                  >
                    {!picked ? <option value="">Không có mẫu</option> : null}
                    {queue.data?.content.map((item) => (
                      <option key={item.sampleCode} value={item.sampleCode}>
                        {item.sampleCode} · {item.productName} · {item.status.name}
                      </option>
                    ))}
                  </select>
                </Field>
                {pagination}
              </>
            ) : null}
            {!picked && queue.isSuccess ? (
              <EmptyState
                title="Không có mẫu chờ phê duyệt"
                hint="Hàng chờ gồm các mẫu đã gửi hoặc đã qua kiểm tra kỹ thuật, chưa được phê duyệt."
              />
            ) : null}
            {detail.isLoading ? <Spinner label="Đang tải mẫu phê duyệt…" /> : null}
            {workspace ? (
              <>
                <div style={{ display: "grid", gap: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <strong>
                      {workspace.sampleCode} · {queueItem?.productName}
                    </strong>
                    <Badge appearance="tint" color={toneToColor(workspace.approvalStatus.tone)}>
                      {workspace.approvalStatus.name}
                    </Badge>
                  </div>
                  <span>
                    Hồ sơ {workspace.requestCode} · {statusLabel(workspace.status)} · phiên bản{" "}
                    {workspace.version}
                  </span>
                </div>
                {workspace.approvalStatus.code === "AWAITING_REVIEW" ? (
                  <MessageBar intent="info" layout="multiline">
                    <MessageBarBody>
                      <MessageBarTitle>Đang chờ kiểm tra kỹ thuật</MessageBarTitle>
                      Chưa thể phê duyệt hoặc trả mẫu.
                    </MessageBarBody>
                  </MessageBar>
                ) : null}
                {workspace.parameters.map((parameter) => (
                  <article
                    key={parameter.code}
                    style={{
                      border: "1px solid var(--border-subtle)",
                      borderRadius: 8,
                      padding: 12,
                      display: "grid",
                      gridTemplateColumns: "minmax(0, 1fr)",
                      gap: 8,
                    }}
                  >
                    <strong>
                      {parameter.code} · {parameter.name}
                    </strong>
                    <span style={{ color: "var(--foreground-secondary)" }}>{parameter.method}</span>
                    {parameter.resultSets.map((result) => (
                      <div key={result.testPart}>
                        <span>
                          <strong>{result.testPart}:</strong>{" "}
                          {result.finalResult?.value ?? "Chưa chốt kết quả"}{" "}
                          {result.finalResult?.unit}
                        </span>
                      </div>
                    ))}
                    <Checkbox
                      label="Cần sửa"
                      checked={failed.includes(parameter.code)}
                      disabled={!mayReject || action.isPending}
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
                  <Button
                    onClick={() => setHistoryCode(historyCode === picked ? undefined : picked)}
                  >
                    {historyCode === picked ? "Đóng lịch sử" : "Lịch sử phiên bản"}
                  </Button>
                ) : null}
                {canTrace && historyCode === picked ? (
                  <div
                    style={{
                      border: "1px solid var(--border-subtle)",
                      borderRadius: 8,
                      padding: 12,
                      display: "grid",
                      gap: 8,
                    }}
                  >
                    <strong>Lịch sử mẫu {picked}</strong>
                    {history.isLoading ? <Spinner label="Đang tải lịch sử mẫu…" /> : null}
                    {history.isError ? (
                      <MessageBar intent="error">
                        <MessageBarBody>{apiErrorMessage(history.error)}</MessageBarBody>
                      </MessageBar>
                    ) : null}
                    {history.data && !history.data.content.length ? (
                      <span>Chưa có phiên bản lưu vết.</span>
                    ) : null}
                    {history.data?.content.map((version) => (
                      <div key={version.version}>
                        <strong>v{version.version}</strong> · {version.decision} · {version.actorId}{" "}
                        · {formatDateTime(version.occurredAt)}
                        {version.comment ? <div>Lý do: {version.comment}</div> : null}
                        {version.failedParameters.length ? (
                          <div>Chỉ tiêu cần sửa: {version.failedParameters.join(", ")}</div>
                        ) : null}
                        {version.parameters.map((parameter) => (
                          <div key={parameter.code}>
                            <strong>
                              {parameter.code} · {parameter.name}
                            </strong>
                            {parameter.resultSets.map((result) => (
                              <div key={result.testPart}>
                                {result.testPart}: {result.finalResult?.value ?? "Chưa chốt"}{" "}
                                {result.finalResult?.unit}
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                ) : null}
                {workspace.blockingReasons.length ? (
                  <MessageBar intent="warning" layout="multiline">
                    <MessageBarBody>
                      <MessageBarTitle>Chưa thể phê duyệt</MessageBarTitle>
                      {workspace.blockingReasons.map((reason, index) => (
                        <div key={index}>{reason}</div>
                      ))}
                    </MessageBarBody>
                  </MessageBar>
                ) : null}
                <div
                  style={{
                    border: "1px dashed var(--border-default)",
                    borderRadius: 8,
                    padding: 14,
                    display: "grid",
                    gap: 8,
                  }}
                >
                  <strong>Xem trước phiếu của mẫu {picked}</strong>
                  {!canReadReports ? (
                    <span>Cần quyền xem phiếu kết quả để xem các phiên bản phiếu của mẫu.</span>
                  ) : (
                    <>
                      {reports.isLoading ? <Spinner label="Đang tải phiếu của mẫu…" /> : null}
                      {reports.isError ? (
                        <MessageBar intent="error">
                          <MessageBarBody>{apiErrorMessage(reports.error)}</MessageBarBody>
                        </MessageBar>
                      ) : null}
                      {reports.isSuccess && !report ? (
                        <span>
                          Mẫu chưa có phiếu. Phê duyệt mẫu không yêu cầu dựng hoặc phát hành phiếu
                          tại đây.
                        </span>
                      ) : null}
                      {report ? (
                        <Button
                          onClick={() =>
                            setPreviewSelection({ sampleCode: picked!, reportId: report.id })
                          }
                        >
                          Mở bản xem trước PDF
                        </Button>
                      ) : null}
                      {previewRequested && preview.isLoading ? (
                        <Spinner label="Đang dựng bản xem trước…" />
                      ) : null}
                      {previewRequested && preview.isError ? (
                        <MessageBar intent="error">
                          <MessageBarBody>{apiErrorMessage(preview.error)}</MessageBarBody>
                        </MessageBar>
                      ) : null}
                      {previewRequested && previewUrl ? (
                        <iframe
                          title={`Xem trước phiếu mẫu ${picked} · ${report?.reportCode ?? ""}`}
                          src={previewUrl}
                          style={{ width: "100%", minHeight: phone ? 420 : 620, border: 0 }}
                        />
                      ) : null}
                    </>
                  )}
                </div>
                <Field
                  label={
                    <FieldLabel
                      label="Ghi chú / lý do trả mẫu"
                      tooltip="Khi trả mẫu: nhập lý do và chọn ít nhất một chỉ tiêu cần sửa."
                    />
                  }
                >
                  <Textarea
                    rows={3}
                    value={note}
                    disabled={action.isPending || (!mayApprove && !mayReject)}
                    onChange={(_, data) => setNote(data.value)}
                  />
                </Field>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Button
                    appearance="primary"
                    size={phone ? "large" : "medium"}
                    disabled={!mayApprove || action.isPending}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Phê duyệt toàn bộ kết quả của mẫu ${workspace.sampleCode}? Quyết định này không phê duyệt các mẫu khác trong hồ sơ.`,
                        )
                      ) {
                        action.mutate({
                          code: workspace.sampleCode,
                          version: workspace.version,
                          decision: "APPROVE",
                          note: note.trim() || undefined,
                        });
                      }
                    }}
                  >
                    Phê duyệt mẫu
                  </Button>
                  <Button
                    size={phone ? "large" : "medium"}
                    disabled={!mayReject || !note.trim() || !failed.length || action.isPending}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Trả mẫu ${workspace.sampleCode} về lab để sửa ${failed.join(", ")}? Lý do: ${note.trim()}. Các mẫu khác không bị thay đổi.`,
                        )
                      ) {
                        action.mutate({
                          code: workspace.sampleCode,
                          version: workspace.version,
                          decision: "REJECT",
                          comment: note.trim(),
                          failedParameters: failed,
                        });
                      }
                    }}
                  >
                    Trả mẫu về lab
                  </Button>
                  {action.isPending ? <Spinner size="tiny" label="Đang ghi quyết định…" /> : null}
                </div>
                {mayReject && (!note.trim() || !failed.length) ? (
                  <span style={{ color: "var(--foreground-secondary)" }}>
                    Trả mẫu: nhập lý do và chọn chỉ tiêu cần sửa.
                  </span>
                ) : null}
              </>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
