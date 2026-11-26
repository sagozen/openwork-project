import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Field,
  Input,
  InteractionTag,
  InteractionTagPrimary,
  Spinner,
  Textarea,
} from "@fluentui/react-components";
import { FieldLabel, FileDropField, PageHead } from "@/components/lims/common";
import { hintText } from "@/components/lims/request-styles";
import { uploadFile, useApiClient } from "@/lib/api";
import { toneToColor } from "@/lib/admin/tone";
import { requestKeys, useRequestApi, useRequestDetail } from "../hooks";
import type { RequestedSample, TestRequestDetail } from "../types";
import { DELIVERY_MODES, FIELD_LABELS, RequestError } from "./request-ui";

// Nhóm A theo D26/BR-025: các trường sửa trực tiếp được, trừ những trường API xếp vào nhóm B/C.
// Nhóm B (CR-20260831-001) đã mở rộng sang mọi trường CẤP MẪU - `fieldGroups.groupB` trả tiền tố
// `samples[].x` (và `"samples"` trần cho thêm/bớt mẫu), xem `groupFieldValue` bên dưới.
const GROUP_A_FIELDS = ["representative", "phone", "samplingLocation", "resultDeliveryModes"];
const SAMPLE_FIELD_PREFIX = "samples[].";
// Tham chiếu của API có thể chỉ mang `code` mà không có `name` - `parameters` là ví dụ chắc chắn
// (`ParameterResponse.from` dựng name = null). Đọc tên trước, không có thì đọc mã; tuyệt đối không
// để rơi xuống `String(object)` vì kết quả là "[object Object]" trên màn hình.
function refLabel(value: Record<string, unknown>): string {
  const name = value["name"];
  if (typeof name === "string" && name) return name;
  const code = value["code"];
  return typeof code === "string" ? code : "";
}
function scalarLabel(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value))
    return value
      .map((v) =>
        typeof v === "object" && v !== null ? refLabel(v as Record<string, unknown>) : String(v),
      )
      .filter(Boolean)
      .join(", ");
  if (typeof value === "object") return refLabel(value as Record<string, unknown>);
  return String(value);
}
function valueOf(record: Record<string, unknown>, key: string): string {
  const value = record[key] ?? (record["customer"] as Record<string, unknown> | undefined)?.[key];
  return scalarLabel(value);
}
/** Đọc GIÁ TRỊ của một khoá `fieldGroups.groupB`/`groupC`. Trả `record["code"]`/`receptionBranch`
 *  y hệt trước; trả tổng hợp theo từng mẫu cho khoá `samples[].x`; trả số mẫu cho khoá trần
 *  `"samples"` (thêm/bớt/đổi thứ tự mẫu cũng là nhóm B - không có "giá trị hiện tại" một dòng). */
function groupFieldValue(record: TestRequestDetail, key: string): string {
  if (key === "samples") return `${record.samples.length} mẫu`;
  if (key.startsWith(SAMPLE_FIELD_PREFIX)) {
    const subKey = key.slice(SAMPLE_FIELD_PREFIX.length) as keyof RequestedSample;
    return record.samples
      .map((s, i) => `Mẫu ${i + 1}: ${scalarLabel(s[subKey]) || "—"}`)
      .join(" · ");
  }
  return valueOf(record as unknown as Record<string, unknown>, key);
}
function groupFieldLabel(key: string): string {
  const bare = key.startsWith(SAMPLE_FIELD_PREFIX) ? key.slice(SAMPLE_FIELD_PREFIX.length) : key;
  return FIELD_LABELS[bare] ?? bare;
}
export function RemoteEditRequestPage({ code }: { code: string }) {
  const query = useRequestDetail(code, !!code);
  const record = query.data;
  const api = useRequestApi();
  const uploadApi = useApiClient();
  const cache = useQueryClient();
  const [changes, setChanges] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [evidenceIds, setEvidenceIds] = useState<string[]>([]);
  // Giá trị hiện tại của hồ sơ, dùng để đổ sẵn vào form và để so sánh xem người dùng đã sửa gì.
  const current = useMemo(() => {
    const source = record as unknown as Record<string, unknown> | undefined;
    return Object.fromEntries(
      GROUP_A_FIELDS.map((key) => [key, source ? valueOf(source, key) : ""]),
    );
  }, [record]);
  // Chỉ gửi trường thực sự khác giá trị cũ - PATCH ghi audit từng cặp giá trị cũ → mới.
  const edits = Object.entries(changes).filter(
    ([key, value]) => value.trim() !== (current[key] ?? "").trim(),
  );
  const patch = useMutation({
    mutationFn: () =>
      api.patch(code, {
        changes: Object.fromEntries(
          edits.map(([key, value]) => [
            key,
            key === "resultDeliveryModes"
              ? value
                  .split(",")
                  .map((item) => item.trim())
                  .filter(Boolean)
              : value.trim(),
          ]),
        ),
        reason,
        evidenceDocumentIds: evidenceIds,
      }),
    onSuccess: () => cache.invalidateQueries({ queryKey: requestKeys.detail(code) }),
  });
  const upload = useMutation({
    mutationFn: (file: File) =>
      uploadFile(uploadApi, file, {
        grant: "request.edit",
      }),
    onSuccess: (r) => setEvidenceIds((ids) => [...ids, r.id]),
  });
  const groupB = record?.fieldGroups.groupB ?? [];
  const groupC = record?.fieldGroups.groupC ?? [];
  const groupA = GROUP_A_FIELDS.filter((key) => !groupB.includes(key) && !groupC.includes(key));
  /**
   * Cùng một quyền `request.editGroupA` che hai thao tác khác hẳn nhau: sửa tự do theo UF-01 khi
   * hồ sơ còn ở quầy, và thay đổi có lý do + bằng chứng theo D26 khi phòng thử nghiệm đã giữ mẫu.
   * Client không suy ra được từ mã trạng thái mà không chép luật của server sang chỗ thứ hai, nên
   * server nói thẳng bằng một action riêng. Thiếu cờ (server cũ) thì giữ nguyên hành vi cũ - đòi
   * lý do - vì đó là phía an toàn.
   */
  const requiresJustification =
    record?.allowedActions.includes("request.editGroupA.requiresJustification") ?? true;
  const missing = [
    edits.length ? null : "sửa ít nhất một trường",
    requiresJustification && !reason.trim() ? "nhập lý do" : null,
    requiresJustification && !evidenceIds.length ? "đính kèm bằng chứng" : null,
  ].filter(Boolean);
  if (!code) return <RequestError error={new Error("Thiếu mã hồ sơ trong tham số code.")} />;
  if (query.isPending) return <Spinner label="Đang tải hồ sơ…" />;
  if (!record) return <RequestError error={query.error} />;
  return (
    <>
      <PageHead
        crumbs={[{ label: "Hồ sơ", to: "/ho-so" }, { label: code }, { label: "Sửa" }]}
        title={`Sửa hồ sơ ${code}`}
        description={
          requiresJustification
            ? "Mẫu đã vào phòng thử nghiệm: sửa nhóm A phải có lý do và bằng chứng. Nhóm B/C dùng quy trình sửa riêng."
            : "Hồ sơ chưa qua bước lấy mẫu: có thể sửa trực tiếp nhóm A. Nhóm B/C dùng quy trình sửa riêng."
        }
      />
      <RequestError error={patch.error ?? upload.error} />
      <div className="dlp-stack">
        <section className="dlp-card" style={{ padding: 16, display: "grid", gap: 10 }}>
          <h2>Nhóm A · sửa trực tiếp</h2>
          {groupA.map((key) => {
            const value = changes[key] ?? current[key] ?? "";
            // `resultDeliveryModes` là danh sách mã, không phải chữ tự do: gõ tay "AT_LAB" thì chỉ
            // cần sai một ký tự là PATCH trả 422. Chọn bằng chip đúng danh mục như màn tạo yêu cầu,
            // giá trị vẫn giữ dạng chuỗi ngăn bằng dấu phẩy mà mutation đang tách sẵn.
            if (key === "resultDeliveryModes") {
              const picked = value
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean);
              return (
                <Field
                  key={key}
                  label={
                    <FieldLabel
                      label={FIELD_LABELS[key] ?? key}
                      tooltip={`Hiện tại: ${current[key]}`}
                    />
                  }
                >
                  <div className="dlp-chiprow">
                    {DELIVERY_MODES.map((mode) => (
                      <InteractionTag
                        key={mode.code}
                        appearance="outline"
                        className={picked.includes(mode.code) ? "dlp-chip--picked" : "dlp-chip--unpicked"}
                      >
                        <InteractionTagPrimary
                          aria-pressed={picked.includes(mode.code)}
                          onClick={() =>
                            setChanges((p) => ({
                              ...p,
                              [key]: (picked.includes(mode.code)
                                ? picked.filter((item) => item !== mode.code)
                                : [...picked, mode.code]
                              ).join(", "),
                            }))
                          }
                        >
                          {picked.includes(mode.code) ? "✓ " : ""}{mode.name}
                        </InteractionTagPrimary>
                      </InteractionTag>
                    ))}
                  </div>
                </Field>
              );
            }
            return (
              <Field
                key={key}
                label={
                  <FieldLabel
                    label={FIELD_LABELS[key] ?? key}
                    tooltip={`Hiện tại: ${current[key]}`}
                  />
                }
              >
                <Input
                  value={value}
                  onChange={(_, d) => setChanges((p) => ({ ...p, [key]: d.value }))}
                />
              </Field>
            );
          })}
          <Field
            label={
              <FieldLabel
                label={requiresJustification ? "Lý do bắt buộc" : "Lý do (tuỳ chọn)"}
                tooltip={
                  requiresJustification
                    ? undefined
                    : "Không bắt buộc ở giai đoạn này, nhưng nhập vào thì nhật ký ghi lại."
                }
              />
            }
          >
            <Textarea value={reason} onChange={(_, d) => setReason(d.value)} />
          </Field>
          <Field label={requiresJustification ? "Bằng chứng bắt buộc" : "Bằng chứng (tuỳ chọn)"}>
            <FileDropField
              accept=".pdf,image/jpeg,image/png"
              compact
              pending={upload.isPending}
              pendingLabel="Đang tải tệp bằng chứng…"
              idle="Đính kèm email hoặc văn bản đề nghị của khách (JPEG · PNG · PDF)"
              selected={evidenceIds.length ? `Đã đính kèm ${evidenceIds.length} tệp` : undefined}
              buttonLabel={evidenceIds.length ? "Thêm tệp" : "Chọn tệp"}
              onFile={(file) => upload.mutate(file)}
            />
          </Field>
          {missing.length ? <span>Để lưu được, cần: {missing.join(", ")}.</span> : null}
          <Button
            appearance="primary"
            disabled={!!missing.length || patch.isPending}
            onClick={() => patch.mutate()}
          >
            Lưu thay đổi nhóm A
          </Button>
        </section>
        <section className="dlp-card" style={{ padding: 16, display: "grid", gap: 8 }}>
          <h2>Nhóm B · chỉ qua yêu cầu sửa được duyệt</h2>
          <p>
            Không gửi các trường này tới PATCH. Luồng phê duyệt yêu cầu sửa chưa có endpoint trong
            hợp đồng request hiện tại.
          </p>
          {groupB.map((key) => (
            <div key={key}>
              <Badge appearance="tint" color={toneToColor("warning")}>
                {groupFieldLabel(key)}
              </Badge>{" "}
              {groupFieldValue(record, key)}
            </div>
          ))}
        </section>
        <section className="dlp-card" style={{ padding: 16, display: "grid", gap: 8 }}>
          <h2>Nhóm C · bất biến</h2>
          {groupC.map((key) => (
            <div key={key}>
              <Badge appearance="tint" color={toneToColor("info")}>
                {groupFieldLabel(key)}
              </Badge>{" "}
              {groupFieldValue(record, key)}
            </div>
          ))}
        </section>
      </div>
    </>
  );
}
