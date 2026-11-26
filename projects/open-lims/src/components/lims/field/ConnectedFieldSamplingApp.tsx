import { useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  Checkbox,
  Field,
  Input,
  Label,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  Textarea,
} from "@fluentui/react-components";
import { ArrowLeft20Regular } from "@fluentui/react-icons";
import { apiErrorMessage, uploadFile, useApiClient } from "@/lib/api";
import {
  samplingApi,
  reconciliationFields,
  useAssignment,
  useAssignments,
  useChangeRequests,
  useSamplingMutation,
  type ApprovalInput,
  type Bm02Input,
  type Bm03Input,
  type FieldChangeRequest,
  type ReconciliationField,
  type ReconciliationItem,
  type SamplingAssignmentDetail,
} from "@/features/sampling";
import { toneToColor } from "@/lib/admin/tone";
import { useDlpToast } from "@/components/lims/common/toast";
import { SignaturePad } from "./SignaturePad";
import { FieldUserMenu } from "./FieldUserMenu";
import { FilePicker } from "./FilePicker";
import { card, cardTitle, secondary } from "./field-styles";
import { FieldSurfaceNav } from "./FieldSurfaceNav";
import { AssignmentFilterSheet } from "./AssignmentFilterSheet";
import { EMPTY_FILTER, filterAssignments, type AssignmentFilter } from "./assignment-filter";
import { formatClock } from "@/lib/format";
import { AppLogo, FieldLabel } from "@/components/lims/common";

const labels: Record<ReconciliationField, string> = {
  productName: "Tên sản phẩm",
  growingAreaCode: "Mã vùng trồng",
  packingHouseCode: "Mã cơ sở đóng gói",
  vehiclePlate: "Biển số xe",
  containerNo: "Số container",
  trailerNo: "Số rơ-moóc",
  sealNo: "Số seal",
};
const now = () => new Date().toISOString();
/** Số lượng thực lấy do người lấy mẫu nhập; rỗng, không phải số hoặc ≤ 0 đều là chưa hợp lệ
 * (backend chặn `quantity <= 0` trên từng dòng mẫu BM03/BM02). */
const parseQuantity = (raw: string) => {
  const value = Number(raw.trim());
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

export function ConnectedFieldSamplingApp({
  canManage,
  initialRequestCode,
  initialSampleCode,
}: {
  canManage: boolean;
  initialRequestCode?: string;
  initialSampleCode?: string;
}) {
  const api = useApiClient();
  const toast = useDlpToast();
  const [surface, setSurface] = useState<"field" | "manager">("field");
  const [assignmentPage, setAssignmentPage] = useState(1);
  const [changePage, setChangePage] = useState(1);
  const [selected, setSelected] = useState<string>();
  const list = useAssignments({ page: assignmentPage, size: 50 }, surface === "field");
  const detail = useAssignment(selected);
  const changes = useChangeRequests(
    { status: "PENDING", page: changePage, size: 50 },
    surface === "manager" && canManage,
  );
  const [filter, setFilter] = useState<AssignmentFilter>(EMPTY_FILTER);
  const items = useMemo(() => list.data?.content ?? [], [list.data]);
  const visibleItems = useMemo(() => filterAssignments(items, filter), [items, filter]);
  const [actual, setActual] = useState<Partial<Record<string, string>>>({});
  const [verdicts, setVerdicts] = useState<Partial<Record<string, "MATCH" | "MISMATCH">>>({});
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState<File[]>([]);
  const [sealPhotos, setSealPhotos] = useState<File[]>([]);
  // `SamplingAssignmentResource` ghi rõ `quantityUnit` luôn null (`ops.test_request` không có đơn vị
  // tính riêng cho từng hồ sơ), nhưng BM03/BM02 lại ghi số lượng nên phải có đơn vị. Người lấy mẫu
  // là người biết đơn vị thực tế - hỏi ngay trên biểu mẫu thay vì đẩy null xuống API (backend trả
  // 500 với null).
  const [quantityUnit, setQuantityUnit] = useState("");
  // Số ghi trên BM03/BM02 là số **thực lấy** tại hiện trường, không phải số dự kiến khai ở BM01
  // (`expectedQuantity` là trường tuỳ chọn, hồ sơ không khai thì null). Trước đây form đẩy thẳng
  // `expectedQuantity` xuống API nên hồ sơ không khai bị chặn cứng ở bước chốt BM03 (422, "Phải > 0")
  // mà không có ô nào để sửa. Hỏi người lấy mẫu, chỉ điền sẵn khi hồ sơ có khai.
  const [quantity, setQuantity] = useState("");
  const [sampleQuantities, setSampleQuantities] = useState<
    Record<string, { quantity: string; unit: string }>
  >({});
  const [sampleLookup, setSampleLookup] = useState("");
  const [bm03SamplerSign, setBm03SamplerSign] = useState<Blob>();
  const [bm02SamplerSign, setBm02SamplerSign] = useState<Blob>();
  const [customerSign, setCustomerSign] = useState<Blob>();
  const [customerName, setCustomerName] = useState("");
  const [criteria, setCriteria] = useState({
    representative: false,
    sealedOnSite: false,
    preserved: false,
  });
  const mutate = useSamplingMutation<{ run: () => Promise<unknown>; success: string }>((_, v) =>
    v.run(),
  );
  const assignment = detail.data;
  const hydratedAssignment = useRef<string | undefined>(undefined);

  const selectAssignment = (code?: string) => {
    hydratedAssignment.current = undefined;
    setSelected(code);
    setActual({});
    setVerdicts({});
    setReason("");
    setEvidence([]);
    setSealPhotos([]);
    setBm03SamplerSign(undefined);
    setBm02SamplerSign(undefined);
    setCustomerSign(undefined);
    setCustomerName("");
    setCriteria({ representative: false, sealedOnSite: false, preserved: false });
  };

  // Mở màn từ chi tiết hồ sơ (`/lay-mau?code=…`): `assignment_code == test_request.code` theo
  // thiết kế (AssignSamplingService "Decision 5", UNIQUE(tenant_id, assignment_code)) nên mã hồ
  // sơ CHÍNH LÀ mã lượt - mở thẳng bằng `GET /sampling-assignments/{code}`, không cần dò trong
  // "Lượt của tôi" (list đó chỉ trả lượt CỦA NGƯỜI GỌI, trang hiện tại - trước đây dò qua đó nên
  // hồ sơ đã lấy mẫu xong/không phải người đang xem báo "không tìm thấy" dù lượt vẫn tồn tại).
  // `/lay-mau` đã bắt buộc quyền `SAMPLING_READ` (xem `lay-mau.tsx`), đủ điều kiện "manager reach"
  // để backend cho xem bất kỳ lượt nào trong tenant, không chỉ lượt của chính mình.
  const appliedRequestCode = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!initialRequestCode || appliedRequestCode.current === initialRequestCode) return;
    appliedRequestCode.current = initialRequestCode;
    selectAssignment(initialRequestCode);
  }, [initialRequestCode]);

  useEffect(() => {
    if (!initialSampleCode) return;
    setSampleLookup(initialSampleCode);
    void samplingApi
      .resolve(api, initialSampleCode)
      .then((resolved) => {
        selectAssignment(resolved.assignmentCode);
      })
      .catch((error) =>
        toast("Không thể mở mẫu", error instanceof Error ? error.message : String(error), "error"),
      );
  }, [initialSampleCode, api, toast]);

  /**
   * Việc đang chạy (`"bm03"`, `"approve:42"`...), `undefined` khi rảnh. Vừa là khoá chống bấm
   * hai lần, vừa là nguồn để đúng nút vừa bấm quay chứ không phải cả màn.
   */
  const [busyAction, setBusyAction] = useState<string>();
  /**
   * Khoá thật nằm ở ref, không ở state.
   *
   * Hai lần chạm cách nhau vài chục mili-giây rơi vào cùng một lượt render: cả hai đều đọc
   * `busyAction` là `undefined`, cả hai đều chạy. Ngón tay trên màn cảm ứng ngoài nắng làm việc
   * đó thường xuyên, và với BM03 thì cái giá là hai bộ ảnh tem tải lên rồi hai lần chốt biên bản.
   */
  const busyRef = useRef(false);
  /**
   * Toàn bộ phần việc của một thao tác chạy TRONG `run`, kể cả tải ảnh và lấy toạ độ.
   *
   * Trước đây các bước đó đứng ngoài, trước `mutateAsync`: `isPending` chỉ bật lên sau khi ảnh đã
   * tải xong, nên đúng quãng lâu nhất - vài chục giây đẩy ảnh qua 4G - lại là quãng mọi nút vẫn
   * bấm được và màn hình không hề báo đang bận.
   */
  const act = async (action: string, success: string, run: () => Promise<unknown>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusyAction(action);
    try {
      await mutate.mutateAsync({ run, success });
      toast(success);
    } catch (error) {
      toast(apiErrorMessage(error), undefined, "error");
    } finally {
      busyRef.current = false;
      setBusyAction(undefined);
    }
  };
  const geo = () =>
    new Promise<{ lat: number; lng: number } | undefined>((resolve) => {
      if (!navigator.geolocation) return resolve(undefined);
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => resolve(undefined),
        { timeout: 5000 },
      );
    });
  const upload = async (files: Array<File | Blob>, grant: string) =>
    Promise.all(
      files.map(
        async (file, index) =>
          (
            await uploadFile(api, file, {
              grant,
              fileName: file instanceof File ? file.name : `signature-${index + 1}.png`,
            })
          ).id,
      ),
    );
  /**
   * Số lượng đã chốt trên BM03 của chính lượt này, đọc từ máy chủ.
   *
   * BM03 và BM02 nói về CÙNG một lần lấy mẫu, nên hai biên bản không được mang hai con số. Trước
   * đây màn BM02 hỏi lại số lượng + đơn vị ở dạng nhập được: gõ lệch một chữ số là hai biên bản
   * mâu thuẫn nhau vĩnh viễn, mà bước tiếp nhận sau đó lại đối soát chúng như hai hạng mục độc
   * lập nên không màn nào phát hiện ra. Có BM03 rồi thì đây là nguồn duy nhất; muốn sửa thì phải
   * sửa BM03.
   */
  useEffect(() => {
    if (!assignment) return;
    setSampleQuantities(
      Object.fromEntries(
        assignment.samples.map((sample) => {
          const line = assignment.bm03?.sampleLines.find(
            (line) => line.sampleCode === sample.sampleCode && !line.retained,
          );
          return [
            sample.sampleCode,
            {
              quantity: line
                ? String(line.quantity)
                : sample.expectedQuantity == null
                  ? ""
                  : String(sample.expectedQuantity),
              unit: line?.quantityUnit ?? sample.quantityUnit ?? "",
            },
          ];
        }),
      ),
    );
  }, [assignment?.assignmentCode, assignment?.bm03]);
  // Khi mở lại lượt đang chờ duyệt, hiển thị đúng kết quả đối soát đã lưu thay vì dựng lại
  // trạng thái rỗng. Chỉ hydrate khi đổi lượt để không ghi đè phần người dùng đang nhập.
  useEffect(() => {
    if (!assignment || hydratedAssignment.current === assignment.assignmentCode) return;
    const saved = assignment.reconciliation;
    if (!saved) return;
    hydratedAssignment.current = assignment.assignmentCode;
    setActual(
      Object.fromEntries(
        saved.items.map((item) => [`${item.sampleCode}:${item.field}`, item.actualValue]),
      ),
    );
    setVerdicts(
      Object.fromEntries(
        saved.items.map((item) => [`${item.sampleCode}:${item.field}`, item.verdict]),
      ),
    );
    setReason(saved.reason ?? "");
  }, [assignment]);
  // Hồ sơ không khai số rơ-moóc / số seal thì API trả `null`. Quy về chuỗi rỗng ngay tại đây:
  // để `null` đi tiếp thì nhãn in ra chữ "null" và ô nhập thành uncontrolled input.
  const rows = useMemo(
    () =>
      assignment
        ? assignment.samples.flatMap((sample) =>
            reconciliationFields.map((field) => {
              const key = `${sample.sampleCode}:${field}`;
              const original = sample.declaration[field] ?? "";
              const actualValue = actual[key] ?? original;
              return {
                sampleCode: sample.sampleCode,
                sampleName: sample.declaration.productName ?? "",
                key,
                field,
                original,
                actual: actualValue,
                verdict: verdicts[key],
                autoMatched: !original.trim() && !actualValue.trim(),
              };
            }),
          )
        : [],
    [assignment, actual, verdicts],
  );
  const pending = assignment?.status.code === "CHANGE_PENDING";

  /* Bảy ô Khớp/Lệch trông giống hệt nhau nên bỏ sót một ô là chuyện thường; bộ đếm dừng ở 6/7 mà
     không chỉ ra thiếu ô NÀO thì người lấy mẫu phải dò tay từng ô giữa hiện trường. Bật cờ này
     để tô đỏ đúng những ô còn thiếu, kèm cuộn tới ô đầu tiên. */
  const [showMissing, setShowMissing] = useState(false);

  const reconcile = async () => {
    const missing = rows.filter((row) => !row.autoMatched && !row.verdict);
    if (!assignment || missing.length) {
      setShowMissing(true);
      const first = missing[0];
      if (first) {
        document
          .getElementById(`recon-${first.key}`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      return toast(
        "Chưa đối soát đủ các trường",
        missing.length
          ? `Còn thiếu: ${missing.map((row) => labels[row.field]).join(", ")}.`
          : "Hãy chọn Khớp hoặc Lệch cho từng trường có khai báo.",
        "warning",
      );
    }
    setShowMissing(false);
    const items = rows.map(({ sampleCode, field, actual: actualValue, verdict, autoMatched }) => ({
      sampleCode,
      field,
      actualValue,
      verdict: verdict ?? (autoMatched ? "MATCH" : undefined)!,
    })) as ReconciliationItem[];
    const mismatches = items.filter((item) => item.verdict === "MISMATCH");
    if (mismatches.length && !reason.trim())
      return toast("Cần nhập lý do sai lệch", undefined, "warning");
    await act("reconcile", "Đã gửi kết quả đối soát", async () => {
      /* Ô "Ảnh bằng chứng" nằm ngay trên nút này và báo "đã chọn" sau khi chọn tệp, nên ảnh phải
         đi cùng biên bản đối soát. Trước đây `reconcile` bỏ qua nó - với hồ sơ có trường lệch thì
         đó là mất bằng chứng nghiệp vụ, mà người lấy mẫu không hề được báo. */
      const attachmentIds = evidence.length
        ? await upload(evidence, "sampling:reconciliation")
        : [];
      return samplingApi.reconcile(api, assignment.assignmentCode, {
        items,
        conclusion: mismatches.length ? "NOT_CONFORMED" : "CONFORMED",
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        ...(attachmentIds.length ? { attachmentIds } : {}),
      });
    });
  };
  const requestChange = async () => {
    if (!assignment) return;
    const mismatch = rows.filter((r) => r.verdict === "MISMATCH");
    if (!reason.trim() || !evidence.length || !mismatch.length)
      return toast(
        "Đề nghị chưa đủ thông tin",
        "Cần trường lệch, lý do và ít nhất một ảnh bằng chứng.",
        "warning",
      );
    await act("request-change", "Đã gửi đề nghị; lượt đang chờ quản lý duyệt", async () => {
      const attachmentIds = await upload(evidence, "sampling:change-request");
      return samplingApi.requestChange(api, assignment.assignmentCode, {
        fields: mismatch.map((r) => ({
          sampleCode: r.sampleCode,
          field: r.field,
          oldValue: r.original,
          newValue: r.actual,
        })),
        reason: reason.trim(),
        attachmentIds,
      });
    });
  };
  const submitBm03 = async () => {
    const validQuantities = assignment?.samples.every(
      (s) =>
        parseQuantity(sampleQuantities[s.sampleCode]?.quantity ?? "") !== undefined &&
        Boolean(sampleQuantities[s.sampleCode]?.unit),
    );
    if (
      !assignment ||
      !bm03SamplerSign ||
      sealPhotos.length < 2 ||
      !validQuantities ||
      Object.values(criteria).some((v) => !v)
    )
      return toast(
        "BM03 chưa đủ",
        "Xác nhận 3 tiêu chí, số lượng thực lấy, đơn vị tính, 2 ảnh tem và chữ ký trên màn.",
        "warning",
      );
    await act("bm03", "Đã lập BM03", async () => {
      const [sealPhotoIds, signatureIds] = await Promise.all([
        upload(sealPhotos, "sampling:seal-photo"),
        upload([bm03SamplerSign], "sampling:signature"),
      ]);
      const lines = assignment.samples.flatMap((sample) =>
        sample.testParameters.map((parameter, index) => ({
          sampleCode: sample.sampleCode,
          index: index + 1,
          parameterCode: parameter.code,
          quantity: parseQuantity(sampleQuantities[sample.sampleCode]!.quantity)!,
          quantityUnit: sampleQuantities[sample.sampleCode]!.unit,
          retained: false,
        })),
      );
      const body: Bm03Input = {
        samplingCriteria: criteria,
        sampleLines: lines,
        sealPhotoIds,
        samplerSignature: { method: "CANVAS", imageDocumentId: signatureIds[0]! },
      };
      return samplingApi.bm03(api, assignment.assignmentCode, body);
    });
  };
  const submitBm02 = async () => {
    const validQuantities = assignment?.samples.every(
      (s) =>
        parseQuantity(sampleQuantities[s.sampleCode]?.quantity ?? "") !== undefined &&
        Boolean(sampleQuantities[s.sampleCode]?.unit),
    );
    if (
      !assignment ||
      !bm02SamplerSign ||
      !customerSign ||
      !customerName.trim() ||
      !validQuantities
    )
      return toast(
        "BM02 chưa đủ xác nhận",
        "Cần số lượng thực lấy, đơn vị tính, chữ ký trên màn của hai bên và tên đại diện khách.",
        "warning",
      );
    await act("bm02", "Đã ký và hoàn tất BM02", async () => {
      const [samplerId, customerId] = await upload(
        [bm02SamplerSign, customerSign],
        "sampling:signature",
      );
      const location = await geo();
      const body: Bm02Input = {
        startedAt: now(),
        finishedAt: now(),
        samplingMethod: "TCVN 9017:2011",
        sampleLines: assignment.samples.map((sample) => ({
          sampleCode: sample.sampleCode,
          index: 1,
          sampleName: sample.declaration.productName ?? "",
          growingAreaCode: sample.declaration.growingAreaCode,
          packingHouseCode: sample.declaration.packingHouseCode,
          containerNo: sample.declaration.containerNo,
          vehiclePlate: sample.declaration.vehiclePlate,
          trailerNo: sample.declaration.trailerNo,
          quantity: parseQuantity(sampleQuantities[sample.sampleCode]!.quantity)!,
          quantityUnit: sampleQuantities[sample.sampleCode]!.unit,
          parameterCodes: sample.testParameters.map((p) => p.code),
        })),
        samplerSignature: { method: "CANVAS", imageDocumentId: samplerId! },
        customerSignature: {
          method: "CANVAS",
          imageDocumentId: customerId!,
          signerName: customerName.trim(),
        },
        ...(location ? { location } : {}),
      };
      return samplingApi.bm02(api, assignment.assignmentCode, body);
    });
  };

  const openAssignment = async () => {
    if (!assignment) return;
    await act("open", "Đã mở lượt", async () => {
      const location = await geo();
      return samplingApi.open(api, assignment.assignmentCode, {
        openedAt: now(),
        ...(location ? { location } : {}),
      });
    });
  };

  const assignmentStage = assignment?.allowedActions.includes("sampling:bm02")
    ? "bm02"
    : assignment?.allowedActions.includes("sampling:bm03")
      ? "bm03"
      : assignment?.allowedActions.some((action) =>
            [
              "sampling:open",
              "sampling:reconcile",
              "sampling:reject",
              "sampling:request-change",
            ].includes(action),
          ) || pending
        ? "check"
        : "done";
  const title =
    surface === "manager"
      ? "Duyệt thay đổi"
      : !selected
        ? "Lượt của tôi"
        : assignmentStage === "bm03"
          ? "BM03 · Tem & tiêu chí"
          : assignmentStage === "bm02"
            ? "BM02 · Ký xác nhận"
            : assignmentStage === "done"
              ? `Hoàn tất · ${selected}`
              : `Đối soát · ${selected}`;

  return (
    <main className="dlp-field">
      <header className="dlp-field__bar">
        {surface === "field" && selected ? (
          <button
            type="button"
            className="dlp-field__back"
            aria-label="Quay lại danh sách lượt"
            onClick={() => selectAssignment(undefined)}
          >
            <ArrowLeft20Regular />
          </button>
        ) : null}
        <AppLogo size={24} variant="on-accent" />
        <span className="dlp-field__title">{title}</span>
        <span style={{ flex: 1 }} />
        {surface === "manager" ? (
          <span className="dlp-field__meta">{changes.data?.page.totalElements ?? 0} đề nghị</span>
        ) : !selected ? (
          <span className="dlp-field__meta">{list.data?.page.totalElements ?? 0} lượt</span>
        ) : assignment ? (
          <Badge appearance="tint" color={toneToColor(assignment.status.tone)} size="small">
            {assignment.status.name}
          </Badge>
        ) : null}
        <FieldUserMenu />
      </header>

      {surface === "field" && !selected && items.length ? (
        <div className="dlp-field__filterbar">
          <AssignmentFilterSheet items={items} filter={filter} onChange={setFilter} />
        </div>
      ) : null}

      {/* Đệm đáy cố định: thanh tab `position: fixed` che mất phần cuối nội dung, và phần cuối
          của BM03/BM02 chính là nút chốt biên bản. */}
      <div className="dlp-field__body" style={{ paddingBottom: 80 }}>
        {surface === "field" ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act("resolve", "Đã tìm lượt lấy mẫu", async () => {
                const result = await samplingApi.resolve(api, sampleLookup.trim());
                setSelected(result.assignmentCode);
              });
            }}
            style={card}
          >
            <Field label="Nhập hoặc quét mã mẫu">
              <Input value={sampleLookup} onChange={(_, d) => setSampleLookup(d.value)} />
            </Field>
            <Button type="submit" disabled={!sampleLookup.trim() || pending}>
              Tìm lượt theo mã mẫu
            </Button>
          </form>
        ) : null}
        {!navigator.onLine ? (
          <MessageBar intent="error">
            <MessageBarBody>
              <MessageBarTitle>Không có kết nối Internet</MessageBarTitle>Dữ liệu nhập chưa được lưu
              lên hệ thống. Kết nối lại rồi thử gửi lại; ứng dụng không tạo hồ sơ ngoại tuyến.
            </MessageBarBody>
          </MessageBar>
        ) : null}

        {surface === "manager" ? (
          <ManagerQueue
            items={changes.data?.content ?? []}
            page={changes.data?.page}
            currentPage={changePage}
            onPage={setChangePage}
            loading={changes.isLoading}
            error={changes.error}
            busyAction={busyAction}
            onAct={act}
            api={api}
          />
        ) : selected && detail.isLoading ? (
          <Spinner label="Đang tải lượt…" />
        ) : selected && detail.isError ? (
          <MessageBar intent="error">
            <MessageBarBody>
              <MessageBarTitle>Không tải được lượt</MessageBarTitle>
              {/* Backend trả chung 403 cho cả "lượt không tồn tại" lẫn "không có quyền xem" (anti-
                  enumeration cố ý, `ApplicationException.forbidden()`) - khi mở từ chi tiết hồ sơ
                  (`?code=`) thì gộp cả 2 khả năng vào 1 câu, không suy diễn quá cụ thể. */}
              {selected === initialRequestCode
                ? "Hồ sơ này chưa có lượt lấy mẫu nào được tạo, hoặc bạn không có quyền xem."
                : apiErrorMessage(detail.error)}
            </MessageBarBody>
          </MessageBar>
        ) : selected && assignment ? (
          <AssignmentView
            assignment={assignment}
            pending={pending}
            rows={rows}
            actual={actual}
            verdicts={verdicts}
            reason={reason}
            evidenceCount={evidence.length}
            criteria={criteria}
            quantityUnit={quantityUnit}
            quantity={quantity}
            sampleQuantities={sampleQuantities}
            setSampleQuantities={setSampleQuantities}
            busyAction={busyAction}
            setActual={setActual}
            setVerdicts={setVerdicts}
            setReason={setReason}
            setCriteria={setCriteria}
            setEvidence={setEvidence}
            setQuantityUnit={setQuantityUnit}
            setQuantity={setQuantity}
            setSealPhotos={setSealPhotos}
            setBm03SamplerSign={setBm03SamplerSign}
            setBm02SamplerSign={setBm02SamplerSign}
            setCustomerSign={setCustomerSign}
            customerName={customerName}
            setCustomerName={setCustomerName}
            open={openAssignment}
            reconcile={reconcile}
            showMissing={showMissing}
            requestChange={requestChange}
            bm03={submitBm03}
            bm02={submitBm02}
            reject={() =>
              act("reject", "Đã kết thúc lượt lấy mẫu", async () =>
                samplingApi.rejectSampling(
                  api,
                  assignment.assignmentCode,
                  reason.trim(),
                  await upload(evidence, "sampling:rejection"),
                ),
              )
            }
          />
        ) : list.isLoading ? (
          <Spinner label="Đang tải lượt…" />
        ) : list.isError ? (
          <MessageBar intent="error">
            <MessageBarBody>
              <MessageBarTitle>Không tải được danh sách</MessageBarTitle>
              {apiErrorMessage(list.error)}
            </MessageBarBody>
          </MessageBar>
        ) : (
          <>
            {visibleItems.map((item) => (
              <button
                key={item.assignmentCode}
                type="button"
                style={{ ...card, textAlign: "left", cursor: "pointer" }}
                onClick={() => selectAssignment(item.assignmentCode)}
              >
                <span style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <strong style={{ fontSize: 16, fontVariantNumeric: "tabular-nums" }}>
                    {item.assignmentCode}
                  </strong>
                  <span style={{ flex: 1 }} />
                  <span style={secondary}>{formatClock(item.scheduledTime)}</span>
                </span>
                <span style={{ font: "14px/20px var(--font-family-base)" }}>
                  {item.productName}
                </span>
                <span style={secondary}>{item.location}</span>
                <span>
                  <Badge appearance="tint" color={toneToColor(item.status.tone)} size="small">
                    {item.status.name}
                  </Badge>
                </span>
                {item.testParameters.length ? (
                  <span style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    {item.testParameters.slice(0, 2).map((parameter) => (
                      <Badge key={parameter.code} appearance="tint" color="brand" size="small">
                        {parameter.name || parameter.code}
                      </Badge>
                    ))}
                    {item.testParameters.length > 2 ? (
                      <Badge appearance="outline" color="subtle" size="small">
                        +{item.testParameters.length - 2}
                      </Badge>
                    ) : null}
                  </span>
                ) : null}
              </button>
            ))}
            {items.length && !visibleItems.length ? (
              <div style={card}>Không có lượt nào khớp bộ lọc.</div>
            ) : null}
            {list.data ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <Button
                  disabled={assignmentPage <= 1}
                  onClick={() => setAssignmentPage((page) => page - 1)}
                >
                  Trước
                </Button>
                <span style={{ ...secondary, flex: 1, textAlign: "center" }}>
                  Trang {list.data.page.number}/{list.data.page.totalPages || 1}
                </span>
                <Button
                  disabled={assignmentPage >= list.data.page.totalPages}
                  onClick={() => setAssignmentPage((page) => page + 1)}
                >
                  Sau
                </Button>
              </div>
            ) : null}
            {!items.length ? <div style={card}>Hôm nay chưa có lượt nào.</div> : null}
          </>
        )}
      </div>
      <FieldSurfaceNav
        surface={surface}
        canManage={canManage}
        onSurface={(next) => {
          selectAssignment(undefined);
          setSurface(next);
        }}
      />
    </main>
  );
}

type Rows = Array<{
  sampleCode: string;
  sampleName: string;
  key: string;
  field: ReconciliationField;
  original: string;
  actual: string;
  verdict: "MATCH" | "MISMATCH" | undefined;
  /** Hồ sơ không khai và hiện trường cũng trống - không có gì để so, tự ghi nhận là khớp. */
  autoMatched: boolean;
}>;
/** Số lượng thực lấy + đơn vị tính, dùng chung cho mọi dòng mẫu của BM03 và BM02. Đứng ở cả hai
 *  biểu mẫu vì người lấy mẫu có thể mở lại lượt ở trạng thái `SAMPLED` (mất state của BM03) mà vẫn
 *  phải gửi được số lượng khi ký BM02. */
function QuantityFields(p: {
  expectedQuantity: number | null;
  quantity: string;
  quantityUnit: string;
  setQuantity: (v: string) => void;
  setQuantityUnit: (v: string) => void;
  /** Bật ở BM02 khi BM03 đã chốt: hiển thị con số kế thừa, không cho gõ đè. */
  inheritedFrom?: string;
}) {
  const locked = !!p.inheritedFrom;
  // Ô nhập bị `disabled` làm chữ xám đi, nên giá trị kế thừa ("5", "quả") trông y hệt chữ gợi ý
  // của ô trống - người dùng nhìn thoáng tưởng chưa điền. Đã chốt ở BM03 rồi thì đây không còn là
  // ô nhập nữa: in thẳng ra giá trị, đậm, hết chỗ hiểu nhầm.
  if (locked) {
    return (
      <>
        <Field
          label={
            <FieldLabel
              label="Số lượng thực lấy"
              tooltip={`Kế thừa từ ${p.inheritedFrom} · sửa ở ${p.inheritedFrom}`}
            />
          }
        >
          <strong>{p.quantity || "-"}</strong>
        </Field>
        <Field label={<FieldLabel label="Đơn vị tính" tooltip={`Kế thừa từ ${p.inheritedFrom}`} />}>
          <strong>{p.quantityUnit || "-"}</strong>
        </Field>
      </>
    );
  }
  return (
    <>
      <Field
        label={
          <FieldLabel
            label="Số lượng thực lấy"
            tooltip={`Áp dụng cho mọi dòng mẫu · hồ sơ khai dự kiến: ${p.expectedQuantity ?? "không khai"}`}
          />
        }
        required
      >
        <Input
          type="number"
          min={1}
          value={p.quantity}
          onChange={(_, d) => p.setQuantity(d.value)}
        />
      </Field>
      <Field label={<FieldLabel label="Đơn vị tính" tooltip="Theo thực tế lấy mẫu" />} required>
        <Input
          value={p.quantityUnit}
          placeholder="Ví dụ: quả, kg, g"
          onChange={(_, d) => p.setQuantityUnit(d.value)}
        />
      </Field>
    </>
  );
}
/**
 * Nút của một thao tác gửi lên máy chủ.
 *
 * Khoá cả cụm khi có việc đang chạy - hai thao tác của cùng một lượt không được chồng lên nhau -
 * nhưng chỉ nút vừa bấm mới quay và đổi chữ, để người dùng biết cái nào đang chạy chứ không nhìn
 * một màn hình xám đều. Chữ khi chạy nói rõ đang làm gì ("Đang tải ảnh lên…") vì phần lâu nhất
 * của các thao tác này là đẩy ảnh qua sóng di động, không phải chờ máy chủ tính toán.
 */
function ActionButton({
  action,
  busyAction,
  label,
  runningLabel,
  onClick,
  appearance,
  size,
  disabled,
}: {
  action: string;
  busyAction?: string;
  label: string;
  runningLabel: string;
  onClick: () => void;
  appearance?: "primary" | "secondary";
  size?: "large";
  disabled?: boolean;
}) {
  const running = busyAction === action;
  return (
    <Button
      appearance={appearance}
      size={size}
      disabled={disabled || busyAction !== undefined}
      icon={running ? <Spinner size="tiny" /> : undefined}
      onClick={onClick}
    >
      {running ? runningLabel : label}
    </Button>
  );
}

function AssignmentView(p: {
  assignment: SamplingAssignmentDetail;
  pending: boolean;
  rows: Rows;
  actual: Partial<Record<string, string>>;
  verdicts: Partial<Record<string, "MATCH" | "MISMATCH">>;
  reason: string;
  evidenceCount: number;
  criteria: { representative: boolean; sealedOnSite: boolean; preserved: boolean };
  quantityUnit: string;
  quantity: string;
  sampleQuantities: Record<string, { quantity: string; unit: string }>;
  setSampleQuantities: React.Dispatch<
    React.SetStateAction<Record<string, { quantity: string; unit: string }>>
  >;
  busyAction?: string;
  customerName: string;
  setActual: React.Dispatch<React.SetStateAction<Partial<Record<string, string>>>>;
  setVerdicts: React.Dispatch<React.SetStateAction<Partial<Record<string, "MATCH" | "MISMATCH">>>>;
  setReason: (s: string) => void;
  setCriteria: React.Dispatch<
    React.SetStateAction<{ representative: boolean; sealedOnSite: boolean; preserved: boolean }>
  >;
  setEvidence: (f: File[]) => void;
  setQuantityUnit: (v: string) => void;
  setQuantity: (v: string) => void;
  setSealPhotos: (f: File[]) => void;
  setBm03SamplerSign: (b?: Blob) => void;
  setBm02SamplerSign: (b?: Blob) => void;
  setCustomerSign: (b?: Blob) => void;
  setCustomerName: (s: string) => void;
  open: () => void;
  reconcile: () => void;
  /** Đã bấm Gửi mà còn ô chưa chọn: tô đỏ những ô đó. */
  showMissing: boolean;
  requestChange: () => void;
  bm03: () => void;
  bm02: () => void;
  reject: () => void;
}) {
  const a = p.assignment;
  const mismatchCount = p.rows.filter((row) => row.verdict === "MISMATCH").length;
  const canReconcile = a.allowedActions.some((action) =>
    ["sampling:reconcile", "sampling:reject", "sampling:request-change"].includes(action),
  );
  const hasWorkflowAction = a.allowedActions.some((action) =>
    [
      "sampling:open",
      "sampling:reconcile",
      "sampling:reject",
      "sampling:request-change",
      "sampling:bm03",
      "sampling:bm02",
    ].includes(action),
  );
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={card}>
        <strong style={cardTitle}>
          {a.assignmentCode} · {a.productName}
        </strong>
        <span style={secondary}>
          {a.location} · {formatClock(a.scheduledTime)}
        </span>
        <span>
          <Badge appearance="tint" color={toneToColor(a.status.tone)} size="small">
            {a.status.name}
          </Badge>
        </span>
      </div>
      {p.pending ? (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Lượt đang khoá chờ duyệt thay đổi</MessageBarTitle>Đang chờ Quản lý Bộ
            phận một cửa. Dữ liệu khai báo gốc bên dưới chưa bị ghi đè.
          </MessageBarBody>
        </MessageBar>
      ) : null}
      {a.allowedActions.includes("sampling:open") ? (
        <ActionButton
          action="open"
          busyAction={p.busyAction}
          appearance="primary"
          size="large"
          disabled={!navigator.onLine}
          label="Mở lượt tại hiện trường"
          runningLabel="Đang lấy vị trí…"
          onClick={p.open}
        />
      ) : null}
      {canReconcile || p.pending ? (
        <>
          <div style={card}>
            <strong style={cardTitle}>
              Đối soát khai báo gốc · {p.rows.filter((r) => !r.autoMatched && r.verdict).length}/
              {p.rows.filter((r) => !r.autoMatched).length}
            </strong>
            {p.rows.map((r) => {
              const missing = p.showMissing && !r.autoMatched && !r.verdict;
              return (
                <div
                  key={r.key}
                  id={`recon-${r.key}`}
                  style={{
                    display: "grid",
                    gap: 8,
                    padding: 10,
                    border: missing
                      ? "2px solid var(--status-error-foreground, #b10e1c)"
                      : "1px solid var(--border-subtle)",
                    borderRadius: "var(--radius-control)",
                    background:
                      r.verdict === "MISMATCH"
                        ? "var(--background-subtle)"
                        : "var(--background-surface)",
                  }}
                >
                  <Field
                    label={`${r.sampleCode} · ${labels[r.field]} · gốc: ${r.original || "hồ sơ không khai"}`}
                  >
                    <Input
                      size="large"
                      disabled={p.pending}
                      value={r.actual}
                      onChange={(_, d) => p.setActual((v) => ({ ...v, [r.key]: d.value }))}
                    />
                  </Field>
                  {r.autoMatched ? (
                    <span style={secondary}>
                      Hồ sơ không khai và hiện trường cũng không có - ghi nhận là khớp. Điền giá trị
                      vào ô trên nếu thực tế có.
                    </span>
                  ) : (
                    <div style={{ display: "grid", gap: 8 }}>
                      <Label required>Chọn Khớp hoặc Lệch</Label>
                      <div style={{ display: "flex", gap: 8 }}>
                        <Button
                          size="large"
                          disabled={p.pending}
                          appearance={r.verdict === "MATCH" ? "primary" : "secondary"}
                          onClick={() => p.setVerdicts((v) => ({ ...v, [r.key]: "MATCH" }))}
                        >
                          Khớp
                        </Button>
                        <Button
                          size="large"
                          disabled={p.pending}
                          appearance={r.verdict === "MISMATCH" ? "primary" : "secondary"}
                          onClick={() => p.setVerdicts((v) => ({ ...v, [r.key]: "MISMATCH" }))}
                        >
                          Lệch
                        </Button>
                      </div>
                    </div>
                  )}
                  {missing ? (
                    <span style={{ color: "var(--status-error-foreground, #b10e1c)" }}>
                      Chưa chọn Khớp hay Lệch cho trường này.
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
          <Field
            label="Lý do / ghi chú"
            required={mismatchCount > 0}
            hint="Bắt buộc khi có sai lệch hoặc từ chối lấy mẫu."
          >
            <Textarea
              disabled={p.pending}
              value={p.reason}
              onChange={(_, d) => p.setReason(d.value)}
            />
          </Field>
          {p.pending ? null : (
            <FilePicker
              key={`${a.assignmentCode}-evidence`}
              label="Ảnh bằng chứng"
              required={mismatchCount > 0 && a.allowedActions.includes("sampling:request-change")}
              hint="Bắt buộc khi đề nghị sửa trường lệch hoặc từ chối lấy mẫu."
              multiple
              pending={Boolean(p.busyAction)}
              pendingLabel="Đang tải ảnh lên…"
              onFiles={p.setEvidence}
            />
          )}
          {a.allowedActions.includes("sampling:reject") ? (
            <ActionButton
              action="reject"
              busyAction={p.busyAction}
              disabled={p.pending || !p.reason.trim() || p.evidenceCount === 0}
              label="Từ chối lấy mẫu"
              runningLabel="Đang tải ảnh lên…"
              onClick={p.reject}
            />
          ) : null}
          {a.allowedActions.includes("sampling:reconcile") ? (
            <ActionButton
              action="reconcile"
              busyAction={p.busyAction}
              appearance="primary"
              disabled={p.pending}
              label="Gửi kết quả đối soát"
              runningLabel="Đang gửi…"
              onClick={p.reconcile}
            />
          ) : null}
          {a.allowedActions.includes("sampling:request-change") ? (
            /* Đúng ba điều kiện `requestChange` đòi, đặt ngay trên nút thay vì để người dùng bấm
               rồi nhận lời từ chối. Không có trường nào lệch thì chẳng có gì để đề nghị sửa. */
            <ActionButton
              action="request-change"
              busyAction={p.busyAction}
              disabled={
                p.pending || mismatchCount === 0 || !p.reason.trim() || p.evidenceCount === 0
              }
              label="Đề nghị sửa các trường lệch"
              runningLabel="Đang tải ảnh lên…"
              onClick={p.requestChange}
            />
          ) : null}
        </>
      ) : null}
      {a.allowedActions.includes("sampling:bm03") ? (
        <div style={card}>
          <strong style={cardTitle}>Ba tiêu chí bắt buộc</strong>
          {(["representative", "sealedOnSite", "preserved"] as const).map((key, i) => (
            <div key={key} className="dlp-field__crit" data-on={p.criteria[key]}>
              <Checkbox
                required
                checked={p.criteria[key]}
                onChange={(_, d) => p.setCriteria((v) => ({ ...v, [key]: Boolean(d.checked) }))}
                label={["Mẫu đại diện cho lô", "Niêm phong tại chỗ", "Bảo quản đúng điều kiện"][i]}
              />
            </div>
          ))}
          <strong style={cardTitle}>Lượng mẫu thực lấy</strong>
          {a.samples.map((sample) => (
            <div key={sample.sampleCode}>
              <strong>
                {sample.sampleCode} · {sample.declaration.productName}
              </strong>
              <QuantityFields
                expectedQuantity={sample.expectedQuantity}
                quantity={p.sampleQuantities[sample.sampleCode]?.quantity ?? ""}
                quantityUnit={p.sampleQuantities[sample.sampleCode]?.unit ?? ""}
                setQuantity={(quantity) =>
                  p.setSampleQuantities((current) => ({
                    ...current,
                    [sample.sampleCode]: { quantity, unit: current[sample.sampleCode]?.unit ?? "" },
                  }))
                }
                setQuantityUnit={(unit) =>
                  p.setSampleQuantities((current) => ({
                    ...current,
                    [sample.sampleCode]: {
                      unit,
                      quantity: current[sample.sampleCode]?.quantity ?? "",
                    },
                  }))
                }
              />
            </div>
          ))}
          <FilePicker
            key={`${a.assignmentCode}-seal-photos`}
            label="Ảnh tem (tối thiểu 2)"
            required
            multiple
            pending={Boolean(p.busyAction)}
            pendingLabel="Đang tải ảnh lên…"
            onFiles={p.setSealPhotos}
          />
          <SignaturePad
            key={`${a.assignmentCode}-bm03-sampler`}
            label="Xác nhận của người lấy mẫu (ký trên màn)"
            required
            onSigned={p.setBm03SamplerSign}
            onClear={() => p.setBm03SamplerSign(undefined)}
          />
          <ActionButton
            action="bm03"
            busyAction={p.busyAction}
            appearance="primary"
            disabled={p.pending}
            label="Chốt BM03"
            runningLabel="Đang tải ảnh tem lên…"
            onClick={p.bm03}
          />
        </div>
      ) : null}
      {a.allowedActions.includes("sampling:bm02") ? (
        <div style={card}>
          <strong style={cardTitle}>BM02 · xác nhận hai bên</strong>
          {a.samples.map((sample) => (
            <div key={sample.sampleCode}>
              <strong>
                {sample.sampleCode} · {sample.declaration.productName}
              </strong>
              <QuantityFields
                expectedQuantity={sample.expectedQuantity}
                quantity={p.sampleQuantities[sample.sampleCode]?.quantity ?? ""}
                quantityUnit={p.sampleQuantities[sample.sampleCode]?.unit ?? ""}
                setQuantity={() => undefined}
                setQuantityUnit={() => undefined}
                inheritedFrom="BM03"
              />
            </div>
          ))}
          <Field label="Tên đại diện khách" required>
            <Input
              size="large"
              value={p.customerName}
              onChange={(_, d) => p.setCustomerName(d.value)}
            />
          </Field>
          <SignaturePad
            key={`${a.assignmentCode}-bm02-sampler`}
            label="Người lấy mẫu (ký trên màn)"
            required
            onSigned={p.setBm02SamplerSign}
            onClear={() => p.setBm02SamplerSign(undefined)}
          />
          <SignaturePad
            key={`${a.assignmentCode}-bm02-customer`}
            label="Đại diện khách hàng (ký trên màn)"
            required
            onSigned={p.setCustomerSign}
            onClear={() => p.setCustomerSign(undefined)}
          />
          <small>Chữ ký trên màn là xác nhận nghiệp vụ, không phải chữ ký số pháp lý.</small>
          <ActionButton
            action="bm02"
            busyAction={p.busyAction}
            appearance="primary"
            label="Ký và hoàn tất BM02"
            runningLabel="Đang gửi chữ ký…"
            onClick={p.bm02}
          />
        </div>
      ) : null}
      {a.bm02 ? (
        <MessageBar intent="success">
          <MessageBarBody>
            <MessageBarTitle>Đã hoàn tất lấy mẫu</MessageBarTitle>
            BM02 và BM03 đã được lưu trên hệ thống. Hồ sơ sẵn sàng chuyển sang bước tiếp nhận mẫu.
          </MessageBarBody>
        </MessageBar>
      ) : null}
      {!hasWorkflowAction && !a.bm02 ? (
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Lượt không có thao tác tiếp theo</MessageBarTitle>
            Trạng thái hiện tại: {a.status.name}. Dữ liệu của lượt được giữ ở chế độ chỉ xem.
          </MessageBarBody>
        </MessageBar>
      ) : null}
      {a.pendingChangeRequest ? (
        <div style={card}>
          <strong>Đề nghị thay đổi (không ghi đè khai báo gốc)</strong>
          <div key={a.pendingChangeRequest.id}>
            {a.pendingChangeRequest.status.name}:{" "}
            {a.pendingChangeRequest.fields
              .map((f) => `${labels[f.field]} ${f.oldValue} → ${f.newValue}`)
              .join(", ")}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ManagerQueue({
  items,
  page,
  currentPage,
  onPage,
  loading,
  error,
  busyAction,
  onAct,
  api,
}: {
  items: FieldChangeRequest[];
  page?: { number: number; totalPages: number };
  currentPage: number;
  onPage: React.Dispatch<React.SetStateAction<number>>;
  loading: boolean;
  error: Error | null;
  busyAction?: string;
  onAct: (action: string, success: string, run: () => Promise<unknown>) => Promise<void>;
  api: ReturnType<typeof useApiClient>;
}) {
  const [decisions, setDecisions] = useState<Record<string, ApprovalInput["decisions"]>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  if (loading) return <Spinner label="Đang tải hàng chờ…" />;
  if (error)
    return (
      <MessageBar intent="error">
        <MessageBarBody>
          <MessageBarTitle>Không tải được hàng chờ</MessageBarTitle>
          {apiErrorMessage(error)}
        </MessageBarBody>
      </MessageBar>
    );
  return (
    <section style={{ display: "grid", gap: 12 }}>
      {items.map((item) => {
        const current =
          decisions[item.id] ??
          (item.fields.map((f) => ({
            sampleCode: f.sampleCode,
            field: f.field,
            decision: "APPROVE" as const,
          })) as ApprovalInput["decisions"]);
        return (
          <div key={item.id} style={card}>
            <strong>
              Lượt {item.assignmentCode} · {item.requestedBy.fullName}
            </strong>
            <span>{item.reason}</span>
            {item.fields.map((field) => {
              const d = current.find(
                (x) => x.field === field.field && x.sampleCode === field.sampleCode,
              )!;
              return (
                <div key={`${field.sampleCode}:${field.field}`} style={card}>
                  <span>
                    {field.sampleCode} · {field.fieldName ?? labels[field.field]}:{" "}
                    <b>{field.oldValue}</b> → <b>{field.newValue}</b>
                  </span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <Button
                      appearance={d.decision === "APPROVE" ? "primary" : "secondary"}
                      onClick={() =>
                        setDecisions((all) => ({
                          ...all,
                          [item.id]: current.map((x) =>
                            x.field === field.field && x.sampleCode === field.sampleCode
                              ? ({
                                  sampleCode: x.sampleCode,
                                  field: x.field,
                                  decision: "APPROVE",
                                } as ApprovalInput["decisions"][number])
                              : x,
                          ),
                        }))
                      }
                    >
                      Duyệt
                    </Button>
                    <Button
                      appearance={d.decision === "REJECT" ? "primary" : "secondary"}
                      onClick={() =>
                        setDecisions((all) => ({
                          ...all,
                          [item.id]: current.map((x) =>
                            x.field === field.field && x.sampleCode === field.sampleCode
                              ? ({
                                  sampleCode: x.sampleCode,
                                  field: x.field,
                                  decision: "REJECT",
                                  reason: (x as ApprovalInput["decisions"][number]).reason ?? "",
                                } as ApprovalInput["decisions"][number])
                              : x,
                          ),
                        }))
                      }
                    >
                      Từ chối trường
                    </Button>
                  </div>
                  {d.decision === "REJECT" ? (
                    <Input
                      placeholder="Lý do từ chối trường"
                      value={d.reason ?? ""}
                      onChange={(_, data) =>
                        setDecisions((all) => ({
                          ...all,
                          [item.id]: current.map((x) =>
                            x.field === field.field && x.sampleCode === field.sampleCode
                              ? { ...x, reason: data.value }
                              : x,
                          ),
                        }))
                      }
                    />
                  ) : null}
                </div>
              );
            })}
            {/* Trước đây hai nút dưới đây không có khoá nào: một cú bấm đúp trên điện thoại gửi
                hai lần quyết định cho cùng một đề nghị. */}
            <ActionButton
              action={`approve:${item.id}`}
              busyAction={busyAction}
              appearance="primary"
              disabled={current.some((d) => d.decision === "REJECT" && !d.reason?.trim())}
              label="Lưu quyết định từng trường"
              runningLabel="Đang gửi…"
              onClick={() =>
                onAct(`approve:${item.id}`, "Đã xử lý đề nghị theo từng trường", () =>
                  samplingApi.approve(api, item.id, { decisions: current }),
                )
              }
            />
            <Field label="Hoặc từ chối toàn bộ">
              <Input
                value={reasons[item.id] ?? ""}
                onChange={(_, d) => setReasons((r) => ({ ...r, [item.id]: d.value }))}
              />
            </Field>
            <ActionButton
              action={`reject-change:${item.id}`}
              busyAction={busyAction}
              disabled={!reasons[item.id]?.trim()}
              label="Từ chối toàn bộ"
              runningLabel="Đang gửi…"
              onClick={() =>
                onAct(`reject-change:${item.id}`, "Đã từ chối toàn bộ đề nghị", () =>
                  samplingApi.rejectChange(api, item.id, reasons[item.id]!),
                )
              }
            />
          </div>
        );
      })}
      {page ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Button disabled={currentPage <= 1} onClick={() => onPage((value) => value - 1)}>
            Trước
          </Button>
          <span>
            Trang {page.number}/{page.totalPages || 1}
          </span>
          <Button
            disabled={currentPage >= page.totalPages}
            onClick={() => onPage((value) => value + 1)}
          >
            Sau
          </Button>
        </div>
      ) : null}
      {!items.length ? <div style={card}>Không có đề nghị đang chờ duyệt.</div> : null}
    </section>
  );
}
