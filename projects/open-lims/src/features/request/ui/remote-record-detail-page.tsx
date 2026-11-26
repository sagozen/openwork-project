import { parseVndInput } from "@/lib/format";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Badge,
  Button,
  Field,
  Input,
  Spinner,
  Tab,
  TabList,
  Textarea,
} from "@fluentui/react-components";
import {
  EmptyState,
  FileDropField,
  PageHead,
  VndAmountInput,
  useDlpToast,
} from "@/components/lims/common";
import { AuditEventList } from "@/components/lims/audit/AuditEventList";
import { flattenAuditPages, useRequestAuditEvents } from "@/features/audit";
import { AssignSamplingDrawer } from "@/components/lims/sampling/AssignSamplingDrawer";
import { RequestSamplingPanel } from "@/components/lims/sampling/RequestSamplingPanel";
import { RequestSamplesPanel } from "@/components/lims/lab/RequestSamplesPanel";
import { customerLedgerKeys, debtKeys } from "@/features/customer";
import { useAssignment } from "@/features/sampling";
import { useAnalysisTasks } from "@/features/lab";
import { useReceptionDetail, useSampleDetail } from "@/features/reception/hooks";
import {
  everReleasedStatuses,
  getReportPdf,
  getReportPreview,
  openBlob,
  saveBlob,
  useReportApi,
  useReports,
  type ReportVersion,
} from "@/features/report";
import { apiErrorMessage, uploadFile, useApiClient } from "@/lib/api";
import { isPaymentSettled } from "@/lib/payment-status";
import { useAuth } from "@/lib/auth/AuthProvider";
import { PERM } from "@/lib/admin/rbac";
import { toneToColor } from "@/lib/admin/tone";
import { HandoverCard, type ScanMethod } from "@/components/lims/intake/HandoverCard";
import { HandoverLog } from "@/components/lims/intake/HandoverLog";
import {
  handoverKeys,
  requestKeys,
  useHandoverApi,
  useHandoverLog,
  useRequestApi,
  useRequestDetail,
} from "../hooks";
import type { TestRequestDetail } from "../types";
import { formatDate } from "./format";
import { PaymentRecordPanel } from "./payment-record-panel";
import { DELIVERY_MODES, RequestError } from "./request-ui";

/** Tóm tắt mẫu cho phần mô tả đầu trang - cùng quy ước "tên mẫu đầu +n" với cột Sản phẩm ở S-01
 *  (CR-20260831-001), nhưng ở đây có sẵn `samples[]` đầy đủ nên không cần chờ mở tab để biết. */
function sampleCountLabel(samples: TestRequestDetail["samples"]): string {
  if (samples.length === 0) return "Chưa có mẫu";
  const first = samples[0]?.product ?? "(chưa đặt tên)";
  const extra = samples.length - 1;
  return extra > 0 ? `${first} +${extra}` : first;
}

/** Bằng chứng cần nộp phụ thuộc việc đang làm. Ô này dùng chung cho ba việc khác nhau (xác nhận
 *  thanh toán, xin ngoại lệ thanh toán, huỷ hồ sơ) nên câu mời phải theo `grant` - trước đây nó
 *  mời người đang huỷ hồ sơ nộp "chứng từ thanh toán". */
const UPLOAD_PROMPT: Record<string, string> = {
  "payment.evidence": "Tải chứng từ thanh toán (JPEG · PNG · PDF)",
  "payment.exception": "Tải văn bản duyệt ngoại lệ thanh toán (JPEG · PNG · PDF)",
  "request.cancel": "Tải bằng chứng huỷ hồ sơ (JPEG · PNG · PDF)",
};

function FileUpload({ grant, onUploaded }: { grant: string; onUploaded: (id: string) => void }) {
  const api = useApiClient();
  /* Tên tệp đã tải lên, chỉ để hiển thị. Thiếu nó thì khung vẫn mời "Tải chứng từ…" sau khi người
     dùng đã chọn tệp - không có cách nào biết đã đính kèm hay chưa cho tới lúc bấm nút xác nhận. */
  const [fileName, setFileName] = useState<string>();
  const mutation = useMutation({
    mutationFn: (file: File) => {
      setFileName(file.name);
      return uploadFile(api, file, { grant });
    },
    onSuccess: (r) => onUploaded(r.id),
    onError: () => setFileName(undefined),
  });
  return (
    <Field label="Tài liệu bằng chứng">
      <FileDropField
        accept=".pdf,image/jpeg,image/png"
        pending={mutation.isPending}
        idle={UPLOAD_PROMPT[grant] ?? "Tải tài liệu bằng chứng (JPEG · PNG · PDF)"}
        selected={
          mutation.isSuccess && fileName
            ? `Đã đính kèm ${fileName} · bấm để thay tệp khác`
            : undefined
        }
        onFile={(file) => mutation.mutate(file)}
      />
      <RequestError error={mutation.error} />
    </Field>
  );
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="dlp-card" style={{ padding: 16, display: "grid", gap: 10 }}>
      <h2 style={{ margin: 0 }}>{title}</h2>
      {children}
    </section>
  );
}
export function RemoteRecordDetailPage({ code, canWrite }: { code: string; canWrite: boolean }) {
  const query = useRequestDetail(code);
  const record = query.data;
  const api = useRequestApi();
  const { can } = useAuth();
  const toast = useDlpToast();
  const [assignOpen, setAssignOpen] = useState(false);
  const handoverApi = useHandoverApi();
  const handoverLog = useHandoverLog(code);
  const cache = useQueryClient();
  const navigate = useNavigate();
  const [tab, setTab] = useState("overview");
  // TabList ẩn tab Huỷ & bàn giao khi đã phát hành (`showActionsTab` dưới). Nếu tab đang mở vừa
  // bị ẩn (vd vừa phát hành trong lúc đang mở tab đó) thì đưa về Tổng quan để không kẹt trên 1
  // tab không còn hiện trong TabList. Tab Thanh toán KHÔNG nằm trong diện này - nó luôn hiện,
  // xem lý do ở chỗ dựng TabList.
  useEffect(() => {
    if (!record) return;
    if (tab === "actions" && record.status.code === "RELEASED") setTab("overview");
  }, [tab, record]);
  // Cùng nguồn dữ liệu với màn Trả kết quả (`GET /test-requests/{code}/reports`) - trước đây tab
  // này là khối rỗng cố định nên luôn báo "chưa phát hành phiếu" kể cả khi hồ sơ đã có phiếu.
  const reportsQuery = useReports(code, tab === "certs");
  // Chỉ tải khi người dùng thực sự mở tab: nhật ký của một hồ sơ dài hơn phần còn lại của màn
  // chi tiết, và phần lớn lượt xem không mở tới nó.
  const historyQuery = useRequestAuditEvents(code, tab === "history");
  /**
   * Tab «Lấy mẫu» và «Mẫu & kết quả» đều bắt đầu từ đây. `GET /test-requests/{code}/reception` là
   * chỗ DUY NHẤT đi từ mã hồ sơ sang mã lượt lấy mẫu và mã mẫu cha: hồ sơ chi tiết không mang hai
   * mã đó, `GET /sampling-assignments` chỉ lọc theo ngày và trạng thái, `GET /analysis-tasks` chỉ
   * lọc theo `parentSampleCode`. Trước đây không có đường nào nên hai tab là ô rỗng cố định.
   *
   * Một lượt gọi phụ mỗi tab, chỉ khi người dùng thực sự mở tab đó.
   */
  const samplingTab = tab === "sampling";
  const resultsTab = tab === "results";
  const handoverTab = tab === "actions";
  const codesQuery = useReceptionDetail(code, samplingTab || resultsTab || handoverTab);
  const assignmentCode = codesQuery.data?.assignmentCode;
  const [selectedSampleCode, setSelectedSampleCode] = useState("");
  const sampleCode =
    record?.samples.find((s) => s.code === selectedSampleCode)?.code ??
    record?.samples[0]?.code ??
    codesQuery.data?.sampleCode;
  // `useAssignment` bật/tắt theo chính mã của nó, nên chỉ truyền mã khi tab đang mở - tab đóng thì
  // không có mã, không có lượt gọi.
  const assignmentQuery = useAssignment(samplingTab ? assignmentCode : undefined);
  const sampleQuery = useSampleDetail(sampleCode, resultsTab && Boolean(sampleCode));
  const tasksQuery = useAnalysisTasks({ sampleCode, size: 200 }, resultsTab && Boolean(sampleCode));
  const reportApiClient = useReportApi();
  const [reason, setReason] = useState("");
  const [evidenceIds, setEvidenceIds] = useState<string[]>([]);
  const [paymentEvidence, setPaymentEvidence] = useState<string>();
  const [amount, setAmount] = useState("");
  const paymentAmount = parseVndInput(amount);
  const validPaymentAmount =
    Number.isFinite(paymentAmount) && paymentAmount > 0 && paymentAmount <= Number.MAX_SAFE_INTEGER;
  const [exceptionAmount, setExceptionAmount] = useState("");
  const [note, setNote] = useState("");
  // Cùng bộ trường và cùng luật với hai màn kia (`HandoverMetaFields`/`handoverMetaIncomplete`).
  // Bản trước tab này chỉ hỏi «Mã người nhận (nếu có)» - một cửa thứ ba ghi vào cùng bảng
  // `ops.handover` nhưng theo luật riêng, nên cùng một lượt bàn giao lại có hoặc không có người
  // nhận tuỳ chỗ bấm.
  const [counterpart, setCounterpart] = useState("");
  const [handoverScanMethod, setHandoverScanMethod] = useState<ScanMethod>("QR");
  const [handoverNote, setHandoverNote] = useState("");
  const [handoverSuccess, setHandoverSuccess] = useState("");
  const [repeatAcknowledged, setRepeatAcknowledged] = useState(false);
  const refresh = () => cache.invalidateQueries({ queryKey: requestKeys.detail(code) });
  const cancel = useMutation({
    mutationFn: () => api.cancel(code, { reason, evidenceDocumentIds: evidenceIds }),
    onSuccess: refresh,
  });
  const payment = useMutation({
    mutationFn: () => {
      if (!validPaymentAmount) throw new Error("Vui lòng nhập số tiền dương hợp lệ.");
      return api.confirmPayment(code, {
        status: "PAID",
        amount: paymentAmount,
        ...(note ? { note } : {}),
        ...(paymentEvidence ? { evidenceDocumentId: paymentEvidence } : {}),
      });
    },
    onSuccess: refresh,
  });
  const exception = useMutation({
    mutationFn: () =>
      api.grantPaymentException(code, {
        reason,
        amount: Number(exceptionAmount),
        evidenceDocumentIds: evidenceIds,
      }),
    onSuccess: () => {
      refresh();
      cache.invalidateQueries({ queryKey: customerLedgerKeys.lists() });
      cache.invalidateQueries({ queryKey: [...debtKeys.all, "summary"] });
    },
  });
  /* Bước nào của lượt bàn giao là bước CỦA NGƯỜI ĐANG XEM, không phải mặc định "lab nhận".
     Backend chỉ nhận RECEIVE từ người có `reception.handover.lab` và DELIVER từ người có
     `reception.handover.deliver` (`CreateHandoverService#requireDoor`), nên thẻ này phải hỏi
     đúng câu người đó trả lời được. Để cứng RECEIVE là mời chính người vừa giao mẫu tự ký nhận
     thay lab: backend chặn 403, còn màn hình thì đã hứa một việc không làm được, và nguyên tắc
     "hệ thống ghi người giao - người nhận" in ngay dưới nút trở thành câu nói suông. */
  const canDeliverHandover = can(PERM.RECEPTION_HANDOVER_DELIVER);
  const canReceiveHandover = can(PERM.RECEPTION_HANDOVER_LAB);
  const handoverIsLab = canReceiveHandover && !canDeliverHandover;
  const handover = useMutation({
    mutationFn: () =>
      handoverApi.create({
        requestCode: code,
        step: handoverIsLab ? "RECEIVE" : "DELIVER",
        scannedCodes: [sampleCode ?? ""],
        scanMethod: handoverScanMethod,
        counterpartUserId: counterpart.trim(),
        ...(handoverNote.trim() ? { note: handoverNote.trim() } : {}),
      }),
    onSuccess: (result) => {
      setHandoverSuccess(`Máy chủ đã ghi nhận bàn giao ${result.handoverId}.`);
      setRepeatAcknowledged(false);
      toast(
        handoverIsLab ? "Đã ghi nhận lab nhận mẫu" : "Đã ghi nhận bàn giao mẫu",
        `${code} · mã bản ghi ${result.handoverId}`,
      );
      void cache.invalidateQueries({ queryKey: handoverKeys.all });
      refresh();
    },
  });
  // `handover.error` cố ý KHÔNG nằm ở đây: nó hiển thị ngay trong thẻ bàn giao, cạnh nút
  // vừa bấm, thay vì ở banner đầu trang cách đó cả màn cuộn.
  const actionError = cancel.error ?? payment.error ?? exception.error;
  // Xem trước / tải PDF ngay tại tab «Phiếu» - cùng đường gọi mà màn Trả kết quả dùng, chỉ khác là
  // người dùng không phải rời khỏi chi tiết hồ sơ. useMutation (thay vì async fn trần) để có
  // `isPending`/`variables` sẵn cho nút hiện loading đúng dòng đang bấm và tự chặn double-click.
  const previewReport = useMutation({
    mutationFn: async (report: ReportVersion) => {
      const kind = everReleasedStatuses.has(report.status.code) ? "RELEASED" : "DRAFT";
      openBlob(await getReportPreview(reportApiClient, report.id, kind));
    },
  });
  const downloadReport = useMutation({
    mutationFn: async (report: ReportVersion) =>
      saveBlob(
        await getReportPdf(reportApiClient, report.id),
        `${report.reportCode}-v${report.version}.pdf`,
      ),
  });
  const previewingId = previewReport.isPending ? previewReport.variables?.id : undefined;
  const downloadingId = downloadReport.isPending ? downloadReport.variables?.id : undefined;
  // Trường CẤP HỒ SƠ (CR-20260831-001) - bộ trường truy xuất BR-021 và chỉ tiêu đã chuyển xuống
  // TỪNG mẫu, hiển thị ở bảng mẫu riêng bên dưới thay vì trộn chung khối này.
  const fields = useMemo(
    () =>
      record
        ? [
            record.customer ? ["Khách hàng", record.customer.name] : null,
            record.representative ? ["Người đại diện", record.representative] : null,
            record.phone ? ["Điện thoại", record.phone] : null,
            record.samplingLocation ? ["Địa điểm lấy mẫu", record.samplingLocation] : null,
            [
              "Nhận kết quả",
              record.resultDeliveryModes
                .map((mode) => DELIVERY_MODES.find((m) => m.code === mode)?.name ?? mode)
                .join(", "),
            ],
            ["Chi nhánh tiếp nhận", record.receptionBranch.name],
            [
              "Biểu mẫu",
              `${record.formTemplate.code} · ${record.formTemplate.revision} · ${record.formTemplate.effectiveFrom}`,
            ],
            ["Người tạo", record.createdBy.fullName ?? record.createdBy.id],
            ["Tạo lúc", formatDate(record.createdAt)],
          ].filter((f): f is string[] => f !== null)
        : [],
    [record],
  );
  if (query.isPending) return <Spinner label="Đang tải hồ sơ…" />;
  if (!record) return <RequestError error={query.error} fallback="Không thể tải hồ sơ." />;
  const canCancel = canWrite && record.allowedActions.includes("request.cancel");
  const canPay = canWrite && record.allowedActions.includes("payment.confirm");
  // allowedActions.md vocabulary (FindTestRequestService#allowedActions) names this action
  // "payment.grantException", distinct from the PERM.PAYMENT_EXCEPTION permission code.
  const canException = canWrite && record.allowedActions.includes("payment.grantException");
  const canEdit = canWrite && record.allowedActions.includes("request.editGroupA");
  // Phân công lấy mẫu thuộc miền sampling nên KHÔNG nằm trong `allowedActions` của hồ sơ
  // (`FindTestRequestService#allowedActions` chỉ kể hành động của miền request). Điều kiện là
  // quyền `sampling.assign` cộng trạng thái hồ sơ đang chờ phân công - đúng điều kiện mà
  // `POST /test-requests/{code}/sampling-assignment` nhận.
  const canAssignSampling = can(PERM.SAMPLING_ASSIGN) && record.status.code === "AWAITING_SAMPLING";
  /**
   * Nút tắt sang màn nghiệp vụ, chỉ hiện ở trạng thái rỗng của hai tab. Dùng ĐÚNG bộ quyền mà
   * `/lay-mau` và `/nhap-ket-qua` tự kiểm, để nút và cửa không thể lệch nhau. FR-IAM-023: mục
   * ngoài quyền phải ẩn, không phải mời bấm rồi trả về một trang chặn quyền chiếm trọn màn (mất
   * cả nav lẫn đường quay lại hồ sơ).
   *
   * Đây CHỈ còn quyết định cái nút. Trước đây nó quyết định luôn cả tab: nội dung là ô rỗng cố
   * định nên vai không có `sampling.work` - tức nhân viên một cửa, chính người mà tab 3 được viết
   * cho (URD 8.1) - mở tab ra thấy ô rỗng và không cả nút để bấm. Giờ nội dung tab đọc từ máy chủ
   * và không phụ thuộc hai cờ này.
   */
  const canOpenSampling = can(PERM.SAMPLING_READ) && can(PERM.SAMPLING_WORK);
  const canOpenResults = can(PERM.LAB_READ);
  const paid = isPaymentSettled(record.payment);
  const overdue = record.payment.code === "OVERDUE";
  // Tab Thanh toán LUÔN hiện. Bản trước ẩn nó ngay khi hồ sơ đã thanh toán, với lý do form xác
  // nhận hết tác dụng - đúng về cái form, sai về cái tab: cùng lúc đó nó chôn luôn số tiền, ghi
  // chú UNC và file chứng từ vừa nộp, biến chứng từ tài chính thành dữ liệu chỉ-ghi (FR-PAY-003,
  // FR-DOC-014). Giờ tab đổi VAI theo trạng thái: chưa xong thì là chỗ xác nhận, xong rồi thì là
  // chỗ đọc lại. Đã phát hành thì vẫn ẩn tab Huỷ & bàn giao vì cả 2 thao tác đều không còn hợp lệ
  // ở giai đoạn này (`cancelReason`/`handoverReason` phía dưới cũng đã chặn nút).
  const showActionsTab = record.status.code !== "RELEASED";
  // RECEIVED là đã nhận đủ mẫu tại một cửa, chưa phải đã nhận vào lab.
  // PENDING_LAB vẫn cho mở luồng bàn giao từng mẫu đã nhận trong hồ sơ nhận một phần.
  const requestStatusOrder = [
    "DRAFT",
    "AWAITING_SAMPLING",
    "SAMPLING",
    "PENDING_LAB",
    "RECEIVED",
    "IN_TESTING",
    "AWAITING_APPROVAL",
    "RELEASED",
    "ON_HOLD",
    "REJECTED",
    "CANCELLED",
  ];
  const pastHandoverStage =
    requestStatusOrder.indexOf(record.status.code) > requestStatusOrder.indexOf("RECEIVED");
  const handoverReason =
    !canDeliverHandover && !canReceiveHandover
      ? "Bạn không có quyền ghi nhận bàn giao mẫu."
      : ["PENDING_LAB", "RECEIVED"].includes(record.status.code)
        ? overdue
          ? "Mẫu quá hạn thanh toán (E-PAY-004)."
          : !paid
            ? "Hồ sơ chưa thanh toán hoặc chưa có ngoại lệ (E-PAY-003)."
            : ""
        : pastHandoverStage
          ? "Hồ sơ đã qua giai đoạn bàn giao (đã vào lab hoặc đã kết thúc) - không cần thao tác này nữa."
          : "Hồ sơ chưa tiếp nhận mẫu tại một cửa, chưa đủ điều kiện bàn giao vào lab.";
  // Lý do hiển thị khi KHÔNG được huỷ - tránh để form Lý do/bằng chứng đứng mồ côi không nút bấm
  // (dead-end) như đã ghi nhận: trước đây field vẫn render dù `canCancel` false, không có cách nộp.
  const cancelReason = canCancel
    ? ""
    : record.status.code === "RELEASED"
      ? "Hồ sơ đã phát hành, không thể huỷ - dùng Thu hồi/Thay thế phiếu ở màn Trả kết quả."
      : record.status.code === "CANCELLED"
        ? "Hồ sơ đã bị huỷ trước đó."
        : !canWrite
          ? "Bạn không có quyền huỷ hồ sơ."
          : "Không đủ điều kiện huỷ hồ sơ ở trạng thái hiện tại.";
  return (
    <>
      <PageHead
        crumbs={[{ label: "Hồ sơ", to: "/ho-so" }, { label: record.code }]}
        title={`Hồ sơ ${record.code}`}
        description={`${sampleCountLabel(record.samples)} · ${record.status.name}`}
        actions={
          <>
            {canAssignSampling ? (
              <Button appearance="primary" onClick={() => setAssignOpen(true)}>
                Phân công lấy mẫu
              </Button>
            ) : null}
            {canEdit ? (
              <Button
                onClick={() => void navigate({ to: "/sua-ho-so", search: { code: record.code } })}
              >
                Sửa hồ sơ
              </Button>
            ) : null}
            {canCancel ? (
              <Button
                disabled={!reason.trim() || evidenceIds.length === 0 || cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                Huỷ hồ sơ
              </Button>
            ) : null}
          </>
        }
      />
      <AssignSamplingDrawer
        recordId={record.code}
        bm01Place={record.samplingLocation}
        open={assignOpen}
        onOpenChange={setAssignOpen}
        onConfirm={(result) => {
          setAssignOpen(false);
          // Trạng thái hồ sơ đổi sang «Đã phân công lấy mẫu» ngay sau khi phân công - nạp lại chi
          // tiết để nút và badge trên màn này theo kịp.
          void cache.invalidateQueries({ queryKey: requestKeys.detail(record.code) });
          toast(
            `Đã phân công lấy mẫu ${record.code}`,
            `${result.samplerName} · ${result.date} ${result.time} · ${result.place}`,
          );
        }}
      />
      <div className="dlp-chiprow" style={{ marginBottom: 12 }}>
        <Badge appearance="tint" color={toneToColor(record.status.tone)}>
          {record.status.name}
        </Badge>
        <Badge appearance="tint" color={toneToColor(record.payment.tone)}>
          {record.payment.name}
        </Badge>
      </div>
      <RequestError error={actionError} />
      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(String(d.value))}>
        <Tab value="overview">Tổng quan</Tab>
        <Tab value="payment">Thanh toán</Tab>
        <Tab value="sampling">Lấy mẫu</Tab>
        <Tab value="results">Mẫu & kết quả</Tab>
        <Tab value="certs">Phiếu</Tab>
        <Tab value="history">Lịch sử</Tab>
        {showActionsTab ? <Tab value="actions">Huỷ & bàn giao</Tab> : null}
      </TabList>

      <div style={{ marginTop: 14 }}>
        {tab === "overview" ? (
          <Section title="BM01 và thông tin truy xuất">
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))",
                gap: 12,
              }}
            >
              {fields.map(([label, value]) => (
                <div key={label}>
                  <small>{label}</small>
                  <div>{value}</div>
                </div>
              ))}
            </div>
          </Section>
        ) : null}
        {/* Bảng mẫu (CR-20260831-001, D46-D48) - bù cho việc badge trạng thái cấp hồ sơ chỉ là giá
            trị SUY RA (FR-REQ-019, mẫu chậm nhất) nên mất độ phân giải khi các mẫu chạy lệch nhau
            sau tiếp nhận (vd mẫu 1 đã phát hành phiếu trong khi mẫu 2 đang thử nghiệm lại). */}
        {tab === "overview" ? (
          <Section title={`Danh sách mẫu (${record.samples.length})`}>
            {record.samples.length === 0 ? (
              <span style={{ color: "var(--foreground-secondary)" }}>Hồ sơ chưa có mẫu nào.</span>
            ) : (
              <div style={{ display: "grid", gap: 0 }}>
                <div
                  className="dlp-datagrid__secondary"
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "minmax(110px,1fr) minmax(140px,1.4fr) 110px 1.6fr 140px 140px",
                    gap: 10,
                    padding: "0 0 6px",
                    borderBottom: "1px solid var(--border-subtle)",
                  }}
                >
                  <span>Mã mẫu</span>
                  <span>Tên mẫu</span>
                  <span>Biển số</span>
                  <span>Chỉ tiêu</span>
                  <span>Trạng thái</span>
                  <span>Phiếu KQ</span>
                </div>
                {record.samples.map((sample, index) => (
                  <div
                    key={sample.id ?? sample.code ?? index}
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "minmax(110px,1fr) minmax(140px,1.4fr) 110px 1.6fr 140px 140px",
                      gap: 10,
                      alignItems: "center",
                      padding: "8px 0",
                      borderBottom: "1px solid var(--border-subtle)",
                    }}
                  >
                    <span className="dlp-num">{sample.code ?? `#${index + 1} (nháp)`}</span>
                    <span>{sample.product ?? "—"}</span>
                    <span className="dlp-num">{sample.vehiclePlate ?? "—"}</span>
                    <span>
                      {(sample.parameters ?? [])
                        .map((p) => (p.name ? `${p.name} (${p.code})` : p.code))
                        .join(", ") || "—"}
                    </span>
                    {sample.status ? (
                      <Badge appearance="tint" color={toneToColor(sample.status.tone)}>
                        {sample.status.name}
                      </Badge>
                    ) : (
                      <span>—</span>
                    )}
                    <span>{sample.reportCode ?? "—"}</span>
                  </div>
                ))}
              </div>
            )}
          </Section>
        ) : null}
        {tab === "payment" ? (
          <>
            <Section title="Chứng từ đã ghi nhận">
              <PaymentRecordPanel payment={record.payment} />
            </Section>
            {/* Hai form dưới chỉ dựng khi thao tác còn hợp lệ. Form không có nút bấm là ngõ cụt:
                người dùng điền xong mới biết không nộp được. `canPay`/`canException` đã gộp cả
                quyền lẫn trạng thái (`allowedActions` do máy chủ tính). */}
            {canPay || canException ? (
              <div className="dlp-split" style={{ marginTop: 14 }}>
                {canPay ? (
                  <Section title="Xác nhận thanh toán">
                    <FileUpload grant="payment.evidence" onUploaded={setPaymentEvidence} />
                    <Field label="Số tiền (VND)" required hint="Ví dụ: 1,500,000.50 ₫">
                      <VndAmountInput
                        required
                        placeholder="1,500,000.50"
                        value={amount}
                        onChange={setAmount}
                      />
                    </Field>
                    <Field label="Ghi chú (tuỳ chọn)">
                      <Textarea value={note} onChange={(_, d) => setNote(d.value)} />
                    </Field>
                    <Button
                      appearance="primary"
                      disabled={!paymentEvidence || !validPaymentAmount || payment.isPending}
                      onClick={() => payment.mutate()}
                    >
                      Xác nhận đã thanh toán
                    </Button>
                  </Section>
                ) : null}
                {canException ? (
                  <Section title="Ngoại lệ thanh toán">
                    <Field label="Lý do">
                      <Textarea value={reason} onChange={(_, d) => setReason(d.value)} />
                    </Field>
                    <Field label="Số tiền công nợ (VND)">
                      <Input
                        type="number"
                        min="1"
                        value={exceptionAmount}
                        onChange={(_, d) => setExceptionAmount(d.value)}
                      />
                    </Field>
                    <FileUpload
                      grant="payment.exception"
                      onUploaded={(id) => setEvidenceIds((ids) => [...ids, id])}
                    />
                    <Button
                      disabled={
                        !reason.trim() ||
                        Number(exceptionAmount) <= 0 ||
                        evidenceIds.length === 0 ||
                        exception.isPending
                      }
                      onClick={() => exception.mutate()}
                    >
                      Cấp ngoại lệ
                    </Button>
                  </Section>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
        {/* Ba trạng thái tách bạch ở cả hai tab: đang tải · hồ sơ chưa tới bước đó · lỗi tải.
            Chỉ trạng thái giữa mới là ô rỗng, và câu chữ phải nói đúng hồ sơ đang thiếu bước nào -
            "chưa có dữ liệu" trần không phân biệt được ba tình huống này. */}
        {samplingTab ? (
          <Section title="Lấy mẫu (BM02/BM03)">
            {codesQuery.isLoading || assignmentQuery.isLoading ? (
              <Spinner label="Đang tải dữ liệu lấy mẫu…" />
            ) : null}
            <RequestError error={codesQuery.error ?? assignmentQuery.error} />
            {!codesQuery.isLoading && !codesQuery.error && !assignmentCode ? (
              <EmptyState
                title="Hồ sơ chưa được phân công lấy mẫu"
                hint="Bản chụp hiện trường BM02/BM03 hiện ở đây sau khi có lượt lấy mẫu."
                actionLabel={canOpenSampling ? "Mở màn lấy mẫu" : undefined}
                onAction={
                  canOpenSampling
                    ? () => void navigate({ to: "/lay-mau", search: { code: record.code } })
                    : undefined
                }
              />
            ) : null}
            {assignmentQuery.data ? (
              <RequestSamplingPanel assignment={assignmentQuery.data} />
            ) : null}
          </Section>
        ) : null}
        {resultsTab ? (
          <Section title="Mẫu & kết quả">
            <Field label="Mẫu">
              <select
                value={sampleCode ?? ""}
                onChange={(e) => setSelectedSampleCode(e.target.value)}
              >
                {record.samples.map((s) => (
                  <option key={s.id ?? s.code} value={s.code}>
                    {s.code} · {s.product}
                  </option>
                ))}
              </select>
            </Field>
            {codesQuery.isLoading || sampleQuery.isLoading || tasksQuery.isLoading ? (
              <Spinner label="Đang tải mẫu và kết quả…" />
            ) : null}
            <RequestError error={codesQuery.error ?? sampleQuery.error ?? tasksQuery.error} />
            {!codesQuery.isLoading && !codesQuery.error && !sampleCode ? (
              <EmptyState
                title="Hồ sơ chưa tiếp nhận mẫu"
                hint="Các chỉ tiêu của mẫu hiện ở đây sau khi tiếp nhận."
                actionLabel={canOpenResults ? "Mở màn nhập kết quả" : undefined}
                onAction={
                  canOpenResults
                    ? () => void navigate({ to: "/nhap-ket-qua", search: { code: sampleCode } })
                    : undefined
                }
              />
            ) : null}
            {sampleQuery.data ? (
              <RequestSamplesPanel
                sample={sampleQuery.data}
                tasks={tasksQuery.data?.content ?? []}
                requestCode={record.code}
              />
            ) : null}
          </Section>
        ) : null}
        {tab === "certs" ? (
          <Section title="Phiếu kết quả">
            {reportsQuery.isLoading ? <Spinner label="Đang tải phiếu…" /> : null}
            <RequestError error={reportsQuery.error} />
            <RequestError
              error={previewReport.error ?? downloadReport.error}
              fallback="Không thể mở phiếu."
            />
            {(reportsQuery.data ?? []).map((report) => {
              const released = everReleasedStatuses.has(report.status.code);
              return (
                <div
                  key={report.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(180px,1fr) auto auto",
                    gap: 12,
                    alignItems: "center",
                    borderTop: "1px solid var(--border-subtle)",
                    paddingTop: 10,
                  }}
                >
                  <div>
                    <strong>
                      {report.reportCode} · phiên bản {report.version}
                    </strong>
                    <small style={{ display: "block" }}>
                      {report.current ? "Phiên bản hiện hành" : "Phiên bản được giữ để truy vết"}
                    </small>
                  </div>
                  <Badge appearance="tint" color={toneToColor(report.status.tone)}>
                    {report.status.name}
                  </Badge>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <Button
                      size="small"
                      disabled={previewingId === report.id}
                      icon={previewingId === report.id ? <Spinner size="tiny" /> : undefined}
                      onClick={() => previewReport.mutate(report)}
                    >
                      {previewingId === report.id ? "Đang mở…" : "Xem trước"}
                    </Button>
                    {/* Chỉ bản đã phát hành mới có PDF bất biến để tải - đúng điều kiện máy chủ
                        chặn `GET /reports/{id}/pdf`. */}
                    <Button
                      size="small"
                      disabled={!released || downloadingId === report.id}
                      title={released ? undefined : "Chỉ tải được PDF của phiên bản đã phát hành."}
                      icon={downloadingId === report.id ? <Spinner size="tiny" /> : undefined}
                      onClick={() => downloadReport.mutate(report)}
                    >
                      {downloadingId === report.id ? "Đang tải…" : "Tải PDF"}
                    </Button>
                    <Button
                      size="small"
                      onClick={() =>
                        void navigate({
                          to: "/tra-ket-qua",
                          search: { code: record.code, sampleCode: report.sampleCode },
                        })
                      }
                    >
                      Mở trả kết quả mẫu này
                    </Button>
                  </div>
                </div>
              );
            })}
            {reportsQuery.isSuccess && reportsQuery.data.length === 0 ? (
              <EmptyState
                title="Chưa phát hành phiếu"
                hint="Phiếu kết quả xuất hiện sau khi được phê duyệt và phát hành."
                actionLabel="Mở màn trả kết quả"
                onAction={() =>
                  void navigate({ to: "/tra-ket-qua", search: { code: record.code } })
                }
              />
            ) : null}
          </Section>
        ) : null}
        {tab === "history" ? (
          <Section title="Lịch sử & nhật ký truy cập">
            <AuditEventList
              events={flattenAuditPages(historyQuery.data?.pages)}
              isLoading={historyQuery.isLoading}
              error={historyQuery.error}
              hasNextPage={historyQuery.hasNextPage}
              isFetchingNextPage={historyQuery.isFetchingNextPage}
              onLoadMore={() => void historyQuery.fetchNextPage()}
              emptyTitle="Chưa có thao tác nào được ghi nhận"
              emptyHint="Mọi thay đổi trên hồ sơ này sẽ xuất hiện ở đây kèm người thực hiện và thời điểm."
            />
          </Section>
        ) : null}

        {tab === "actions" ? (
          <div className="dlp-split">
            <Section title="Huỷ hồ sơ">
              {canCancel ? (
                <>
                  <Field label="Lý do">
                    <Textarea value={reason} onChange={(_, d) => setReason(d.value)} />
                  </Field>
                  <FileUpload
                    grant="request.cancel"
                    onUploaded={(id) => setEvidenceIds((ids) => [...ids, id])}
                  />
                  <Button
                    disabled={!reason.trim() || evidenceIds.length === 0 || cancel.isPending}
                    onClick={() => cancel.mutate()}
                  >
                    Xác nhận huỷ
                  </Button>
                </>
              ) : (
                <div style={{ color: "var(--status-danger-foreground)" }}>{cancelReason}</div>
              )}
            </Section>
            {/* Cùng thẻ, cùng luật, cùng nhật ký với màn Tiếp nhận và màn Bàn giao - ba cửa vào
                một bảng `ops.handover` thì không được hỏi ba bộ câu hỏi khác nhau. */}
            {handoverReason ? (
              <Section title="Bàn giao mẫu vào lab">
                <div style={{ color: "var(--status-danger-foreground)" }}>{handoverReason}</div>
                <HandoverLog entries={handoverLog.data} pending={handoverLog.isLoading} />
              </Section>
            ) : (
              <HandoverCard
                sampleCode={sampleCode ?? ""}
                isLab={handoverIsLab}
                disabled={!sampleCode}
                busy={handover.isPending}
                error={handover.error ? apiErrorMessage(handover.error) : undefined}
                success={handoverSuccess}
                counterpartUserId={counterpart}
                scanMethod={handoverScanMethod}
                note={handoverNote}
                log={handoverLog.data}
                logPending={handoverLog.isLoading}
                repeatAcknowledged={repeatAcknowledged}
                onRepeatAcknowledged={setRepeatAcknowledged}
                onCounterpartUserId={setCounterpart}
                onScanMethod={setHandoverScanMethod}
                onNote={setHandoverNote}
                onSubmit={() => handover.mutate()}
              />
            )}
          </div>
        ) : null}
      </div>
    </>
  );
}
