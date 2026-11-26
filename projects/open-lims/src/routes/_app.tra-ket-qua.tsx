import { useIsMutating, useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  Badge,
  Button,
  Checkbox,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  Textarea,
} from "@fluentui/react-components";
import { Checkmark16Regular, Copy16Regular } from "@fluentui/react-icons";
import { useEffect, useMemo, useState } from "react";
import { NoAccess } from "@/components/lims/NoAccess";
import {
  FieldLabel,
  FileDropField,
  PageHead,
  StatStrip,
  useDlpToast,
} from "@/components/lims/common";
import { DeliveryMailCard } from "@/components/lims/delivery/DeliveryMailCard";
import { DeliverySidePane } from "@/components/lims/delivery/DeliverySidePane";
import { ReportSupplementaryDocuments } from "@/components/lims/delivery/ReportSupplementaryDocuments";
import { card, hintText, sectionTitle } from "@/components/lims/request-styles";
import {
  everReleasedStatuses,
  getReportPdf,
  getReportPreview,
  openBlob,
  reportApi,
  saveBlob,
  supplementaryDocumentKeys,
  useReport,
  useReportApi,
  useReportRecipientContact,
  useReportDeliveries,
  useReportMutation,
  useReports,
  type ReportVersion,
  type SignerMismatchWarning,
} from "@/features/report";
import { apiErrorMessage, uploadFile } from "@/lib/api";
import {
  DELIVERY_CERT,
  LOOKUP_NOTE,
  attachmentName,
  deliveryStats,
  type CertStatus,
} from "@/lib/admin/delivery-data";
import { toneToColor } from "@/lib/admin/tone";
import { useAuth } from "@/lib/auth/AuthProvider";
import { PERM } from "@/lib/admin/rbac";
import { searchString } from "@/lib/route-search";
import { formatDateTime } from "@/lib/format";
import { useRequestDetail, type RequestedSample } from "@/features/request";
import {
  selectDeliveryReport,
  selectDeliverySample,
} from "@/features/report/select-delivery-report";

interface Search {
  code?: string;
  sampleCode?: string;
}

export const Route = createFileRoute("/_app/tra-ket-qua")({
  validateSearch: (search: Record<string, unknown>): Search => ({
    code: searchString(search["code"]),
    sampleCode: searchString(search["sampleCode"]),
  }),
  head: () => ({
    meta: [
      { title: "Trả kết quả & thay thế phiếu - DLP LIMS" },
      {
        name: "description",
        content:
          "Dựng, tải bản ký tay, phát hành, gửi bản nháp, gửi PDF và thay thế phiếu kết quả.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: DeliveryScreen,
});

function DeliveryScreen() {
  const { can, usesClerk } = useAuth();
  if (!can(PERM.REPORT_READ)) return <NoAccess screen="Trả kết quả" />;
  return usesClerk ? <ConnectedDeliveryScreen /> : <DemoDeliveryScreen />;
}

const recipientsFrom = (value: string) =>
  value
    .split(/[;,\n]/)
    .map((recipient) => recipient.trim())
    .filter(Boolean);

const formatTime = formatDateTime;

/** Checksum là chuỗi băm dài (ví dụ `sha256:0f16a33e…`) nên luôn cắt bớt trong một dòng, giữ
 * giá trị đầy đủ ở tooltip và cho copy nhanh. */
function ChecksumText({ value, maxWidth = 220 }: { value: string; maxWidth?: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, minWidth: 0, maxWidth }}>
      <span className="dlp-num dlp-truncate" title={value} style={{ minWidth: 0 }}>
        {value}
      </span>
      <Button
        size="small"
        appearance="subtle"
        title="Sao chép checksum"
        aria-label="Sao chép checksum"
        icon={copied ? <Checkmark16Regular /> : <Copy16Regular />}
        onClick={() => {
          void navigator.clipboard?.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }}
      />
    </span>
  );
}

function ConnectedDeliveryScreen() {
  const { can } = useAuth();
  const toast = useDlpToast();
  const api = useReportApi();
  const canBuild = can(PERM.REPORT_BUILD);
  const canSign = can(PERM.REPORT_SIGN);
  const canAddSupplementaryDocument = can(PERM.REPORT_SUPPLEMENTARY_DOCUMENT_ADD);
  const canRelease = can(PERM.REPORT_RELEASE);
  const canReplace = can(PERM.REPORT_REPLACE);
  const canDeliver = can(PERM.REPORT_DELIVER);
  const supplementaryBusy = useIsMutating({ mutationKey: supplementaryDocumentKeys.all }) > 0;
  // Mở màn từ chi tiết hồ sơ («Mở màn trả kết quả») mang theo `?code=` - nạp thẳng chuỗi phiên bản
  // của hồ sơ đó thay vì bắt người dùng gõ lại mã vào ô tìm.
  const { code: deepLinkedCode, sampleCode: deepLinkedSampleCode } = Route.useSearch();
  const [requestCodeInput, setRequestCodeInput] = useState(deepLinkedCode ?? "");
  const [requestCode, setRequestCode] = useState(deepLinkedCode ?? "");
  const [sampleCode, setSampleCode] = useState(deepLinkedSampleCode ?? "");
  const [selectedId, setSelectedId] = useState<string>();
  const [recipients, setRecipients] = useState("");
  const [replaceReason, setReplaceReason] = useState("");
  const [signedFile, setSignedFile] = useState<File>();
  // Cảnh báo lệch người ký do máy chủ trả về trên chính lượt gắn (200, không phải lỗi).
  // Giữ trong state vì lần đọc lại phiếu sau đó không mang theo cảnh báo này.
  const [scanWarning, setScanWarning] = useState<SignerMismatchWarning>();
  const [draftNote, setDraftNote] = useState("");
  const [noteDraft, setNoteDraft] = useState<{ reportId: string; value: string }>();
  const [confirmResend, setConfirmResend] = useState(false);

  const reportsQuery = useReports(requestCode, true);
  const requestQuery = useRequestDetail(requestCode, can(PERM.REQUEST_READ));
  const samples = useMemo<RequestedSample[]>(() => {
    if (can(PERM.REQUEST_READ)) return requestQuery.data?.samples ?? [];
    // Read-only report roles can still browse existing families without request.read.
    return [...new Set(reportsQuery.data?.map((report) => report.sampleCode).filter(Boolean))].map(
      (code) => ({ code }),
    );
  }, [can, requestQuery.data?.samples, reportsQuery.data]);
  const allReports = useMemo(() => reportsQuery.data ?? [], [reportsQuery.data]);
  const hasLegacyReports = allReports.some((report) => !report.sampleCode);
  // Historic dossier PDFs retain their identity; never attribute one to an arbitrary sample.
  const viewingLegacy = sampleCode === "__legacy_dossier__" && hasLegacyReports;
  const pickedSample = selectDeliverySample(samples, sampleCode);
  const pickedSampleCode = pickedSample?.code;
  const reports = useMemo(
    () =>
      allReports.filter((report) =>
        viewingLegacy
          ? !report.sampleCode
          : Boolean(pickedSampleCode) && report.sampleCode === pickedSampleCode,
      ),
    [allReports, pickedSampleCode, viewingLegacy],
  );
  const selectedListItem = selectDeliveryReport(
    allReports,
    viewingLegacy ? null : pickedSampleCode,
    selectedId,
  );
  // `GET /reports/{id}` is the authoritative single-report detail - the list already carries the
  // full field set too, but fetching detail on selection keeps the panel correct across a page
  // reload without depending on a mutation response from earlier this session.
  const reportDetailQuery = useReport(selectedListItem?.id, Boolean(selectedListItem));
  const recipientContactQuery = useReportRecipientContact(
    selectedListItem?.id,
    Boolean(selectedListItem),
  );
  const selected = useMemo(() => {
    if (!selectedListItem) return undefined;
    return reportDetailQuery.data
      ? { ...selectedListItem, ...reportDetailQuery.data }
      : selectedListItem;
  }, [selectedListItem, reportDetailQuery.data]);
  const reportNote =
    noteDraft?.reportId === selected?.id ? (noteDraft?.value ?? "") : (selected?.note ?? "");
  const noteDirty = reportNote.trim() !== (selected?.note ?? "");
  const noteEditable =
    canBuild && selected?.status.code === "PENDING_SIGNATURE" && !selected.hasSignedScan;
  const deliveriesQuery = useReportDeliveries(selected?.id, Boolean(selected));

  useEffect(() => {
    if (pickedSampleCode && !sampleCode) setSampleCode(pickedSampleCode);
  }, [pickedSampleCode, sampleCode]);

  useEffect(() => {
    if (selectedListItem && selectedListItem.id !== selectedId) setSelectedId(selectedListItem.id);
  }, [selectedListItem, selectedId]);

  // Files and confirmations belong to one version, never carry them to a sibling or replacement.
  useEffect(() => {
    setScanWarning(undefined);
    setSignedFile(undefined);
    setConfirmResend(false);
    setDraftNote("");
    setNoteDraft(undefined);
    setReplaceReason("");
  }, [selected?.id]);

  // The delivery contact belongs to the customer, not the report version. Populate it whenever
  // the selected version changes so staff do not have to retype an address the server would only
  // accept if it exactly matched. An empty value deliberately leaves the field editable: the
  // first requested delivery registers it on the customer before sending.
  useEffect(() => {
    setRecipients(recipientContactQuery.data?.email ?? "");
  }, [selectedListItem?.id, recipientContactQuery.data?.email]);

  // Điều hướng tới màn này bằng mã khác khi màn đang mở (ví dụ mở hai hồ sơ liên tiếp) cũng phải
  // đổi hồ sơ đang xem, không chỉ lần gắn đầu tiên.
  useEffect(() => {
    if (!deepLinkedCode) return;
    setRequestCodeInput(deepLinkedCode);
    setSelectedId(undefined);
    setSampleCode(deepLinkedSampleCode ?? "");
    setRequestCode(deepLinkedCode);
  }, [deepLinkedCode, deepLinkedSampleCode]);

  const build = useReportMutation((client, code: string) => reportApi.build(client, code));
  const saveNote = useReportMutation(
    (client, { reportId, note }: { reportId: string; note: string }) =>
      reportApi.updateNote(client, reportId, note),
  );
  const attachScan = useReportMutation(
    async (client, { reportId, file }: { reportId: string; file: File }) => {
      const attachment = await uploadFile(client, file, {
        grant: "report.signed-scan",
        fileName: file.name,
      });
      return reportApi.signedScan(client, reportId, { documentId: attachment.id });
    },
  );
  const release = useReportMutation(
    (client, { reportId, input }: { reportId: string; input: { recipients?: string[] } }) =>
      reportApi.release(client, reportId, input),
  );
  const send = useReportMutation(
    (client, { reportId, recipients: to }: { reportId: string; recipients: string[] }) =>
      Promise.all(to.map((recipient) => reportApi.sendDelivery(client, reportId, { recipient }))),
  );
  const sendDraft = useReportMutation(
    (
      client,
      { reportId, recipients: to, note }: { reportId: string; recipients: string[]; note?: string },
    ) =>
      Promise.all(
        to.map((recipient) => reportApi.sendDraftDelivery(client, reportId, { recipient, note })),
      ),
  );
  const replace = useReportMutation(
    (client, { reportId, reason }: { reportId: string; reason: string }) =>
      reportApi.replace(client, reportId, { reason }),
  );

  const mutationError = [
    build.error,
    saveNote.error,
    attachScan.error,
    release.error,
    send.error,
    sendDraft.error,
    replace.error,
  ].find(Boolean);
  const recipientList = recipientsFrom(recipients);
  // PENDING_SIGNATURE is the only status the server ever releases from (E-RPT-006 otherwise).
  // `hasSignedScan` is always present on both the list and `GET /reports/{id}` responses, so
  // release-readiness is knowable even after a fresh page load.
  const releaseEligible = selected?.status.code === "PENDING_SIGNATURE";
  const knownUnsigned = releaseEligible && selected?.hasSignedScan !== true;
  // Đã phát hành (hoặc đã bị thay thế sau khi phát hành) là trạng thái hoàn tất, không phải thiếu
  // điều kiện - dùng chung tập trạng thái với nút tải PDF phát hành.
  const alreadyReleased = Boolean(selected && everReleasedStatuses.has(selected.status.code));

  const persistNote = async (report: ReportVersion) => {
    if (report.id === selected?.id && noteDirty) {
      await saveNote.mutateAsync({ reportId: report.id, note: reportNote.trim() });
    }
  };
  // useMutation (thay vì async fn trần) để có `isPending`/`variables` sẵn cho nút hiện loading
  // đúng dòng đang bấm và tự chặn double-click khi PDF còn đang tải.
  const previewMutation = useMutation({
    mutationFn: async (report: ReportVersion) => {
      await persistNote(report);
      const kind = everReleasedStatuses.has(report.status.code) ? "RELEASED" : "DRAFT";
      openBlob(await getReportPreview(api, report.id, kind));
    },
  });
  const printMutation = useMutation({
    mutationFn: async (report: ReportVersion) => {
      await persistNote(report);
      openBlob(await getReportPreview(api, report.id, "PRINT"));
    },
  });
  const downloadPrintMutation = useMutation({
    mutationFn: async (report: ReportVersion) => {
      await persistNote(report);
      saveBlob(
        await getReportPreview(api, report.id, "PRINT"),
        `${report.reportCode}-v${report.version}.pdf`,
      );
    },
  });
  const downloadMutation = useMutation({
    mutationFn: async (report: ReportVersion) =>
      saveBlob(await getReportPdf(api, report.id), `${report.reportCode}-v${report.version}.pdf`),
  });
  const busy =
    supplementaryBusy ||
    [
      build,
      saveNote,
      attachScan,
      release,
      send,
      sendDraft,
      replace,
      previewMutation,
      printMutation,
      downloadPrintMutation,
      downloadMutation,
    ].some((mutation) => mutation.isPending);
  const previewingId = previewMutation.isPending ? previewMutation.variables?.id : undefined;
  const downloadingId = downloadMutation.isPending ? downloadMutation.variables?.id : undefined;
  const previewDownloadError =
    (printMutation.isError && apiErrorMessage(printMutation.error, "Không thể mở phiếu để ký.")) ||
    (downloadPrintMutation.isError &&
      apiErrorMessage(downloadPrintMutation.error, "Không thể tải phiếu để ký.")) ||
    (previewMutation.isError &&
      apiErrorMessage(previewMutation.error, "Không thể xem trước phiếu.")) ||
    (downloadMutation.isError &&
      apiErrorMessage(downloadMutation.error, "Không thể tải PDF phiếu."));

  const deliveries = deliveriesQuery.data ?? [];
  const releasedSends = deliveries.filter((item) => item.kind === "RELEASED_REPORT");
  const failedSends = deliveries.filter((item) => item.status.tone === "danger").length;
  const alreadySentTo = recipientList.filter((recipient) =>
    releasedSends.some((item) => item.recipient.toLowerCase() === recipient.toLowerCase()),
  );
  const needsResendConfirm = alreadySentTo.length > 0;

  return (
    <div className="dlp-stack" style={{ maxWidth: 1240 }} data-testid="connected-report-delivery">
      <PageHead
        crumbs={[{ label: "Nghiệp vụ" }, { label: "Trả kết quả" }]}
        title="Trả kết quả và thay thế phiếu"
        description="Phát hành là cổng một chiều: khoá nội dung, lưu PDF bất biến và mở tra cứu công khai."
      />

      {selected ? (
        <StatStrip
          items={[
            {
              label: "Phiên bản đang chọn",
              value: `v${selected.version}`,
              hint: selected.status.name,
              tone: selected.status.tone,
            },
            {
              label: "Số phiên bản trong chuỗi",
              value: reports.length,
              hint: "Mọi bản đều được giữ để truy vết",
              tone: "info",
            },
            {
              label: "Lượt gửi phiếu phát hành",
              value: releasedSends.length,
              hint: "Gửi lại không tạo bản phát hành mới",
              tone: releasedSends.length > 0 ? "success" : "info",
            },
            {
              label: "Lượt gửi lỗi",
              value: failedSends,
              hint: failedSends > 0 ? "Kiểm tra địa chỉ người nhận" : "Không có lượt trả về",
              tone: failedSends > 0 ? "danger" : "info",
            },
          ]}
        />
      ) : null}

      <form
        style={{
          ...card,
          display: "grid",
          gridTemplateColumns: "minmax(220px,1fr) auto",
          alignItems: "end",
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          setSelectedId(undefined);
          setSampleCode("");
          setRequestCode(requestCodeInput.trim());
        }}
      >
        <Field
          label={
            <FieldLabel label="Mã hồ sơ" tooltip="Danh sách phiên bản được lọc tại máy chủ." />
          }
        >
          <Input
            value={requestCodeInput}
            disabled={busy}
            onChange={(_, data) => setRequestCodeInput(data.value)}
          />
        </Field>
        <Button appearance="primary" type="submit" disabled={busy || !requestCodeInput.trim()}>
          Tải danh sách phiếu
        </Button>
      </form>

      {/* `isLoading` chứ không phải `isPending`: query chỉ bật khi đã có mã hồ sơ, mà query đang
          tắt thì `isPending` vẫn true vĩnh viễn - spinner sẽ quay mãi dù không có request nào. */}
      {reportsQuery.isLoading ? <Spinner label="Đang tải các phiên bản phiếu…" /> : null}
      {reportsQuery.isError ||
      requestQuery.isError ||
      recipientContactQuery.isError ||
      reportDetailQuery.isError ||
      mutationError ||
      previewDownloadError ? (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Không thể hoàn tất thao tác</MessageBarTitle>
            {previewDownloadError ||
              apiErrorMessage(
                mutationError ??
                  reportDetailQuery.error ??
                  recipientContactQuery.error ??
                  requestQuery.error ??
                  reportsQuery.error,
              )}
          </MessageBarBody>
        </MessageBar>
      ) : null}

      {requestCode ? (
        <section style={{ ...card, gap: 10 }} aria-label="Chọn mẫu trả kết quả">
          <Field label="Mẫu trong hồ sơ" required>
            <select
              value={viewingLegacy ? "__legacy_dossier__" : (pickedSampleCode ?? "")}
              disabled={busy || requestQuery.isLoading || reportsQuery.isLoading}
              onChange={(event) => {
                setSampleCode(event.target.value);
                setSelectedId(undefined);
              }}
              style={{ width: "100%", minHeight: 40 }}
            >
              {!pickedSampleCode ? <option value="">Chọn mẫu</option> : null}
              {hasLegacyReports ? (
                <option value="__legacy_dossier__">Phiếu hồ sơ cũ (trước duyệt từng mẫu)</option>
              ) : null}
              {samples
                .filter((sample) => sample.code)
                .map((sample) => (
                  <option key={sample.code} value={sample.code}>
                    {sample.code}
                    {sample.product ? ` · ${sample.product}` : ""}
                    {sample.status ? ` · ${sample.status.name}` : ""}
                  </option>
                ))}
            </select>
          </Field>
          {sampleCode && !pickedSample && !viewingLegacy && requestQuery.isSuccess ? (
            <MessageBar intent="warning">
              <MessageBarBody>
                Mã mẫu {sampleCode} không thuộc hồ sơ {requestCode}. Chọn đúng mẫu trước khi thao
                tác.
              </MessageBarBody>
            </MessageBar>
          ) : null}
          <span style={hintText}>
            Mỗi mẫu có chuỗi phiên bản riêng. Phê duyệt, in để ký, tải bản scan, phát hành và giao
            phiếu là các bước riêng.
          </span>
        </section>
      ) : null}
      <section style={{ ...card, gap: 12 }} aria-label="Chuỗi phiên bản phiếu">
        <div style={sectionTitle}>Chuỗi phiên bản · lưu giữ đầy đủ</div>
        {!requestCode ? (
          <MessageBar intent="info">
            <MessageBarBody>
              <MessageBarTitle>Chưa chọn hồ sơ.</MessageBarTitle>
              Nhập mã hồ sơ rồi bấm «Tải danh sách phiếu» để xem chuỗi phiên bản.
            </MessageBarBody>
          </MessageBar>
        ) : /* `isSuccess` chứ không phải "mảng rỗng": query lỗi (mã hồ sơ không tồn tại → 404)
              cũng cho `data` undefined, mà báo "hồ sơ chưa có phiếu" cho một mã không tồn tại thì
              vừa sai vừa mời người dùng bấm dựng phiếu cho mã đó. */
        reportsQuery.isSuccess && pickedSampleCode && reports.length === 0 ? (
          <MessageBar intent="info">
            <MessageBarBody>
              <MessageBarTitle>Mẫu {pickedSampleCode} chưa có phiếu.</MessageBarTitle>
              {!canBuild
                ? "Tài khoản hiện tại không có quyền dựng phiếu (report.build)."
                : "Dựng phiếu cho mẫu đã chọn; máy chủ kiểm tra phê duyệt hiện hành. Sau đó in để ký tay, tải bản scan và phát hành."}
            </MessageBarBody>
          </MessageBar>
        ) : reportsQuery.isError ? (
          /* `isError` tường minh, KHÔNG phải `else` bắt-tất. Nhánh cuối cũ nuốt luôn trường hợp
             tải xong-và-có-phiếu, nên cảnh báo "Không đọc được danh sách phiếu" hiện ngay bên
             trên chính danh sách phiếu vừa tải được, và không tắt kể cả sau khi phát hành. */
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Không đọc được danh sách phiếu.</MessageBarTitle>
              {` Kiểm tra lại mã hồ sơ «${requestCode}» rồi tải lại - chưa xác định được hồ sơ này có phiếu hay không.`}
            </MessageBarBody>
          </MessageBar>
        ) : null}
        {/* Chỉ dựng danh sách khi thật sự có phiên bản: `reports` giữ lại dữ liệu của lần tải
            trước trong lúc query đổi khoá hoặc nạp lại nền, nên nếu không chặn ở đây thì cảnh báo
            «Không đọc được danh sách phiếu» ở trên và các dòng phiếu thật hiện cùng lúc. */}
        <div style={{ display: "grid", gap: 8 }}>
          {(reportsQuery.isSuccess ? reports : []).map((report) => (
            <button
              key={report.id}
              type="button"
              disabled={busy}
              onClick={() => setSelectedId(report.id)}
              style={{
                border:
                  report.id === selected?.id
                    ? "2px solid var(--colorBrandStroke1)"
                    : "1px solid var(--border-subtle)",
                borderRadius: "var(--radius-control)",
                background: "var(--background-card)",
                padding: 12,
                textAlign: "left",
                cursor: "pointer",
                display: "grid",
                gridTemplateColumns: "minmax(150px,1fr) auto",
                gap: 12,
              }}
            >
              <span>
                <strong>
                  {report.reportCode} ·{" "}
                  {report.sampleCode ? `mẫu ${report.sampleCode}` : "phiếu hồ sơ cũ"} · phiên bản{" "}
                  {report.version}
                </strong>
                <span style={{ ...hintText, display: "block" }}>
                  {report.current ? "Phiên bản hiện hành" : "Phiên bản được giữ để truy vết"}
                </span>
              </span>
              <Badge appearance="tint" color={toneToColor(report.status.tone)}>
                {report.status.name}
              </Badge>
            </button>
          ))}
        </div>
        {!viewingLegacy ? (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
            <span style={hintText}>Dựng phiếu cho mẫu {pickedSampleCode ?? "chưa chọn"}.</span>
            <Button
              appearance="primary"
              disabled={!canBuild || busy || !pickedSampleCode || !reportsQuery.isSuccess}
              title="Máy chủ kiểm tra mẫu đã được phê duyệt trước khi dựng phiếu."
              onClick={() =>
                pickedSampleCode &&
                build.mutate(pickedSampleCode, {
                  onSuccess: (report) => {
                    setSelectedId(report.id);
                    toast(
                      "Đã dựng phiếu",
                      `${report.reportCode} đang ${report.status.name}.`,
                      "success",
                    );
                  },
                })
              }
            >
              Dựng phiên bản phiếu
            </Button>
          </div>
        ) : null}
      </section>

      {selected ? (
        <>
          <section style={{ ...card, gap: 12 }} aria-label="Thông tin phiên bản đang chọn">
            <div style={sectionTitle}>Phiên bản đang chọn</div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))",
                gap: 10,
              }}
            >
              <div>
                <span style={hintText}>Mã / phiên bản</span>
                <div>
                  {selected.reportCode} · v{selected.version}
                </div>
              </div>
              <div>
                <span style={hintText}>Trạng thái máy chủ</span>
                <div>{selected.status.name}</div>
              </div>
              {selected.templateVersion ? (
                <div>
                  <span style={hintText}>Template ghim khi dựng</span>
                  <div>{selected.templateVersion}</div>
                </div>
              ) : null}
              {selected.legalProfileVersion ? (
                <div>
                  <span style={hintText}>Legal profile ghim khi dựng</span>
                  <div>{selected.legalProfileVersion}</div>
                </div>
              ) : null}
              {selected.checksum ? (
                <div style={{ minWidth: 0 }}>
                  <span style={hintText}>Checksum</span>
                  <div style={{ minWidth: 0 }}>
                    <ChecksumText value={selected.checksum} />
                  </div>
                </div>
              ) : null}
              <div>
                <span style={hintText}>Bản ký tay</span>
                <div>{selected.hasSignedScan ? "Đã đính kèm" : "Chưa đính kèm"}</div>
              </div>
              {/* Tên và chức danh đã ghim lúc dựng, không phải hồ sơ hiện tại của người đó - đây
                  là màn duy nhất đọc được phiếu in tên ai mà không phải mở PDF. */}
              {selected.printedApprover ? (
                <div>
                  <span style={hintText}>Người phê duyệt in trên phiếu</span>
                  <div>{selected.printedApprover.fullName}</div>
                  {selected.printedApprover.title ? (
                    <div style={hintText}>{selected.printedApprover.title}</div>
                  ) : null}
                </div>
              ) : null}
              {/* Người được ghi là đã ký bản scan; chỉ nói ra khi khác người in trên phiếu, vì
                  trùng nhau là trường hợp thường và không có gì để đối chiếu. */}
              {selected.signedBy && selected.signedBy.id !== selected.printedApprover?.id ? (
                <div>
                  <span style={hintText}>Người ký bản scan</span>
                  <div>{selected.signedBy.fullName}</div>
                </div>
              ) : null}
            </div>
            {selected.supersedeReason ? (
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Lý do thay thế nội bộ</MessageBarTitle>
                  {selected.supersedeReason}
                </MessageBarBody>
              </MessageBar>
            ) : null}
            <Field
              label={
                <FieldLabel
                  label="Ghi chú trên phiếu kết quả"
                  tooltip="In vào mục Nhận xét khác / Comments. Ghi chú được lưu trước khi in hoặc tải phiếu để ký; không sửa sau khi gắn bản scan đã ký."
                />
              }
            >
              <Textarea
                rows={3}
                value={reportNote}
                readOnly={!noteEditable}
                disabled={busy}
                onChange={(_, data) => setNoteDraft({ reportId: selected.id, value: data.value })}
              />
            </Field>
            {noteEditable ? (
              <div>
                <Button
                  disabled={busy || !noteDirty}
                  icon={saveNote.isPending ? <Spinner size="tiny" /> : undefined}
                  onClick={() =>
                    saveNote.mutate(
                      { reportId: selected.id, note: reportNote.trim() },
                      { onSuccess: () => toast("Đã lưu ghi chú trên phiếu", "", "success") },
                    )
                  }
                >
                  Lưu ghi chú
                </Button>
              </div>
            ) : (
              <span style={hintText}>
                {selected.hasSignedScan || alreadyReleased
                  ? "Ghi chú đã khoá theo bản scan đã ký."
                  : "Cần quyền dựng phiếu và phiên bản Chờ ký để sửa ghi chú."}
              </span>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {selected.status.code === "PENDING_SIGNATURE" ? (
                <>
                  <Button
                    appearance="primary"
                    disabled={busy}
                    icon={printMutation.isPending ? <Spinner size="tiny" /> : undefined}
                    onClick={() => printMutation.mutate(selected)}
                  >
                    In phiếu để ký
                  </Button>
                  <Button
                    disabled={busy}
                    icon={downloadPrintMutation.isPending ? <Spinner size="tiny" /> : undefined}
                    onClick={() => downloadPrintMutation.mutate(selected)}
                  >
                    Tải phiếu để ký
                  </Button>
                </>
              ) : null}
              <Button
                disabled={busy}
                icon={previewingId === selected.id ? <Spinner size="tiny" /> : undefined}
                onClick={() => previewMutation.mutate(selected)}
              >
                {previewingId === selected.id ? "Đang mở…" : "Xem trước PDF"}
              </Button>
              <Button
                disabled={!everReleasedStatuses.has(selected.status.code) || busy}
                icon={downloadingId === selected.id ? <Spinner size="tiny" /> : undefined}
                onClick={() => downloadMutation.mutate(selected)}
              >
                {downloadingId === selected.id ? "Đang tải…" : "Tải PDF phát hành"}
              </Button>
              {selected.publicUrl ? (
                <Button as="a" href={selected.publicUrl} target="_blank">
                  Mở tra cứu công khai
                </Button>
              ) : null}
            </div>
            <span style={hintText}>{LOOKUP_NOTE}</span>
          </section>

          <section style={{ ...card, gap: 12 }} aria-label="Tải bản ký tay và phát hành">
            <div style={sectionTitle}>Bản ký tay và phát hành</div>
            {/* Bản đã phát hành không phải là lỗi: nói đúng trạng thái thay vì báo "chưa đủ điều
                kiện" cho một phiên bản đã đi qua cổng phát hành. */}
            <MessageBar
              intent={
                alreadyReleased ? "info" : !releaseEligible || knownUnsigned ? "warning" : "success"
              }
            >
              <MessageBarBody>
                <MessageBarTitle>
                  {alreadyReleased
                    ? "Phiên bản này đã phát hành."
                    : !releaseEligible
                      ? "Chưa đủ điều kiện phát hành"
                      : knownUnsigned
                        ? "Còn thiếu bản ký tay"
                        : "Có thể phát hành"}
                </MessageBarTitle>
                {alreadyReleased
                  ? "Không cần thao tác thêm - dùng «Thay thế» nếu cần phát hành bản mới."
                  : !releaseEligible
                    ? "Chỉ phiên bản ở trạng thái Chờ ký mới phát hành được."
                    : knownUnsigned
                      ? "Cần tải bản scan đã ký tay lên đúng phiên bản này trước."
                      : "Máy chủ xác nhận đã có bản ký. Thao tác tiếp theo sẽ khoá nội dung và mở tra cứu công khai."}
              </MessageBarBody>
            </MessageBar>
            {scanWarning ? (
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Người ký bản scan khác người in trên phiếu</MessageBarTitle>
                  {scanWarning.message} Bản scan đã được gắn và nhật ký ghi cả hai người; kiểm tra
                  lại bản giấy trước khi phát hành.
                </MessageBarBody>
              </MessageBar>
            ) : null}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit,minmax(210px,1fr))",
                gap: 10,
              }}
            >
              <Field label="Bản scan đã ký (PDF hoặc ảnh)">
                <FileDropField
                  accept="application/pdf,image/*"
                  idle="Chọn bản phiếu đã ký tay (PDF hoặc ảnh)"
                  pending={attachScan.isPending}
                  pendingLabel="Đang gắn bản scan…"
                  selected={signedFile ? `Đã chọn ${signedFile.name} · bấm để đổi tệp` : undefined}
                  onFile={(file) => setSignedFile(file)}
                />
              </Field>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Button
                disabled={
                  !canSign ||
                  busy ||
                  noteDirty ||
                  !signedFile ||
                  selected.status.code !== "PENDING_SIGNATURE"
                }
                title={
                  !canSign
                    ? "Thiếu quyền report.sign — vai một cửa cần được cấp quyền tải bản ký tay."
                    : undefined
                }
                onClick={() =>
                  signedFile &&
                  attachScan.mutate(
                    { reportId: selected.id, file: signedFile },
                    {
                      // Máy chủ trả 200 kèm `signerMismatchWarning` khi người được ghi là đã ký
                      // không phải người được in trên phiếu. Bản scan vẫn được gắn và audit ghi cả
                      // hai người - đây là thông tin, không phải từ chối, nên nói đúng như vậy.
                      onSuccess: (report) => {
                        setScanWarning(report.signerMismatchWarning);
                        if (report.signerMismatchWarning) {
                          toast(
                            "Đã gắn bản ký tay - lệch người ký",
                            report.signerMismatchWarning.message,
                            "warning",
                          );
                          return;
                        }
                        toast(
                          "Đã gắn bản ký tay",
                          "Bản scan đã gắn đúng phiên bản phiếu.",
                          "success",
                        );
                      },
                    },
                  )
                }
              >
                Tải bản scan đã ký tay
              </Button>
              <Button
                appearance="primary"
                disabled={!canRelease || busy || noteDirty || !releaseEligible || knownUnsigned}
                icon={release.isPending ? <Spinner size="tiny" /> : undefined}
                title={
                  !canRelease
                    ? "Thiếu quyền report.release — vai một cửa cần được cấp quyền phát hành."
                    : knownUnsigned
                      ? "Cần tải bản scan đã ký tay lên đúng phiên bản này trước."
                      : !releaseEligible
                        ? "Chỉ phiên bản ở trạng thái Chờ ký mới phát hành được."
                        : undefined
                }
                onClick={() => {
                  if (
                    !window.confirm(
                      "Phát hành sẽ khoá nội dung, lưu PDF bất biến và mở tra cứu công khai. Tiếp tục?",
                    )
                  )
                    return;
                  // Release and external delivery are distinct actions; no implicit email send.
                  const input = {};
                  release.mutate(
                    { reportId: selected.id, input },
                    {
                      onSuccess: (report) => {
                        toast(
                          "Đã phát hành phiếu",
                          "Bước tiếp theo: gửi PDF đã phát hành tới email nhận kết quả đã đăng ký.",
                          "success",
                        );
                      },
                    },
                  );
                }}
              >
                {release.isPending ? "Đang phát hành…" : "Xác nhận phát hành"}
              </Button>
            </div>
          </section>

          <ReportSupplementaryDocuments
            reportId={selected.id}
            version={selected.version}
            status={selected.status.code}
            canAddSupplementaryDocument={canAddSupplementaryDocument}
            disabled={busy}
          />

          <section style={{ ...card, gap: 12 }} aria-label="Giao phiếu">
            <div style={sectionTitle}>Giao phiếu qua email</div>
            <Field
              label={
                <FieldLabel
                  label="Email nhận kết quả"
                  tooltip="Email đã đăng ký được điền tự động. Nếu khách chưa có email, nhập địa chỉ một lần; hệ thống sẽ lưu vào hồ sơ khách rồi gửi phiếu."
                />
              }
            >
              <Input
                type="email"
                readOnly={Boolean(recipientContactQuery.data?.email)}
                disabled={busy || !recipientContactQuery.isSuccess}
                value={recipients}
                onChange={(_, data) => setRecipients(data.value)}
                placeholder={
                  recipientContactQuery.isLoading
                    ? "Đang tải email khách hàng…"
                    : "Nhập email khách hàng"
                }
              />
            </Field>
            <Field
              label={
                <FieldLabel
                  label="Lời nhắn email bản nháp (tuỳ chọn)"
                  tooltip="Chỉ đi cùng lượt gửi email đối soát, không in lên phiếu. Nội dung in trên phiếu nhập ở ô Ghi chú trên phiếu kết quả."
                />
              }
            >
              <Textarea
                rows={2}
                value={draftNote}
                onChange={(_, data) => setDraftNote(data.value)}
              />
            </Field>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Button
                disabled={
                  !canDeliver ||
                  busy ||
                  noteDirty ||
                  !recipientContactQuery.isSuccess ||
                  recipientList.length === 0 ||
                  !["DRAFT", "PENDING_SIGNATURE"].includes(selected.status.code)
                }
                onClick={() => {
                  if (
                    !window.confirm(
                      "Gửi bản nháp đối soát? Bản này có watermark, không QR, không khoá nội dung và không mở tra cứu.",
                    )
                  )
                    return;
                  sendDraft.mutate(
                    {
                      reportId: selected.id,
                      recipients: recipientList,
                      note: draftNote.trim() || undefined,
                    },
                    {
                      onSuccess: () => {
                        setDraftNote("");
                        toast(
                          "Đã gửi bản nháp",
                          "Lượt gửi được ghi audit; trạng thái phiếu không thay đổi.",
                          "info",
                        );
                      },
                    },
                  );
                }}
              >
                Gửi bản nháp đối soát
              </Button>
              <Button
                appearance={needsResendConfirm ? "secondary" : "primary"}
                disabled={
                  !canDeliver ||
                  busy ||
                  !recipientContactQuery.isSuccess ||
                  recipientList.length === 0 ||
                  selected.status.code !== "RELEASED" ||
                  (needsResendConfirm && !confirmResend)
                }
                onClick={() => {
                  if (
                    !window.confirm(
                      "Gửi PDF đã phát hành ra ngoài cho các địa chỉ đã xác nhận? Thao tác gửi không thể hoàn tác.",
                    )
                  )
                    return;
                  send.mutate(
                    { reportId: selected.id, recipients: recipientList },
                    {
                      onSuccess: () => {
                        setConfirmResend(false);
                        toast(
                          "Đã xếp hàng gửi phiếu",
                          "Trạng thái Đã gửi và Đã giao được theo dõi riêng qua webhook.",
                          "success",
                        );
                      },
                    },
                  );
                }}
              >
                {needsResendConfirm ? "Gửi lại PDF đã phát hành" : "Gửi PDF đã phát hành"}
              </Button>
              {needsResendConfirm ? (
                <Checkbox
                  checked={confirmResend}
                  onChange={(_, data) => setConfirmResend(!!data.checked)}
                  label="Xác nhận gửi lại"
                />
              ) : null}
            </div>
            {needsResendConfirm ? (
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Đã gửi cho địa chỉ này:</MessageBarTitle>
                  {` ${alreadySentTo.join(", ")} đã nhận phiếu phát hành. Gửi lại chỉ dùng khi khách báo chưa nhận - hệ thống ghi nhận là lần gửi lại, không tạo bản phát hành mới.`}
                </MessageBarBody>
              </MessageBar>
            ) : null}
          </section>

          <section style={{ ...card, gap: 12 }} aria-label="Nhật ký giao phiếu">
            <div style={sectionTitle}>Nhật ký giao · trạng thái bất đồng bộ</div>
            {deliveriesQuery.isPending ? <Spinner label="Đang tải nhật ký gửi…" /> : null}
            {deliveriesQuery.isError ? (
              <MessageBar intent="error">
                <MessageBarBody>{apiErrorMessage(deliveriesQuery.error)}</MessageBarBody>
              </MessageBar>
            ) : null}
            {(deliveriesQuery.data ?? []).map((delivery, index) => (
              <div
                key={delivery.id ?? `${delivery.recipient}-${delivery.createdAt}-${index}`}
                style={{
                  display: "grid",
                  gap: 6,
                  borderTop: "1px solid var(--border-subtle)",
                  paddingTop: 10,
                }}
              >
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(180px,1fr) auto auto",
                    gap: 12,
                  }}
                >
                  <div>
                    <strong>{delivery.recipient}</strong>
                    <div style={hintText}>
                      {delivery.kind === "DRAFT_REVIEW"
                        ? "Bản nháp đối soát"
                        : "Phiếu đã phát hành"}
                      {delivery.version !== undefined ? ` · phiên bản ${delivery.version}` : ""}
                    </div>
                  </div>
                  <Badge appearance="tint" color={toneToColor(delivery.status.tone)}>
                    {delivery.status.name}
                  </Badge>
                  <div style={{ ...hintText, textAlign: "right" }}>
                    {formatTime(delivery.sentAt ?? delivery.createdAt)}
                    <br />
                    Thử lại: {delivery.retryCount}
                    {delivery.failureReason ? ` · ${delivery.failureReason}` : ""}
                  </div>
                </div>
                {delivery.checksum || delivery.actorId || delivery.providerMessageId ? (
                  <div
                    style={{ ...hintText, display: "flex", gap: 16, flexWrap: "wrap", minWidth: 0 }}
                  >
                    {delivery.checksum ? (
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          minWidth: 0,
                        }}
                      >
                        Checksum: <ChecksumText value={delivery.checksum} maxWidth={200} />
                      </span>
                    ) : null}
                    {delivery.actorId ? <span>Người gửi: {delivery.actorId}</span> : null}
                    {delivery.providerMessageId ? (
                      <span>Mã theo dõi nhà cung cấp: {delivery.providerMessageId}</span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))}
            {!deliveriesQuery.isPending && (deliveriesQuery.data?.length ?? 0) === 0 ? (
              <span style={hintText}>Chưa có lượt gửi nào cho phiên bản này.</span>
            ) : null}
          </section>

          <section style={{ ...card, gap: 10 }} aria-label="Thay thế phiếu">
            <div style={sectionTitle}>Thay thế · không sửa tại chỗ</div>
            <Field label="Lý do thay thế - bắt buộc">
              <Textarea
                rows={2}
                value={replaceReason}
                onChange={(_, data) => setReplaceReason(data.value)}
              />
            </Field>
            <Button
              disabled={
                !canReplace || busy || selected.status.code !== "RELEASED" || !replaceReason.trim()
              }
              onClick={() => {
                if (
                  !window.confirm(
                    "Tạo phiên bản thay thế mới? Bản đang phát hành vẫn được giữ và còn hiệu lực tới khi bản mới phát hành.",
                  )
                )
                  return;
                replace.mutate(
                  { reportId: selected.id, reason: replaceReason.trim() },
                  {
                    onSuccess: (report) => {
                      setSelectedId(report.id);
                      setReplaceReason("");
                      toast(
                        "Đã tạo phiên bản thay thế",
                        `${report.reportCode} v${report.version} đang ${report.status.name}.`,
                        "warning",
                      );
                    },
                  },
                );
              }}
            >
              Tạo phiên bản thay thế
            </Button>
          </section>
        </>
      ) : null}
    </div>
  );
}

function DemoDeliveryScreen() {
  const { can } = useAuth();
  const toast = useDlpToast();
  const [mailTo, setMailTo] = useState(DELIVERY_CERT.defaultMail);
  const [sentLog, setSentLog] = useState<Record<string, number>>({});
  const [sent, setSent] = useState(false);
  const [sentKind, setSentKind] = useState<CertStatus>("valid");
  const [confirmResend, setConfirmResend] = useState(false);
  const [bounced, setBounced] = useState(false);
  const [printed, setPrinted] = useState(false);
  const [status, setStatus] = useState<CertStatus>("valid");
  const [reason, setReason] = useState("");
  const [draftSent, setDraftSent] = useState(false);
  const canWrite = can(PERM.REPORT_DELIVER);
  const sentTimes = sentLog[mailTo] ?? 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 1200, minWidth: 0 }}>
      <PageHead
        crumbs={[{ label: `Hồ sơ ${DELIVERY_CERT.record}` }, { label: "Trả kết quả" }]}
        title={`Trả kết quả - ${DELIVERY_CERT.no}`}
      />
      <StatStrip items={deliveryStats(status, sentTimes, printed)} />
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <DeliveryMailCard
          status={status}
          mailTo={mailTo}
          bounced={bounced}
          sentTimes={sentTimes}
          sent={sent}
          sentKind={sentKind}
          confirmResend={confirmResend}
          canWrite={canWrite}
          onMailTo={(value) => {
            setMailTo(value);
            setBounced(false);
            setConfirmResend(false);
            setSent(false);
          }}
          onConfirmResend={setConfirmResend}
          onSend={() => {
            if (!window.confirm("Gửi PDF đã phát hành ra ngoài cho địa chỉ này?")) return;
            setSentLog((current) => ({ ...current, [mailTo]: (current[mailTo] ?? 0) + 1 }));
            setSent(true);
            setSentKind(status);
            setBounced(false);
            setConfirmResend(false);
            toast(
              "Đã gửi email cho khách",
              `Gửi tới ${mailTo} kèm ${attachmentName(status)}.`,
              "success",
            );
          }}
          onPrint={() => {
            setPrinted(true);
            toast(
              `Đã gửi lệnh in ${DELIVERY_CERT.no}`,
              "Ghi nhận trả tại PTN khi khách ký nhận.",
              "info",
            );
          }}
          onPreview={() =>
            toast("Mở xem trước phiếu", `${attachmentName(status)} - bản đã ký, chỉ đọc.`, "info")
          }
          onDownload={() =>
            toast(`Đang chuẩn bị ${attachmentName(status)}`, "Tệp đang được chuẩn bị.", "info")
          }
        />
        <DeliverySidePane
          status={status}
          reason={reason}
          draftSent={draftSent}
          canWrite={canWrite}
          onReason={setReason}
          onDraft={() => {
            if (!window.confirm("Gửi bản nháp có watermark, không QR và không mở tra cứu?")) return;
            setDraftSent(true);
            toast(
              "Đã gửi bản nháp",
              "Không tạo phiên bản phát hành và không đổi trạng thái.",
              "info",
            );
          }}
          onViewDraft={() => toast("Mở bản nháp", "Watermark «BẢN NHÁP – CHƯA PHÁT HÀNH».", "info")}
          onDownloadPrint={() =>
            toast("Đang chuẩn bị phiếu để ký", "Bản dùng ký không có watermark BẢN NHÁP.", "info")
          }
          onReplace={() => {
            if (!window.confirm("Tạo phiên bản thay thế mới và giữ nguyên PDF cũ để truy vết?"))
              return;
            setStatus("replaced");
            setReason("");
            setSent(false);
            toast(
              "Đã tạo phiên bản thay thế",
              "Bản cũ chỉ đổi trạng thái sau khi bản mới được phát hành.",
              "warning",
            );
          }}
        />
      </div>
    </div>
  );
}
