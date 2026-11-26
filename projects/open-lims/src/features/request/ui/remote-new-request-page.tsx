import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Field,
  Input,
  InteractionTag,
  InteractionTagPrimary,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  Textarea,
} from "@fluentui/react-components";
import { ChevronDown20Regular, ChevronUp20Regular, Copy20Regular } from "@fluentui/react-icons";
import { useNavigate } from "@tanstack/react-router";
import { FieldLabel, FileDropField, PageHead } from "@/components/lims/common";
import { card, hintText, sectionTitle, subLabel } from "@/components/lims/request-styles";
import { CustomerPicker, type CustomerRecord } from "@/components/lims/customer";
import { toneToColor } from "@/lib/admin/tone";
import { uploadFile, useApiClient } from "@/lib/api";
import { requestKeys, useRequestApi } from "../hooks";
import type { CreateTestRequestInput, RequestedSample } from "../types";
import { DELIVERY_MODES, PARAMETERS, RequestError } from "./request-ui";

/* Trường CẤP HỒ SƠ - khai một lần cho cả phiếu. Cột `required` khớp `Bm01Declaration
   #requiredFieldErrors` phần hồ sơ của máy chủ (E-REQ-001). Bộ trường truy xuất BR-021 và chỉ
   tiêu đã chuyển xuống cấp MẪU (CR-20260831-001), xem `SAMPLE_FIELDS` bên dưới. */
const REQUEST_FIELDS = [
  {
    key: "representative",
    label: "Người đại diện",
    required: true,
    placeholder: "Ngô Thị Kim Chi",
    hint: "Tự điền theo người đại diện của khách hàng khi chọn khách",
  },
  { key: "phone", label: "Điện thoại", required: true, placeholder: "0918442117" },
  {
    key: "samplingLocation",
    label: "Địa điểm lấy mẫu",
    placeholder: "Kho X, KCN Quang Minh",
  },
] as const;

/* Trường CẤP MẪU - lặp lại cho mỗi dòng trong «Danh sách mẫu». Tên mẫu và chỉ tiêu vẫn bắt buộc;
   các trường truy xuất có thể bổ sung sau khi tiếp nhận. */
const SAMPLE_FIELDS = [
  { key: "product", label: "Tên mẫu", required: true, placeholder: "Sầu riêng" },
  {
    key: "customerSampleCode",
    label: "Mã mẫu tham chiếu (nếu có)",
    placeholder: "Mã do khách hàng cung cấp",
  },
  { key: "growingAreaCode", label: "Mã số vùng trồng", placeholder: "VN-DL-0417" },
  {
    key: "packingHouseCode",
    label: "Mã cơ sở đóng gói",
    placeholder: "VN-PH-0092",
  },
  { key: "containerNumber", label: "Số container", placeholder: "ABCD1234567" },
  { key: "vehiclePlate", label: "Biển số xe", placeholder: "51C-543.21" },
  { key: "trailerNumber", label: "Số rơ-moóc", placeholder: "51R-001.02" },
  { key: "sealNumber", label: "Số seal", placeholder: "SL-889" },
] as const;

const MAX_SAMPLES = 99;

/** Ba trường KHÔNG được nhân bản khi bấm "Nhân bản mẫu" - phải khác nhau giữa các mẫu (AC-012). */
const CLONE_RESET_FIELDS = ["containerNumber", "vehiclePlate", "sealNumber"] as const;

/** Bản nháp một dòng mẫu đang soạn trên màn hình - mọi trường giữ dạng chuỗi để khớp `Input`,
 *  chuyển sang `RequestedSample` (kiểu API) lúc dựng payload. `key` chỉ tồn tại phía client, để
 *  React và accordion theo dõi đúng dòng khi thêm/nhân bản/xoá - server không nhận trường này. */
interface SampleDraft {
  key: string;
  product: string;
  customerSampleCode: string;
  growingAreaCode: string;
  packingHouseCode: string;
  containerNumber: string;
  vehiclePlate: string;
  trailerNumber: string;
  sealNumber: string;
  parameterCodes: string[];
}

function newSampleDraft(): SampleDraft {
  return {
    key: crypto.randomUUID(),
    product: "",
    customerSampleCode: "",
    growingAreaCode: "",
    packingHouseCode: "",
    containerNumber: "",
    vehiclePlate: "",
    trailerNumber: "",
    sealNumber: "",
    parameterCodes: [],
  };
}

/** Nạp một mẫu đã lưu trong bản nháp (`GET /test-requests/drafts/{id}`) thành dòng soạn thảo.
 *  Mẫu trong nháp chưa có `code`/`sampleIndex` (BR-003 chỉ sinh ở bước submit) nên bỏ qua, chỉ
 *  giữ các trường người dùng đã gõ. */
function sampleDraftFromApi(s: RequestedSample): SampleDraft {
  return {
    key: crypto.randomUUID(),
    product: s.product ?? "",
    customerSampleCode: s.customerSampleCode ?? "",
    growingAreaCode: s.growingAreaCode ?? "",
    packingHouseCode: s.packingHouseCode ?? "",
    containerNumber: s.containerNumber ?? "",
    vehiclePlate: s.vehiclePlate ?? "",
    trailerNumber: s.trailerNumber ?? "",
    sealNumber: s.sealNumber ?? "",
    parameterCodes: s.parameterCodes ?? [],
  };
}

/** Trường bắt buộc của MỘT mẫu còn thiếu (E-REQ-012 khi thiếu tên mẫu/chỉ tiêu). Rỗng nghĩa là
 *  mẫu hợp lệ; các trường truy xuất có thể bổ sung sau khi tiếp nhận. */
function sampleErrors(sample: SampleDraft): string[] {
  const list: string[] = [];
  for (const f of SAMPLE_FIELDS) {
    if ("required" in f && f.required && !sample[f.key].trim()) list.push(f.label);
  }
  if (sample.parameterCodes.length === 0) list.push("Chỉ tiêu thử nghiệm");
  return list;
}

/** Dòng thu gọn của một mẫu: tên mẫu · biển số · số chỉ tiêu (ui-ux-spec 13.13). */
function sampleSummary(sample: SampleDraft): string {
  const parts = [
    sample.product.trim() || "(chưa đặt tên)",
    sample.vehiclePlate.trim() || "chưa có biển số",
    `${sample.parameterCodes.length} chỉ tiêu`,
  ];
  return parts.join(" · ");
}

export function RemoteNewRequestPage({ draftId }: { draftId?: string }) {
  const api = useRequestApi();
  const uploadApi = useApiClient();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>({});
  const [samples, setSamples] = useState<SampleDraft[]>(() => [newSampleDraft()]);
  const [openKey, setOpenKey] = useState<string | undefined>(() => samples[0]?.key);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [delivery, setDelivery] = useState<string[]>([]);
  const [commitment, setCommitment] = useState(false);
  const [note, setNote] = useState("");
  const [sourceDocumentId, setSourceDocumentId] = useState<string>();
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerRecord>();
  const set = (key: string, value: string) => setValues((prev) => ({ ...prev, [key]: value }));
  // Người đại diện và điện thoại của lô hàng mặc định là của khách hàng; chỉ điền vào ô còn trống
  // để không đè lên thứ người nhập đã sửa cho riêng lô này.
  const pickCustomer = (customer: CustomerRecord | undefined) => {
    setSelectedCustomer(customer);
    if (!customer) return;
    setValues((prev) => ({
      ...prev,
      ...(prev["representative"]?.trim() ? {} : { representative: customer.representative ?? "" }),
      ...(prev["phone"]?.trim() ? {} : { phone: customer.phone ?? "" }),
    }));
  };

  // Nháp không có mã (BR-003 chỉ sinh mã khi hồ sơ rời DRAFT) nên không mở lại được qua màn chi
  // tiết/sửa hồ sơ - nạp lại đúng các trường đã lưu để điền sẵn form tạo yêu cầu. Lưu hay hoàn
  // tất đều ghi ngược lên chính dòng này qua `/drafts/{id}`, xem `save` bên dưới.
  const draft = useQuery({
    queryKey: ["test-requests", "draft", draftId],
    queryFn: () => api.draft(draftId as string),
    enabled: !!draftId,
  });
  const draftApplied = useRef(false);
  useEffect(() => {
    if (draftApplied.current || !draft.data) return;
    draftApplied.current = true;
    const d = draft.data;
    setValues((prev) => ({
      ...prev,
      ...(d.representative ? { representative: d.representative } : {}),
      ...(d.phone ? { phone: d.phone } : {}),
      ...(d.samplingLocation ? { samplingLocation: d.samplingLocation } : {}),
    }));
    if (d.samples?.length) {
      const mapped = d.samples.map(sampleDraftFromApi);
      setSamples(mapped);
      setOpenKey(mapped[0]?.key);
    }
    if (d.resultDeliveryModes?.length) setDelivery(d.resultDeliveryModes);
    if (d.customerCommitmentAcknowledged) setCommitment(true);
    if (d.sourceDocumentId) setSourceDocumentId(d.sourceDocumentId);
    if (d.customer) setSelectedCustomer(d.customer);
  }, [draft.data]);
  const toggle = (list: string[], value: string, setter: (v: string[]) => void) =>
    setter(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  // Ô chọn khách hàng tự giữ trạng thái tìm kiếm/tạo mới của nó; ở đây chỉ cấp hai thao tác API.
  const searchCustomers = useCallback(
    async (query: string) => (await api.customers(query)).data,
    [api],
  );
  const createCustomer = useCallback(
    (input: Parameters<typeof api.createCustomer>[0]) => api.createCustomer(input),
    [api],
  );
  const upload = useMutation({
    mutationFn: (file: File) => uploadFile(uploadApi, file, { grant: "request.source" }),
    onSuccess: (result) => setSourceDocumentId(result.id),
  });

  // Danh sách mẫu (Khối II) - thêm/nhân bản/xoá dòng, đóng-mở đúng một mẫu tại một thời điểm
  // (ui-ux-spec 13.13: "Accordion mở đúng một mẫu"). `samples`/`openKey` đọc trực tiếp từ closure
  // vì mọi thao tác đều là click đơn, tuần tự - không cần functional updater lồng nhau.
  const addSample = () => {
    if (samples.length >= MAX_SAMPLES) return;
    const created = newSampleDraft();
    setSamples([...samples, created]);
    setOpenKey(created.key);
  };
  const removeSample = (key: string) => {
    const next = samples.filter((s) => s.key !== key);
    setSamples(next);
    if (openKey === key) setOpenKey(next[0]?.key);
  };
  // AC-012: chép tên mẫu, vùng trồng, cơ sở đóng gói, rơ-moóc và bộ chỉ tiêu; ba trường định danh
  // vận chuyển (container/biển số/seal) để trống vì chúng bắt buộc phải khác nhau giữa các mẫu.
  const cloneSample = (key: string) => {
    if (samples.length >= MAX_SAMPLES) return;
    const index = samples.findIndex((s) => s.key === key);
    const source = samples[index];
    if (index === -1 || !source) return;
    const clone: SampleDraft = { ...source, key: crypto.randomUUID() };
    for (const field of CLONE_RESET_FIELDS) clone[field] = "";
    const next = [...samples.slice(0, index + 1), clone, ...samples.slice(index + 1)];
    setSamples(next);
    setOpenKey(clone.key);
  };
  const setSampleField = (key: string, field: keyof SampleDraft, value: string) =>
    setSamples(samples.map((s) => (s.key === key ? { ...s, [field]: value } : s)));
  const toggleSampleParameter = (key: string, code: string) =>
    setSamples(
      samples.map((s) =>
        s.key === key
          ? {
              ...s,
              parameterCodes: s.parameterCodes.includes(code)
                ? s.parameterCodes.filter((c) => c !== code)
                : [...s.parameterCodes, code],
            }
          : s,
      ),
    );
  // "Áp chỉ tiêu cho tất cả mẫu" - đa số phiếu vẫn cùng bộ chỉ tiêu, mặc định phải rẻ (ui-ux-spec
  // 13.13 điểm 3).
  const applyParametersToAll = (key: string) => {
    const source = samples.find((s) => s.key === key);
    if (!source) return;
    setSamples(samples.map((s) => ({ ...s, parameterCodes: source.parameterCodes })));
  };

  const sampleErrorsByKey = useMemo(
    () => new Map(samples.map((s) => [s.key, sampleErrors(s)])),
    [samples],
  );
  const hasInvalidSample =
    samples.length === 0 || samples.some((s) => sampleErrorsByKey.get(s.key)!.length > 0);
  // Trùng container/seal giữa các mẫu KHÔNG chặn (api-map.md: "có ca nhiều mẫu cùng một
  // container") - chỉ cảnh báo để người nhập tự soát lại (AC-013).
  const duplicateWarnings = useMemo(() => {
    const dupField = (field: "containerNumber" | "sealNumber", label: string) => {
      const values = samples.map((s) => s[field].trim()).filter(Boolean);
      const seen = new Set<string>();
      const dup = new Set<string>();
      for (const v of values) (seen.has(v) ? dup : seen).add(v);
      return [...dup].map((v) => `${label} "${v}" lặp lại ở nhiều mẫu`);
    };
    return [...dupField("containerNumber", "Số container"), ...dupField("sealNumber", "Số seal")];
  }, [samples]);

  // Trường cấp hồ sơ còn thiếu - điều khiển nút "Hoàn tất tiếp nhận" bị khoá hẳn. Lỗi cấp MẪU
  // (bao gồm danh sách rỗng) KHÔNG khoá nút - bấm vào sẽ tự mở đúng mẫu lỗi thay vì im lặng
  // (ui-ux-spec 13.13: "accordion tự mở đúng mẫu lỗi").
  const topMissing = useMemo(() => {
    const list: string[] = [];
    if (!selectedCustomer) list.push("Khách hàng");
    for (const f of REQUEST_FIELDS) {
      const value =
        f.key === "representative"
          ? (values[f.key] ?? "").trim() || (selectedCustomer?.representative ?? "").trim()
          : (values[f.key] ?? "").trim();
      if ("required" in f && f.required && !value) list.push(f.label);
    }
    if (delivery.length === 0) list.push("Hình thức nhận kết quả");
    if (!commitment) list.push("Bản BM01 có chữ ký khách hàng");
    return list;
  }, [selectedCustomer, values, delivery, commitment]);
  const missing = useMemo(() => {
    const list = [...topMissing];
    if (samples.length === 0) list.push("Danh sách mẫu (tối thiểu 1 mẫu)");
    samples.forEach((s, i) => {
      const errs = sampleErrorsByKey.get(s.key) ?? [];
      if (errs.length) list.push(`Mẫu ${i + 1}: ${errs.join(", ")}`);
    });
    return list;
  }, [topMissing, samples, sampleErrorsByKey]);
  const ready = missing.length === 0;

  const representative =
    values["representative"]?.trim() || selectedCustomer?.representative?.trim() || "";
  const payload = useMemo<CreateTestRequestInput>(
    () => ({
      ...(selectedCustomer?.id ? { customerId: selectedCustomer.id } : {}),
      // Bỏ trống ô người đại diện thì hồ sơ vẫn phải có người đại diện: lấy của khách hàng.
      ...(representative ? { representative } : {}),
      ...(values["phone"] ? { phone: values["phone"] } : {}),
      ...(values["samplingLocation"] ? { samplingLocation: values["samplingLocation"] } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
      samples: samples.map((s): RequestedSample => ({
        ...(s.product.trim() ? { product: s.product.trim() } : {}),
        ...(s.customerSampleCode.trim() ? { customerSampleCode: s.customerSampleCode.trim() } : {}),
        ...(s.growingAreaCode.trim() ? { growingAreaCode: s.growingAreaCode.trim() } : {}),
        ...(s.packingHouseCode.trim() ? { packingHouseCode: s.packingHouseCode.trim() } : {}),
        ...(s.containerNumber.trim() ? { containerNumber: s.containerNumber.trim() } : {}),
        ...(s.vehiclePlate.trim() ? { vehiclePlate: s.vehiclePlate.trim() } : {}),
        ...(s.trailerNumber.trim() ? { trailerNumber: s.trailerNumber.trim() } : {}),
        ...(s.sealNumber.trim() ? { sealNumber: s.sealNumber.trim() } : {}),
        parameterCodes: s.parameterCodes,
      })),
      resultDeliveryModes: delivery as NonNullable<CreateTestRequestInput["resultDeliveryModes"]>,
      customerCommitmentAcknowledged: commitment,
      ...(sourceDocumentId ? { sourceDocumentId } : {}),
    }),
    [
      selectedCustomer,
      representative,
      values,
      note,
      samples,
      delivery,
      commitment,
      sourceDocumentId,
    ],
  );
  // Mở lại một bản nháp thì ghi đè lên CHÍNH dòng đó (`/drafts/{id}` · `/drafts/{id}/submit`),
  // không gọi lại `create`. Gọi `create` là sinh thêm một hồ sơ nữa: bản nháp cũ không có đường
  // nào rời khỏi DRAFT nên nó nằm lại danh sách vĩnh viễn, và mỗi lần hoàn tất là một dòng trùng.
  const save = useMutation({
    mutationFn: (draft: boolean) => {
      if (draftId) {
        return draft ? api.saveDraft(draftId, payload) : api.submitDraft(draftId, payload);
      }
      return api.create({ ...payload, draft });
    },
    onSuccess: (result) => {
      // Danh sách hồ sơ vừa đổi (dòng mới, hoặc nháp cũ nay đã có mã) - đánh dấu cũ để lần mở
      // sau không đọc lại bản đã lỗi thời trong bộ nhớ đệm.
      void cache.invalidateQueries({ queryKey: requestKeys.all });
      void navigate(
        result.code ? { to: "/ho-so-chi-tiet/$id", params: { id: result.code } } : { to: "/ho-so" },
      );
    },
  });
  // Bấm "Hoàn tất tiếp nhận": còn mẫu lỗi (kể cả danh sách rỗng) thì KHÔNG gửi - tự mở đúng mẫu
  // lỗi đầu tiên để người dùng thấy ngay, thay vì chặn nút một cách im lặng.
  const handleComplete = () => {
    setSubmitAttempted(true);
    if (hasInvalidSample) {
      const firstInvalid = samples.find((s) => sampleErrorsByKey.get(s.key)!.length > 0);
      if (firstInvalid) setOpenKey(firstInvalid.key);
      return;
    }
    save.mutate(false);
  };
  const totalParameters = samples.reduce((sum, s) => sum + s.parameterCodes.length, 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 1200, minWidth: 0 }}>
      <PageHead
        crumbs={[{ label: "Hồ sơ kiểm nghiệm", to: "/ho-so" }, { label: "Tạo yêu cầu mới" }]}
        title="Tạo yêu cầu thử nghiệm"
        description={
          draftId
            ? "Đang hoàn tất bản nháp đã lưu · điền nốt phần còn thiếu rồi Hoàn tất tiếp nhận"
            : "Số hoá BM01 nhiều mẫu · mã hồ sơ và mã mẫu do hệ thống sinh khi hồ sơ hợp lệ"
        }
        actions={
          <>
            <Button disabled={save.isPending} onClick={() => save.mutate(true)}>
              Lưu nháp
            </Button>
            <Button
              appearance="primary"
              disabled={save.isPending || topMissing.length > 0}
              title={topMissing.length ? "Còn trường bắt buộc chưa điền" : ""}
              onClick={handleComplete}
            >
              Hoàn tất tiếp nhận
            </Button>
          </>
        }
      />

      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div
          style={{
            flex: "2 1 620px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            minWidth: 0,
          }}
        >
          <div style={card}>
            <div style={sectionTitle}>I · Thông tin chung</div>

            <Field label="Khách hàng" required>
              <CustomerPicker
                value={selectedCustomer}
                onChange={pickCustomer}
                onSearch={searchCustomers}
                onCreate={createCustomer}
              />
            </Field>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))",
                gap: 12,
              }}
            >
              {REQUEST_FIELDS.map((f) => (
                <Field
                  key={f.key}
                  label={<FieldLabel label={f.label} tooltip={"hint" in f ? f.hint : undefined} />}
                  required={"required" in f && Boolean(f.required)}
                >
                  <Input
                    value={values[f.key] ?? ""}
                    placeholder={f.placeholder}
                    onChange={(_, d) => set(f.key, d.value)}
                  />
                </Field>
              ))}
            </div>

            <div>
              <div style={subLabel}>Hình thức nhận kết quả - chọn ít nhất một</div>
              <div className="dlp-chiprow">
                {DELIVERY_MODES.map((d) => (
                  <InteractionTag
                    key={d.code}
                    appearance="outline"
                    className={
                      delivery.includes(d.code) ? "dlp-chip--picked" : "dlp-chip--unpicked"
                    }
                  >
                    <InteractionTagPrimary
                      aria-pressed={delivery.includes(d.code)}
                      onClick={() => toggle(delivery, d.code, setDelivery)}
                    >
                      {delivery.includes(d.code) ? "✓ " : ""}
                      {d.name}
                    </InteractionTagPrimary>
                  </InteractionTag>
                ))}
              </div>
            </div>
          </div>

          <div style={{ ...card, gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={sectionTitle}>II · Danh sách mẫu</div>
              <Button
                size="small"
                disabled={samples.length >= MAX_SAMPLES}
                title={samples.length >= MAX_SAMPLES ? "Tối đa 99 mẫu một hồ sơ" : ""}
                onClick={addSample}
              >
                + Thêm mẫu
              </Button>
            </div>

            {samples.length === 0 ? (
              <span style={{ ...hintText, color: "var(--status-danger-foreground)" }}>
                Chưa có mẫu nào. Bấm "+ Thêm mẫu" để khai mẫu đầu tiên.
              </span>
            ) : null}

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {samples.map((sample, index) => {
                const open = openKey === sample.key;
                const errors = sampleErrorsByKey.get(sample.key) ?? [];
                const showErrors = submitAttempted && errors.length > 0;
                return (
                  <div
                    key={sample.key}
                    style={{
                      border: `1px solid ${showErrors ? "var(--status-danger-foreground)" : "var(--border-subtle)"}`,
                      borderRadius: "var(--radius-surface)",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "8px 10px",
                      }}
                    >
                      <Button
                        appearance="subtle"
                        size="small"
                        icon={open ? <ChevronUp20Regular /> : <ChevronDown20Regular />}
                        aria-expanded={open}
                        onClick={() => setOpenKey(open ? undefined : sample.key)}
                        style={{ flex: 1, justifyContent: "flex-start" }}
                      >
                        <span style={{ fontWeight: 600 }}>Mẫu {index + 1}</span>
                        <span style={{ marginLeft: 8, fontWeight: 400 }}>
                          {sampleSummary(sample)}
                        </span>
                      </Button>
                      {showErrors ? (
                        <Badge appearance="tint" color={toneToColor("danger")}>
                          {errors.length} lỗi
                        </Badge>
                      ) : null}
                      <Button
                        size="small"
                        icon={<Copy20Regular />}
                        disabled={samples.length >= MAX_SAMPLES}
                        title="Nhân bản mẫu"
                        onClick={() => cloneSample(sample.key)}
                      >
                        Nhân bản
                      </Button>
                      <Button size="small" onClick={() => removeSample(sample.key)}>
                        Xoá
                      </Button>
                    </div>

                    {open ? (
                      <div
                        style={{
                          padding: "0 10px 12px",
                          display: "flex",
                          flexDirection: "column",
                          gap: 10,
                        }}
                      >
                        {showErrors ? (
                          <span style={{ ...hintText, color: "var(--status-danger-foreground)" }}>
                            Còn thiếu: {errors.join(", ")}
                          </span>
                        ) : null}
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))",
                            gap: 10,
                          }}
                        >
                          {SAMPLE_FIELDS.map((f) => (
                            <Field
                              key={f.key}
                              label={f.label}
                              required={"required" in f ? !!f.required : false}
                            >
                              <Input
                                value={sample[f.key]}
                                placeholder={f.placeholder}
                                onChange={(_, d) => setSampleField(sample.key, f.key, d.value)}
                              />
                            </Field>
                          ))}
                        </div>
                        <div>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              marginBottom: 8,
                            }}
                          >
                            <span style={subLabel}>Chỉ tiêu thử nghiệm - chọn ít nhất một</span>
                            <Button
                              size="small"
                              disabled={sample.parameterCodes.length === 0}
                              onClick={() => applyParametersToAll(sample.key)}
                            >
                              Áp chỉ tiêu cho tất cả mẫu
                            </Button>
                          </div>
                          <div className="dlp-chiprow">
                            {PARAMETERS.map((p) => (
                              <InteractionTag
                                key={p.code}
                                appearance="outline"
                                className={
                                  sample.parameterCodes.includes(p.code)
                                    ? "dlp-chip--picked"
                                    : "dlp-chip--unpicked"
                                }
                              >
                                <InteractionTagPrimary
                                  aria-pressed={sample.parameterCodes.includes(p.code)}
                                  onClick={() => toggleSampleParameter(sample.key, p.code)}
                                >
                                  {sample.parameterCodes.includes(p.code) ? "✓ " : ""}
                                  {p.name}
                                </InteractionTagPrimary>
                              </InteractionTag>
                            ))}
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>

            {samples.length > 0 ? (
              <span style={{ ...hintText, textAlign: "right" }}>
                Tổng: {samples.length} mẫu · {totalParameters} chỉ tiêu
              </span>
            ) : null}
            {duplicateWarnings.length ? (
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Trùng dữ liệu giữa các mẫu:</MessageBarTitle>{" "}
                  {duplicateWarnings.join("; ")} - vẫn lưu được, chỉ là nhắc tự kiểm lại.
                </MessageBarBody>
              </MessageBar>
            ) : null}
          </div>

          <div style={card}>
            <div style={sectionTitle}>III · Ghi chú</div>
            <Field
              label={
                <FieldLabel
                  label="Ghi chú"
                  tooltip="Tuỳ chọn - mã lô, yêu cầu khác của khách hàng"
                />
              }
            >
              <Textarea
                rows={3}
                value={note}
                placeholder="Ví dụ: mã lô LOT-0825; khách xin trả kết quả sớm hơn nếu được"
                onChange={(_, d) => setNote(d.value)}
              />
            </Field>
          </div>

          <div style={{ ...card, gap: 12 }}>
            <div style={sectionTitle}>IV · Cam kết và bản BM01 gốc</div>
            <FileDropField
              accept=".pdf,image/jpeg,image/png"
              pending={upload.isPending}
              pendingLabel="Đang tải BM01…"
              idle="Tải bản BM01 có chữ ký khách hàng (JPEG · PNG · PDF)"
              selected={
                sourceDocumentId ? "Đã đính kèm bản BM01 · bấm để thay tệp khác" : undefined
              }
              onFile={(file) => upload.mutate(file)}
            />
            <label
              style={{
                display: "flex",
                gap: 8,
                alignItems: "flex-start",
                font: "14px/20px var(--font-family-base)",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={commitment}
                onChange={(e) => setCommitment(e.currentTarget.checked)}
              />
              Khách hàng đã ký bản cam kết BM01 và chịu trách nhiệm về thông tin khai báo.
            </label>
            <span style={hintText}>
              Bản scan/ảnh có chữ ký khách hàng là bằng chứng cam kết. Revision BM01 hiệu lực: Rev
              00.
            </span>
          </div>
        </div>

        <div
          style={{
            flex: "1 1 300px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            minWidth: 0,
          }}
        >
          {draft.isPending && draftId ? <Spinner size="tiny" label="Đang nạp bản nháp…" /> : null}
          <RequestError
            error={save.error ?? upload.error ?? draft.error}
            fallback={draftId ? "Không thể nạp bản nháp." : undefined}
          />

          <MessageBar intent={ready ? "success" : "warning"}>
            <MessageBarBody>
              <MessageBarTitle>
                {ready ? "Sẵn sàng tiếp nhận:" : "Hồ sơ chưa hợp lệ:"}
              </MessageBarTitle>{" "}
              {ready
                ? "Hoàn tất tiếp nhận sẽ sinh mã hồ sơ, mã mẫu cho từng mẫu và chuyển hồ sơ sang «Chờ phân công lấy mẫu»."
                : "Lưu nháp được bất kỳ lúc nào. Hồ sơ ở trạng thái «Nháp» cho tới khi đủ trường bắt buộc."}
            </MessageBarBody>
          </MessageBar>

          <div style={{ ...card, gap: 10 }}>
            <div style={sectionTitle}>Trường bắt buộc còn thiếu</div>
            {ready ? (
              <span
                style={{
                  font: "14px/20px var(--font-family-base)",
                  color: "var(--status-success-foreground)",
                }}
              >
                Đã đủ trường bắt buộc.
              </span>
            ) : (
              missing.map((m) => (
                <span
                  key={m}
                  style={{
                    font: "14px/20px var(--font-family-base)",
                    color: "var(--status-danger-foreground)",
                  }}
                >
                  • {m}
                </span>
              ))
            )}
          </div>

          <div style={{ ...card, gap: 8 }}>
            <div style={sectionTitle}>Mã hồ sơ · mã mẫu</div>
            <span
              style={{
                font: "600 20px/28px var(--font-family-base)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              Sinh sau khi hợp lệ
            </span>
            <span style={hintText}>
              Mã hồ sơ DLP000001 tăng liên tục toàn hệ, không reset theo năm hoặc chi nhánh. Mã mẫu
              dùng dãy riêng {"{YY}{BRANCH_ID}{SEQ}"}, không ghép mã hồ sơ. Hệ thống sinh khi hoàn
              tất tiếp nhận, không nhập tay và không tái sử dụng (BR-001, BR-003).
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
