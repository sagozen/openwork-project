import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  Checkbox,
  Dropdown,
  Field,
  Input,
  InteractionTag,
  InteractionTagPrimary,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Option,
  Textarea,
} from "@fluentui/react-components";
import { NoAccess } from "@/components/lims/NoAccess";
import { PageHead, PermissionButton, StatStrip, useDlpToast } from "@/components/lims/common";
import { ChangeRequestCard, type CrDecision } from "@/components/lims/intake/ChangeRequestCard";
import { ChecklistPane, type ChecklistDraft } from "@/components/lims/intake/ChecklistPane";
import { ParentLabelCard } from "@/components/lims/intake/ParentLabelCard";
import { card, hintText, sectionTitle } from "@/components/lims/request-styles";
import {
  useReceptionDetail,
  useReceptionWorklist,
  useRecordReception,
} from "@/features/reception/hooks";
import type {
  ReceptionChecklistItem,
  ReceptionWorklistItem,
  RecordReceptionInput,
} from "@/features/reception/types";
import { resolveAcceptedSampleCode } from "@/features/reception/resolve-accepted-sample-code";
import { selectReceptionSample } from "@/features/reception/select-reception-sample";
import { useHandoverLog, useRequestDetail } from "@/features/request/hooks";
import { apiErrorMessage, apiFieldErrors } from "@/lib/api";
import { useDebounced } from "@/lib/use-debounced";
import { useAuth } from "@/lib/auth/AuthProvider";
import { PERM } from "@/lib/admin/rbac";
import { toneToColor } from "@/lib/admin/tone";
import {
  CHANGE_REQUESTS,
  INTAKE_STATS,
  TRANSIT_RECORDS,
  checklistFor,
} from "@/lib/admin/intake-data";

// `ReceptionDetail.traceability` dùng khoá tiếng Anh của API; màn hình đọc bằng tiếng Việt nên
// tra nhãn qua bảng này. Khoá lạ (API bổ sung trường mới) vẫn hiện nguyên tên thay vì bị giấu đi.
const TRACEABILITY_LABELS: Record<string, string> = {
  productName: "Tên sản phẩm",
  growingAreaCode: "Mã số vùng trồng",
  packingHouseCode: "Mã cơ sở đóng gói",
  vehiclePlate: "Biển số xe",
  containerNo: "Số container",
  trailerNo: "Số rơ-moóc",
  sealNo: "Số seal",
};

export const Route = createFileRoute("/_app/tiep-nhan")({
  head: () => ({
    meta: [
      { title: "Tiếp nhận mẫu - DLP LIMS" },
      {
        name: "description",
        content: "Đối soát checklist, chốt mẫu thực nhận tại một cửa và in tem mã mẫu.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: IntakeScreen,
});

function formatDate(value?: string): string | undefined {
  if (!value) return undefined;
  return new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short" }).format(
    new Date(value),
  );
}

/** Dòng hàng chờ đã chắc chắn có mã - xem chú thích ở chỗ lọc trong `IntakeScreen`. */
type WorklistRow = ReceptionWorklistItem & { requestCode: string };

function demoItems(): ReceptionWorklistItem[] {
  return TRANSIT_RECORDS.map((record) => ({
    requestCode: record.id,
    sampleCount: 1,
    productName: record.product,
    declaredQuantity: record.qty,
    quantityUnit: "quả",
    customer: { id: record.id, name: record.customer },
    containerNo: record.container,
    arrivedAt: record.arrivedAt,
    status: { code: record.stateCode, name: record.state, tone: record.tone },
    testParameters: record.tests,
    allowedActions: ["reception:check", "reception:accept"],
  }));
}

function initialDrafts(items: ReceptionChecklistItem[]): Record<string, ChecklistDraft> {
  return Object.fromEntries(
    items.map((item) => [item.key, { actualValue: item.actualValue ?? "" }]),
  );
}

/* Nháp checklist sống qua điều hướng. Người tiếp nhận điền dở 6/7 dòng rồi bị chặn vì hồ sơ chưa
   thanh toán, phải sang màn khác xác nhận thanh toán - quay lại mà mất sạch thì họ gõ lại từ đầu.
   Giữ theo từng mã hồ sơ trong sessionStorage: hết phiên trình duyệt là hết, không đọng dữ liệu
   nghiệp vụ ngoài phiên làm việc. */
const draftStorageKey = (requestCode: string) => `dlp.tiep-nhan.checklist.${requestCode}`;

function readStoredDrafts(
  requestCode: string,
  items: ReceptionChecklistItem[],
): Record<string, ChecklistDraft> | null {
  if (!requestCode || typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(draftStorageKey(requestCode));
    if (!raw) return null;
    const stored = JSON.parse(raw) as Record<string, ChecklistDraft>;
    // Chỉ nhận lại đúng những dòng checklist máy chủ đang trả về: bộ hạng mục đổi thì nháp cũ
    // không còn nghĩa, thà seed lại từ máy chủ còn hơn khôi phục kết luận cho dòng đã biến mất.
    const base = initialDrafts(items);
    return Object.fromEntries(
      Object.entries(base).map(([key, value]) => [key, stored[key] ?? value]),
    );
  } catch {
    return null;
  }
}

/** Nhãn của lựa chọn rỗng. Hàng chờ mặc định KHÔNG phải "tất cả": nó là phần việc quầy còn nợ,
 *  nên gọi đúng tên. Hồ sơ đã ra khỏi hàng chờ (đã chia mã con, quầy đã từ chối) vẫn tra được
 *  bằng cách chọn thẳng trạng thái đó — backend coi status tường minh là đường thoát khỏi cửa sổ
 *  hàng chờ, không phải bộ lọc chồng lên nó. */
const DEFAULT_STATUS_LABEL = "Đang xử lý";

/** Trùng đúng tập trạng thái backend công nhận cho mẫu cha. Bỏ «Đang vận chuyển»: hệ thống không
 *  có sự kiện xuất phát lẫn sự kiện tới nơi nên không biết được điều đó, và mẫu cha không bao giờ
 *  mang trạng thái này. */
const STATUS_FILTERS = [
  { value: "", label: DEFAULT_STATUS_LABEL },
  /* Mẫu chưa về quầy: hồ sơ đã phân công/đang lấy mẫu, chưa có bản ghi mẫu nào. Backend gọi nhóm
     này là NOT_ARRIVED và chỉ trả nó khi được hỏi đích danh — cửa sổ hàng chờ mặc định cố ý không
     chứa nó. Thiếu mục này thì thẻ KPI «Sắp về» đếm được mà không mở ra được. */
  { value: "NOT_ARRIVED", label: "Sắp về" },
  { value: "AWAITING_CHECK", label: "Chờ đối soát" },
  { value: "RECEIVED", label: "Đã tiếp nhận" },
  { value: "HANDED_OVER", label: "Đã bàn giao lab" },
  { value: "ON_HOLD", label: "Tạm giữ" },
  { value: "REJECTED", label: "Từ chối tiếp nhận" },
] as const;

function IntakeScreen() {
  const { can, usesClerk } = useAuth();
  const toast = useDlpToast();
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string[]>([]);
  /* Từ khoá chỉ thành `queryKey` sau khi người dùng ngừng gõ. Gõ thẳng vào filters thì mỗi phím
     là một lượt tải mới, và màn dựng lại theo trạng thái tải sẽ cuốn theo cả ô đang gõ. */
  const debouncedQuery = useDebounced(query.trim());
  const filters = useMemo(
    () => ({
      page,
      size: 10,
      sort: "arrivedAt:desc",
      ...(debouncedQuery ? { q: debouncedQuery } : {}),
      ...(status.length ? { status } : {}),
    }),
    [page, debouncedQuery, status],
  );
  const worklist = useReceptionWorklist(filters, usesClerk);
  // Hàng chờ trả cả hồ sơ DRAFT, vốn chưa có mã (BR-003). Không có mã thì không tiếp nhận, không
  // chia mã con, không bàn giao được - bỏ khỏi hàng chờ thay vì hiện một dòng trống bấm vào lỗi.
  const items = useMemo<WorklistRow[]>(() => {
    if (usesClerk)
      return (worklist.data?.content ?? []).filter(
        (item): item is WorklistRow => !!item.requestCode,
      );
    // Bản minh hoạ lọc ngay trên máy: cùng hai ô lọc, cùng cách phản hồi, chỉ khác chỗ lọc.
    const needle = query.trim().toLowerCase();
    return (demoItems() as WorklistRow[]).filter((item) => {
      if (status.length && !status.includes(item.status.code)) return false;
      if (!needle) return true;
      return [item.requestCode, item.productName, item.containerNo, item.customer?.name]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(needle));
    });
  }, [usesClerk, worklist.data, query, status]);
  const [pickedCode, setPickedCode] = useState(usesClerk ? "" : (TRANSIT_RECORDS[0]?.id ?? ""));
  useEffect(() => {
    if (items.length && !items.some((item) => item.requestCode === pickedCode))
      setPickedCode(items[0]!.requestCode);
  }, [items, pickedCode]);
  const selected = items.find((item) => item.requestCode === pickedCode) ?? items[0];
  const requestDetail = useRequestDetail(
    selected?.requestCode ?? "",
    usesClerk && !!selected?.requestCode,
  );
  const [chosenSample, setChosenSample] = useState({
    requestCode: "",
    status: "",
    code: "",
  });
  const selectedSample = selectReceptionSample(
    requestDetail.data?.samples ?? [],
    chosenSample.requestCode === selected?.requestCode && chosenSample.status === (status[0] ?? "")
      ? chosenSample.code
      : "",
    status[0],
  );
  const receptionSampleCode = selectedSample?.code;
  const detailQuery = useReceptionDetail(
    selected?.requestCode,
    usesClerk && requestDetail.isSuccess,
    receptionSampleCode,
  );
  const sampleStatus = detailQuery.data?.status ?? selectedSample?.status ?? selected?.status;

  const demoRecord = !usesClerk
    ? (TRANSIT_RECORDS.find((record) => record.id === selected?.requestCode) ?? TRANSIT_RECORDS[0])
    : undefined;
  const demoChecklist = useMemo<ReceptionChecklistItem[]>(
    () =>
      !usesClerk && demoRecord
        ? checklistFor(demoRecord).map((item) => ({
            key: item.key,
            name: item.name,
            rule: item.rule,
            declaredValue: item.declared,
            actualValue: item.actual,
            verdict: null,
            requiresReasonOnMismatch: true,
          }))
        : [],
    [usesClerk, demoRecord],
  );
  /* Giữ nguyên danh tính mảng giữa các lần dựng: effect seed nháp bên dưới nhận `checklist` làm
     phụ thuộc, mà `?? []` sinh mảng mới mỗi lần dựng thì effect chạy lại vô ích. */
  const checklist = useMemo(
    () => (usesClerk ? (detailQuery.data?.checklist ?? []) : demoChecklist),
    [usesClerk, detailQuery.data?.checklist, demoChecklist],
  );
  /**
   * Hồ sơ đã đi hết khâu lấy mẫu chưa (`PENDING_LAB` = mẫu rời hiện trường, đang trên đường về
   * quầy). Máy chủ chặn tiếp nhận trước mốc này (`E-RCV-005`) - đúng, nhưng nếu màn hình vẫn dựng
   * đủ 7 dòng checklist thì người tiếp nhận đã kịp kết luận «Khớp» cho BM02/BM03 chưa hề tồn tại
   * rồi mới bị từ chối. Cú bấm đó không vô hại: nó dạy đúng thói quen tích cho đủ 7 dòng mà
   * FR-RCV-013 và BR-023 sinh ra để ngăn. Nên chặn ở đây, trước khi vẽ.
   */
  const requestStageOrder = ["DRAFT", "AWAITING_SAMPLING", "ASSIGNED", "SAMPLING", "PENDING_LAB"];
  const requestStatus = usesClerk ? selected?.requestStatus : undefined;
  const beforeCounter =
    !!requestStatus &&
    requestStageOrder.indexOf(requestStatus.code) >= 0 &&
    requestStageOrder.indexOf(requestStatus.code) < requestStageOrder.indexOf("PENDING_LAB");
  const [drafts, setDrafts] = useState<Record<string, ChecklistDraft>>({});
  /* Đã seed nháp cho hồ sơ nào. Trước đây effect seed lại theo `detailQuery.dataUpdatedAt`, nên
     mỗi lượt refetch nền (quay lại tab trình duyệt là đủ) ghi đè nháp về mặc định ngay giữa lúc
     đang điền - mất dữ liệu mà không cần rời trang. Giờ chỉ seed khi ĐỔI hồ sơ. */
  const seededDraftsFor = useRef<string | null>(null);
  const selectedCode = `${selected?.requestCode ?? ""}:${receptionSampleCode ?? ""}`;
  useEffect(() => {
    if (seededDraftsFor.current === selectedCode) return;
    if (selectedCode && !checklist.length) return; // chờ máy chủ trả checklist rồi mới seed
    seededDraftsFor.current = selectedCode;
    setDrafts(readStoredDrafts(selectedCode, checklist) ?? initialDrafts(checklist));
  }, [selectedCode, checklist]);

  // Ghi nháp sau mỗi thay đổi để rời trang giữa chừng vẫn quay lại được.
  useEffect(() => {
    if (!selectedCode || seededDraftsFor.current !== selectedCode) return;
    if (typeof sessionStorage === "undefined") return;
    try {
      sessionStorage.setItem(draftStorageKey(selectedCode), JSON.stringify(drafts));
    } catch {
      /* hết chỗ lưu hoặc trình duyệt chặn: nháp không giữ được, không vì thế mà chặn tiếp nhận */
    }
  }, [selectedCode, drafts]);

  const [actualQuantity, setActualQuantity] = useState("");
  const [sealIntact, setSealIntact] = useState(true);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [demoReceived, setDemoReceived] = useState(false);
  /* Khối «Chia mã con»: số mẫu con và lý do lệch. Để trống nghĩa là chia đúng số đã chốt ở quầy -
     ô chỉ được điền sẵn khi đọc được mẫu cha, xem effect bên dưới. */
  const [crDecision, setCrDecision] = useState<CrDecision>("wait");
  useEffect(() => {
    // Số lượng thực nhận thuộc từng mẫu, không lấy số lượng mẫu đầu của hồ sơ nhiều mẫu.
    setActualQuantity(!usesClerk && selected?.declaredQuantity !== undefined
      ? String(selected.declaredQuantity)
      : "");
    setSealIntact(true);
    setDemoReceived(false);
    setReason("");
    setNote("");
    setCrDecision("wait");
  }, [selectedCode]);

  const recordReception = useRecordReception(selected?.requestCode);
  /* Nhật ký bàn giao chỉ để ĐỌC ở màn này: thao tác giao - nhận nằm trọn ở menu «Bàn giao vào
     lab». Giữ lại vì đây là chỗ người tiếp nhận biết mẫu vừa chốt đã được ai mang vào lab. */
  const handoverLog = useHandoverLog(selected?.requestCode, usesClerk);
  /* Hàng chờ cố ý KHÔNG join tên người cho `handover.fromUser/toUser` - tránh N+1 trên danh sách
     phân trang - nên hai ô này từng in ra số id ("6 → 13") ngay phía trên nhật ký in đúng tên.
     Tên đã có sẵn trên trang: lấy từ chính nhật ký, không cần thêm một lượt gọi máy chủ nào.
     Nhật ký trả mới-nhất-trước (`ORDER BY performed_at DESC`) nên phần tử ĐẦU mới là lượt gần
     nhất - cùng lượt mà hàng chờ chọn bằng `ORDER BY ... DESC LIMIT 1`. */
  const lastDeliver = (handoverLog.data ?? []).find((entry) => entry.step.code === "DELIVER");

  /* Chốt tiếp nhận là chốt luôn số mẫu của lô: có bao nhiêu mẫu thì máy chủ sinh bấy nhiêu mã con
     và quầy in bấy nhiêu tem, dán lên từng mẫu trước khi bàn giao. Vì vậy `received` phải tính
     ngay tại đây - nó là điều kiện mở lệnh chia mã và thẻ in tem mẫu con bên dưới. */
  const received =
    demoReceived ||
    (recordReception.data?.sample?.code === receptionSampleCode &&
      recordReception.data?.sample?.status.code === "RECEIVED") ||
    sampleStatus?.code === "RECEIVED";
  const acceptedSampleCode = resolveAcceptedSampleCode(recordReception.data, selected?.requestCode);
  const parentSampleCode =
    receptionSampleCode ?? acceptedSampleCode ?? detailQuery.data?.sampleCode;
  if (!can(PERM.RECEPTION_READ)) return <NoAccess screen="Tiếp nhận mẫu" />;
  // ListReceptionQueueService#allowedActions (backend) chỉ sinh đúng hai mã "reception:check"/
  // "reception:accept" khi caller có reception.accept; quyền in tem mã cha phải suy từ PERM.*
  // thật, không suy từ chuỗi allowedActions ảo.
  const canAccept = can(PERM.RECEPTION_ACCEPT);
  const canPrintParent = can(PERM.RECEPTION_LABEL_PRINT_PARENT);
  const canReceiveAction = !usesClerk || (
    ["PENDING_LAB", "RECEIVED", "IN_TESTING"].includes(requestDetail.data?.status.code ?? "") &&
    detailQuery.isSuccess &&
    (!requestDetail.data?.samples.length || !!receptionSampleCode) &&
    sampleStatus?.code === "AWAITING_CHECK"
  );
  const canWrite = canAccept;
  const canPrintAction = !usesClerk || canPrintParent;
  const fieldErrors = apiFieldErrors(recordReception.error);
  const allObserved =
    checklist.length > 0 && checklist.every((item) => drafts[item.key]?.actualValue.trim());
  const quantity = Number.parseFloat(actualQuantity);
  /* Mỗi thẻ KPI mở ra đúng nhóm nó đếm. Backend đặt tên nhóm theo việc (INCOMING, AWAITING_SPLIT)
     còn bộ lọc gọi theo trạng thái mẫu, nên phải bắc cầu ở đây. Thẻ nào không bắc được sang một
     bộ lọc đúng nghĩa thì để nguyên là con số — «đã tiếp nhận hôm nay» lọc ra được RECEIVED nhưng
     mất vế «hôm nay», bấm vào sẽ ra nhiều hơn cái nó vừa hứa. */
  const STAT_FILTER: Record<string, string> = {
    INCOMING: "NOT_ARRIVED",
    AWAITING_CHECK: "AWAITING_CHECK",
    AWAITING_SPLIT: "HANDED_OVER",
  };
  const stats = usesClerk
    ? (worklist.data?.summary
        .filter((item) => item.key !== "AWAITING_SPLIT")
        .map((item) => {
          const filterValue = STAT_FILTER[item.key];
          return {
            ...item,
            hint: undefined,
            selected: !!filterValue && status[0] === filterValue,
            ...(filterValue
              ? {
                  onSelect: () => {
                    setStatus(status[0] === filterValue ? [] : [filterValue]);
                    setPage(1);
                  },
                }
              : {}),
          };
        }) ?? [])
    : INTAKE_STATS;

  const submitReception = (decision: RecordReceptionInput["decision"]) => {
    if (!selected) return;
    if (!usesClerk) {
      if (decision === "ACCEPT") {
        setDemoReceived(true);
      }
      toast(
        decision === "ACCEPT"
          ? `Đã tiếp nhận ${selected.requestCode}`
          : decision === "HOLD"
            ? "Đã tạm giữ mẫu"
            : "Đã từ chối tiếp nhận",
        reason || "Đã ghi nhận vào nhật ký hồ sơ.",
        decision === "REJECT" ? "warning" : "success",
      );
      return;
    }
    const input: RecordReceptionInput =
      decision === "ACCEPT"
        ? {
            decision,
            actualQuantity: quantity,
            sealIntact,
            checklist: checklist.flatMap((item) => {
              const draft = drafts[item.key];
              return draft?.actualValue.trim()
                ? [{ key: item.key, actualValue: draft.actualValue.trim() }]
                : [];
            }),
            ...(reason.trim() ? { reason: reason.trim() } : {}),
            ...(note.trim() ? { note: note.trim() } : {}),
          }
        : { decision, ...(reason.trim() ? { reason: reason.trim() } : {}) };
    recordReception.mutate(
      { ...input, sampleCode: receptionSampleCode },
      {
        onSuccess: (result) => {
          toast(
            decision === "ACCEPT"
              ? `Đã tiếp nhận ${result.requestCode}`
              : decision === "HOLD"
                ? "Đã tạm giữ mẫu"
                : "Đã từ chối tiếp nhận",
            apiErrorMessage(recordReception.error, "Máy chủ đã ghi nhận quyết định."),
          );
          // Quyết định đã ghi thì nháp hết nghĩa - giữ lại chỉ tổ khôi phục nhầm ở lượt sau.
          try {
            sessionStorage.removeItem(draftStorageKey(selectedCode));
          } catch {
            /* không đọc/ghi được sessionStorage: bỏ qua, nháp tự hết khi đóng phiên */
          }
          // KHÔNG chia mã ở đây. Máy chủ chỉ nhận lệnh chia khi mẫu cha đã sang HANDED_OVER
          // (`SplitSampleService#requireReceived`, E-RCV-008), mà ngay sau ACCEPT mẫu mới ở
          // RECEIVED - lệnh gửi lúc này luôn bị từ chối. Chia mã là việc của lab sau khi lab xác
          // nhận nhận mẫu, làm ở khối «Chia mã con» bên dưới.
        },
      },
    );
  };

  /* Chỉ vùng hàng chờ báo đang tải. Trả sớm cả màn ở đây là cách ô tìm kiếm bị unmount giữa lúc
     gõ — xem `useDebounced` và `placeholderData` ở trên. */
  const worklistLoading = usesClerk && worklist.isPending;
  if (usesClerk && worklist.isError)
    return (
      <MessageBar intent="error">
        <MessageBarBody>
          <MessageBarTitle>Không tải được hàng chờ</MessageBarTitle>
          {apiErrorMessage(worklist.error)}
        </MessageBarBody>
      </MessageBar>
    );

  const inlineChange = detailQuery.data?.changeRequests?.[0];
  const demoChange = !usesClerk ? CHANGE_REQUESTS[0] : undefined;
  const changeRequest = inlineChange
    ? {
        id: inlineChange.id,
        title: inlineChange.title ?? `Đề nghị sửa · ${selected?.requestCode}`,
        who: [inlineChange.requestedBy?.fullName, formatDate(inlineChange.requestedAt)]
          .filter(Boolean)
          .join(" · "),
        reason: inlineChange.reason,
        fields: inlineChange.fields.flatMap((field) =>
          field.oldValue !== undefined && field.newValue !== undefined
            ? [{ field: field.field, oldValue: field.oldValue, newValue: field.newValue }]
            : [],
        ),
      }
    : demoChange;
  const changePicked = changeRequest?.fields.map((field) => field.field) ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 1400, minWidth: 0 }}>
      <PageHead
        crumbs={[
          { label: "Hồ sơ kiểm nghiệm", to: "/ho-so" },
          { label: selected ? `Tiếp nhận ${selected.requestCode}` : "Tiếp nhận" },
        ]}
        title="Tiếp nhận mẫu tại một cửa"
        description="Đối chiếu checklist, chốt tiếp nhận và in tem mẫu. Giao nhận theo từng mã mẫu tại màn Bàn giao vào lab."
      />
      <StatStrip items={stats} />

      <div
        style={{
          ...card,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))",
          gap: 12,
          alignItems: "end",
        }}
      >
        <Field label={usesClerk ? "Tìm trên máy chủ" : "Tìm trong hàng chờ"}>
          <Input
            value={query}
            placeholder="Mã lượt, container, biển số"
            onChange={(_, data) => {
              setQuery(data.value);
              setPage(1);
            }}
          />
        </Field>
        <Field label="Trạng thái">
          <Dropdown
            value={
              STATUS_FILTERS.find((o) => o.value === (status[0] ?? ""))?.label ??
              DEFAULT_STATUS_LABEL
            }
            selectedOptions={status}
            placeholder={DEFAULT_STATUS_LABEL}
            onOptionSelect={(_, data) => {
              setStatus(data.optionValue ? [data.optionValue] : []);
              setPage(1);
            }}
          >
            {STATUS_FILTERS.map((option) => (
              <Option key={option.value} value={option.value}>
                {option.label}
              </Option>
            ))}
          </Dropdown>
        </Field>
        {usesClerk ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, minWidth: 0 }}>
            <Button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>
              Trước
            </Button>
            <Button
              disabled={page >= (worklist.data?.page.totalPages ?? 1)}
              onClick={() => setPage((value) => value + 1)}
            >
              Sau
            </Button>
          </div>
        ) : null}
      </div>

      <div style={{ ...card, gap: 8 }}>
        <span style={{ ...hintText, fontWeight: 600 }}>
          Hàng chờ ·{" "}
          {usesClerk
            ? `${worklist.data?.page.totalElements ?? 0} hồ sơ, trang ${worklist.data?.page.number ?? page}/${worklist.data?.page.totalPages ?? 1}`
            : `${items.length} hồ sơ`}
        </span>
        {worklistLoading ? (
          <span style={hintText}>Đang tải hàng chờ tiếp nhận…</span>
        ) : (
          <div className="dlp-chiprow">
            {items.map((item) => (
              <InteractionTag
                key={item.requestCode}
                className={
                  item.requestCode === selected?.requestCode
                    ? "dlp-chip--picked"
                    : "dlp-chip--unpicked"
                }
                appearance="outline"
              >
                <InteractionTagPrimary
                  aria-pressed={item.requestCode === selected?.requestCode}
                  onClick={() => setPickedCode(item.requestCode)}
                >
                  {item.requestCode === selected?.requestCode ? "✓ " : ""}
                  {item.requestCode} · {item.productName} · {item.status.name}
                  {` · ${item.sampleCount} mẫu`}
                </InteractionTagPrimary>
              </InteractionTag>
            ))}
          </div>
        )}
      </div>

      {worklistLoading ? null : !selected ? (
        <MessageBar intent="info">
          <MessageBarBody>Không có hồ sơ trong bộ lọc hiện tại.</MessageBarBody>
        </MessageBar>
      ) : (
        <>
          {usesClerk && requestDetail.data?.samples.length ? (
            <Field
              className="dlp-intake-sample-picker"
              label={
                <span className="dlp-intake-sample-picker__heading">
                  <span style={sectionTitle}>Mẫu trong hồ sơ</span>
                  <Badge appearance="tint" color="brand">
                    {requestDetail.data.samples.length} mẫu
                  </Badge>
                </span>
              }
              hint="Chọn mẫu cần đối soát và tiếp nhận."
            >
              <Dropdown
                size="large"
                style={{ width: "100%", minWidth: 0 }}
                value={selectedSample ? `${selectedSample.code} · ${selectedSample.product}` : ""}
                selectedOptions={receptionSampleCode ? [receptionSampleCode] : []}
                placeholder="Chọn mẫu trong hồ sơ"
                disabled={recordReception.isPending}
                button={{
                  className: "dlp-intake-sample-picker__button",
                  children: selectedSample ? (
                    <span className="dlp-intake-sample-picker__sample">
                      <span className="dlp-intake-sample-picker__identity">
                        <span className="dlp-intake-sample-picker__code">
                          {selectedSample.code}
                        </span>
                        <span className="dlp-intake-sample-picker__product">
                          {selectedSample.product}
                        </span>
                      </span>
                      {selectedSample.status?.name ? (
                        <Badge appearance="tint" color={toneToColor(selectedSample.status.tone)}>
                          {selectedSample.status.name}
                        </Badge>
                      ) : null}
                    </span>
                  ) : undefined,
                }}
                listbox={{ className: "dlp-intake-sample-picker__list" }}
                onOptionSelect={(_, data) => {
                  if (!data.optionValue) return;
                  setChosenSample({
                    requestCode: selected.requestCode,
                    status: status[0] ?? "",
                    code: data.optionValue,
                  });
                }}
              >
                {requestDetail.data.samples.map((sample) => (
                  <Option
                    key={sample.id ?? sample.code}
                    value={sample.code}
                    text={`${sample.code} · ${sample.product}`}
                    className="dlp-intake-sample-picker__option"
                  >
                    <span className="dlp-intake-sample-picker__sample">
                      <span className="dlp-intake-sample-picker__identity">
                        <span className="dlp-intake-sample-picker__code">{sample.code}</span>
                        <span className="dlp-intake-sample-picker__product">{sample.product}</span>
                      </span>
                      {sample.status?.name ? (
                        <Badge appearance="tint" color={toneToColor(sample.status.tone)}>
                          {sample.status.name}
                        </Badge>
                      ) : null}
                    </span>
                  </Option>
                ))}
              </Dropdown>
            </Field>
          ) : null}
          {usesClerk && requestDetail.isError ? (
            <MessageBar intent="error">
              <MessageBarBody>{apiErrorMessage(requestDetail.error)}</MessageBarBody>
            </MessageBar>
          ) : null}
          <div
            style={{
              ...card,
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit,minmax(210px,1fr))",
              gap: 12,
            }}
          >
            <div>
              <span style={hintText}>Mã hồ sơ</span>
              <div className="dlp-num">{selected.requestCode}</div>
            </div>
            <div>
              <span style={hintText}>Mẫu đang đối soát</span>
              <div>
                {usesClerk ? selectedSample?.product : selected.productName}
                {receptionSampleCode ? ` · ${receptionSampleCode}` : ""}
              </div>
            </div>
            {selected.customer ? (
              <div>
                <span style={hintText}>Khách hàng</span>
                <div>{selected.customer.name}</div>
              </div>
            ) : null}
            {(usesClerk ? selectedSample?.containerNumber : selected.containerNo) ? (
              <div>
                <span style={hintText}>Container</span>
                <div className="dlp-num">
                  {usesClerk ? selectedSample?.containerNumber : selected.containerNo}
                </div>
              </div>
            ) : null}
            {(usesClerk ? selectedSample?.sealNumber : selected.sealNo) ? (
              <div>
                <span style={hintText}>Seal</span>
                <div className="dlp-num">
                  {usesClerk ? selectedSample?.sealNumber : selected.sealNo}
                </div>
              </div>
            ) : null}
            {selected.arrivedAt ? (
              <div>
                <span style={hintText}>Đến quầy</span>
                <div>{usesClerk ? formatDate(selected.arrivedAt) : selected.arrivedAt}</div>
              </div>
            ) : null}
            {/* Trạng thái mẫu là riêng từng mẫu; hồ sơ RECEIVED khi đã tiếp nhận đủ mẫu,
                và chỉ chuyển IN_TESTING khi lab nhận bàn giao. */}
            <div>
              <span style={hintText}>Trạng thái mẫu</span>
              <div>
                <Badge appearance="tint" color={toneToColor(sampleStatus?.tone ?? "info")}>
                  {sampleStatus?.name}
                </Badge>
              </div>
            </div>
            {selected.requestStatus ? (
              <div>
                <span style={hintText}>Trạng thái hồ sơ</span>
                <div>
                  <Badge appearance="tint" color={toneToColor(selected.requestStatus.tone)}>
                    {selected.requestStatus.name}
                  </Badge>
                </div>
              </div>
            ) : null}
            {selected.paymentStatus ? (
              <div>
                <span style={hintText}>Thanh toán</span>
                <div>
                  <Badge appearance="tint" color={toneToColor(selected.paymentStatus.tone)}>
                    {selected.paymentStatus.name}
                  </Badge>
                </div>
              </div>
            ) : null}
            {lastDeliver || selected.handover?.fromUser || selected.handover?.toUser ? (
              <div>
                <span style={hintText}>Bàn giao gần nhất</span>
                <div>
                  {lastDeliver?.performedBy.fullName ??
                    selected.handover?.fromUser?.fullName ??
                    lastDeliver?.performedBy.id ??
                    selected.handover?.fromUser?.id ??
                    "-"}
                  {" → "}
                  {lastDeliver?.counterpart?.fullName ??
                    selected.handover?.toUser?.fullName ??
                    lastDeliver?.counterpart?.id ??
                    selected.handover?.toUser?.id ??
                    "-"}
                </div>
              </div>
            ) : null}
          </div>

          {usesClerk && detailQuery.isLoading ? (
            <div style={{ padding: 20 }}>Đang tải bảng đối chiếu…</div>
          ) : null}
          {usesClerk && detailQuery.isError ? (
            <MessageBar intent="error">
              <MessageBarBody>{apiErrorMessage(detailQuery.error)}</MessageBarBody>
            </MessageBar>
          ) : null}

          {!usesClerk || detailQuery.data ? (
            <>
              {detailQuery.data ? (
                <div style={{ ...card, gap: 10 }}>
                  <div style={sectionTitle}>Truy xuất và biểu mẫu</div>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))",
                      gap: 8,
                    }}
                  >
                    {Object.entries(detailQuery.data.traceability).flatMap(([key, value]) =>
                      value
                        ? [
                            <div key={key}>
                              <span style={hintText}>{TRACEABILITY_LABELS[key] ?? key}</span>
                              <div>{value}</div>
                            </div>,
                          ]
                        : [],
                    )}
                  </div>
                  <div className="dlp-chiprow">
                    {detailQuery.data.formRevisions.map((form) => (
                      <Badge key={`${form.formCode}-${form.revision}`} appearance="outline">
                        {form.formCode} · {form.revision}
                        {form.effectiveDate ? ` · ${form.effectiveDate}` : ""}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}
              {beforeCounter ? (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>Mẫu chưa về tới quầy.</MessageBarTitle>
                    {` Hồ sơ đang ở «${requestStatus?.name}» - BM02/BM03 chưa được ký nên chưa có gì để đối chiếu. Bảng checklist mở ra khi khâu lấy mẫu hoàn tất.`}
                  </MessageBarBody>
                </MessageBar>
              ) : (
                <ChecklistPane
                  items={checklist}
                  drafts={drafts}
                  disabled={!canWrite || !canReceiveAction || recordReception.isPending || received}
                  fieldErrors={fieldErrors}
                  onChange={(key, value) => setDrafts((current) => ({ ...current, [key]: value }))}
                />
              )}
              <div style={{ ...card, gap: 10 }}>
                <div style={sectionTitle}>Quyết định tiếp nhận</div>
                <div style={{ display: "grid", gridTemplateColumns: "160px 1fr", gap: 8 }}>
                  <Field
                    label="Số lượng thực nhận"
                    required
                    validationState={fieldErrors["actualQuantity"] ? "error" : "none"}
                    validationMessage={fieldErrors["actualQuantity"]}
                  >
                    <Input
                      inputMode="numeric"
                      value={actualQuantity}
                      style={{ width: "100%", minWidth: 0, boxSizing: "border-box" }}
                      disabled={
                        !canWrite || !canReceiveAction || recordReception.isPending || received
                      }
                      onChange={(_, data) => setActualQuantity(data.value.replace(/[^\d]/g, ""))}
                    />
                  </Field>
                  <Field label="Ghi chú">
                    <Input
                      value={note}
                      disabled={
                        !canWrite || !canReceiveAction || recordReception.isPending || received
                      }
                      onChange={(_, data) => setNote(data.value)}
                    />
                  </Field>
                </div>
                <Checkbox
                  checked={sealIntact}
                  disabled={!canWrite || !canReceiveAction || recordReception.isPending || received}
                  label="Tem niêm phong còn nguyên vẹn"
                  onChange={(_, data) => setSealIntact(data.checked === true)}
                />
                <Field
                  label="Lý do (bắt buộc khi lệch, tạm giữ hoặc từ chối)"
                  validationState={fieldErrors["reason"] ? "error" : "none"}
                  validationMessage={fieldErrors["reason"]}
                >
                  <Textarea
                    rows={2}
                    value={reason}
                    disabled={
                      !canWrite || !canReceiveAction || recordReception.isPending || received
                    }
                    onChange={(_, data) => setReason(data.value)}
                  />
                </Field>
                {selected.paymentStatus ? (
                  <MessageBar intent="info">
                    <MessageBarBody>
                      <MessageBarTitle>Thanh toán được theo dõi riêng.</MessageBarTitle>
                      {` Trạng thái hiện tại: «${selected.paymentStatus.name}». Tiếp nhận tại một cửa không bị chặn bởi thanh toán; lab vẫn kiểm tra điều kiện thanh toán khi nhận mẫu.`}
                    </MessageBarBody>
                  </MessageBar>
                ) : null}
                {recordReception.error ? (
                  <MessageBar intent="error">
                    <MessageBarBody>{apiErrorMessage(recordReception.error)}</MessageBarBody>
                  </MessageBar>
                ) : null}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <PermissionButton
                    allowed={canWrite && canReceiveAction}
                    size="large"
                    disabled={recordReception.isPending || received || !reason.trim()}
                    onClick={() => submitReception("HOLD")}
                  >
                    Tạm giữ mẫu
                  </PermissionButton>
                  <PermissionButton
                    allowed={canWrite && canReceiveAction}
                    appearance="outline"
                    size="large"
                    disabled={recordReception.isPending || received || !reason.trim()}
                    onClick={() => submitReception("REJECT")}
                  >
                    Từ chối tiếp nhận
                  </PermissionButton>
                  <PermissionButton
                    allowed={canWrite && canReceiveAction}
                    appearance="primary"
                    size="large"
                    disabled={
                      recordReception.isPending ||
                      received ||
                      !allObserved ||
                      !Number.isInteger(quantity) ||
                      quantity <= 0 ||
                      (!sealIntact && !reason.trim())
                    }
                    onClick={() => submitReception("ACCEPT")}
                  >
                    Tiếp nhận mẫu
                  </PermissionButton>
                </div>
              </div>
            </>
          ) : null}

          {received && parentSampleCode && canPrintAction ? (
            <ParentLabelCard
              title="In tem mã mẫu"
              requestCode={parentSampleCode}
              productName={usesClerk ? selectedSample?.product : selected.productName}
              disabled={!canPrintParent}
            />
          ) : null}

          {/* Hết phần việc của quầy. Lượt giao - nhận nằm ở màn Bàn giao, nên chỉ dẫn đường sang
              đó thay vì dựng lại thao tác quét ở đây. */}
          {received ? (
            <MessageBar intent="success">
              <MessageBarBody>
                {/* Chia mã con không còn xảy ra ở bước này (máy chủ chỉ nhận lệnh chia sau khi
                    lab đã nhận mẫu), nên câu mặc định phải đứng vững một mình - ghép chuỗi kiểu
                    cũ cho ra đúng chữ "Đã tiếp nhận ." với một khoảng trắng thừa. */}
                <MessageBarTitle>Đã tiếp nhận.</MessageBarTitle> Dán tem lên từng mẫu rồi bàn giao
                tại{" "}
                <Link to="/ban-giao" style={{ fontWeight: 600 }}>
                  Bàn giao vào lab
                </Link>
                ; quét mã của từng mẫu để ghi nhận bàn giao.
              </MessageBarBody>
            </MessageBar>
          ) : null}

          {changeRequest && changeRequest.fields.length > 0 ? (
            <ChangeRequestCard
              cr={changeRequest}
              picked={changePicked}
              decision={crDecision}
              disabled={!canWrite}
              readOnly={usesClerk}
              onToggleField={() => undefined}
              onApprove={() => {
                setCrDecision("ok");
                toast("Đã duyệt đề nghị sửa", "Thông tin hồ sơ đã được cập nhật.");
              }}
              onReject={() => {
                setCrDecision("no");
                toast("Đã từ chối đề nghị sửa", "Trạng thái hồ sơ đã được cập nhật.", "warning");
              }}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
