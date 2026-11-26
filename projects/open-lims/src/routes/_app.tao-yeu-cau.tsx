import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import {
  Field,
  Input,
  InteractionTag,
  InteractionTagPrimary,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Textarea,
} from "@fluentui/react-components";
import { NoAccess } from "@/components/lims/NoAccess";
import { card, hintText, sectionTitle, subLabel } from "@/components/lims/request-styles";
import { CustomerPicker, type NewCustomerInput } from "@/components/lims/customer";
import {
  FieldLabel,
  FileDropField,
  PageHead,
  PermissionButton,
  useDlpToast,
} from "@/components/lims/common";
import { useAuth } from "@/lib/auth/AuthProvider";
import { PERM } from "@/lib/admin/rbac";
import {
  REQ_CUSTOMERS,
  REQ_DELIVERY,
  REQ_FIELDS,
  REQ_NEXT_CODE,
  REQ_PARAMS,
  type ReqCustomer,
} from "@/lib/admin/request-data";
import { searchString } from "@/lib/route-search";
import { RemoteNewRequestPage } from "@/features/request/ui/remote-new-request-page";

interface Search {
  draftId?: string;
}
export const Route = createFileRoute("/_app/tao-yeu-cau")({
  // Router serialises search values with JSON, so the string id "2" lands in the URL as
  // `draftId=%222%22`; only its own parser turns that back into "2". `searchString` cũng nhận
  // dạng gõ tay `?draftId=2`, vốn được JSON đọc ra number.
  validateSearch: (search: Record<string, unknown>): Search => {
    const draftId = searchString(search["draftId"]);
    return draftId ? { draftId } : {};
  },
  head: () => ({
    meta: [
      { title: "Tạo yêu cầu thử nghiệm - DLP LIMS" },
      {
        name: "description",
        content:
          "Số hoá phiếu BM01: khai báo lô hàng, chỉ tiêu thử nghiệm, hình thức nhận kết quả và bản cam kết có chữ ký khách hàng.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: NewRequestScreen,
});

function NewRequestScreen() {
  const { can, usesClerk } = useAuth();
  // Nháp không có mã (BR-003 chỉ sinh mã khi hồ sơ rời DRAFT) - mở lại để hoàn tất qua chính
  // màn tạo yêu cầu, định danh bằng id thay vì mã.
  const { draftId } = Route.useSearch();
  // POST /test-requests chỉ đòi REQUEST_CREATE (TestRequestResource) - không đòi thêm quyền đọc.
  if (usesClerk && !can(PERM.REQUEST_CREATE)) {
    return <NoAccess screen="Tạo yêu cầu thử nghiệm" />;
  }
  return usesClerk ? <RemoteNewRequestPage draftId={draftId} /> : <DemoNewRequestScreen />;
}

function DemoNewRequestScreen() {
  const { can } = useAuth();
  const toast = useDlpToast();
  const navigate = useNavigate();

  const [selectedCustomer, setSelectedCustomer] = useState<ReqCustomer>();
  const [values, setValues] = useState<Record<string, string>>({});
  const [params, setParams] = useState<string[]>([]);
  const [delivery, setDelivery] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [bm01, setBm01] = useState<string>();

  // Bản demo tìm ngay trên dữ liệu tĩnh, nhưng vẫn trả Promise để dùng chung một ô chọn khách
  // hàng với bản chạy thật.
  const searchCustomers = useCallback(
    (query: string) =>
      Promise.resolve(
        REQ_CUSTOMERS.filter((c) =>
          `${c.name} ${c.taxCode ?? ""}`.toLowerCase().includes(query.toLowerCase()),
        ),
      ),
    [],
  );
  const createCustomer = useCallback(
    (input: NewCustomerInput) => {
      const created: ReqCustomer = {
        ...input,
        id: `KH-${String(REQ_CUSTOMERS.length + 1).padStart(4, "0")}`,
      };
      toast(`Đã tạo khách hàng ${created.name}`, `Mã khách hàng ${created.id}`);
      return Promise.resolve(created);
    },
    [toast],
  );
  // Người đại diện và điện thoại của khách được điền sẵn, đúng như bản thật nạp từ bản ghi khách
  // hàng - người nhập chỉ sửa khi lô này khác.
  const pickCustomer = (customer: ReqCustomer | undefined) => {
    setSelectedCustomer(customer);
    if (!customer) return;
    setValues((v) => ({
      ...v,
      lienhe: customer.representative ?? v["lienhe"] ?? "",
      phone: customer.phone ?? v["phone"] ?? "",
    }));
  };

  const missing = useMemo(() => {
    const list: string[] = [];
    if (!selectedCustomer) list.push("Khách hàng");
    list.push(
      ...REQ_FIELDS.filter((f) => f.required && !(values[f.key] ?? "").trim()).map((f) => f.label),
    );
    if (params.length === 0) list.push("Chỉ tiêu thử nghiệm");
    if (delivery.length === 0) list.push("Hình thức nhận kết quả");
    if (!bm01) list.push("Bản BM01 có chữ ký khách hàng");
    return list;
  }, [selectedCustomer, values, params, delivery, bm01]);

  if (!can(PERM.REQUEST_CREATE)) return <NoAccess screen="Tạo yêu cầu thử nghiệm" />;
  const canWrite = can(PERM.REQUEST_CREATE);

  const ready = missing.length === 0;
  const toggle = (list: string[], set: (v: string[]) => void, v: string) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const saveDraft = () =>
    toast(
      "Đã lưu nháp yêu cầu",
      "Hồ sơ ở trạng thái «Chờ bổ sung thông tin», chưa sinh mã hồ sơ.",
      "info",
    );

  const submit = () => {
    toast(
      `Đã tiếp nhận yêu cầu ${REQ_NEXT_CODE}`,
      "Hồ sơ chuyển «Chờ thanh toán / Chờ phân công»; nhắc thanh toán ngày 5 và ngày 7.",
    );
    void navigate({ to: "/ho-so" });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 1200, minWidth: 0 }}>
      <PageHead
        crumbs={[{ label: "Hồ sơ kiểm nghiệm", to: "/ho-so" }, { label: "Tạo yêu cầu mới" }]}
        title="Tạo yêu cầu thử nghiệm"
        description="Số hoá BM01 Rev 00 · mã hồ sơ do hệ thống sinh khi hồ sơ hợp lệ"
        actions={
          <>
            <PermissionButton allowed={canWrite} onClick={saveDraft}>
              Lưu nháp
            </PermissionButton>
            <PermissionButton
              allowed={canWrite}
              appearance="primary"
              disabled={!ready}
              tooltip={ready ? "" : "Còn trường bắt buộc chưa điền"}
              onClick={submit}
            >
              Hoàn tất tiếp nhận
            </PermissionButton>
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
            <div style={sectionTitle}>I · Thông tin lô hàng</div>

            {/* Khách hàng là một bản ghi được chọn hoặc tạo mới, không phải một ô chữ tự do -
                cùng luồng với bản chạy thật, vì mã khách hàng mới là thứ hồ sơ tham chiếu tới. */}
            <Field label="Khách hàng" required>
              <CustomerPicker
                value={selectedCustomer}
                onChange={pickCustomer}
                onSearch={searchCustomers}
                onCreate={createCustomer}
                disabled={!canWrite}
              />
            </Field>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))",
                gap: 12,
              }}
            >
              {REQ_FIELDS.map((f) => (
                <Field
                  key={f.key}
                  label={<FieldLabel label={f.label} tooltip={f.hint} />}
                  required={!!f.required}
                >
                  <Input
                    value={values[f.key] ?? ""}
                    placeholder={f.placeholder}
                    disabled={!canWrite}
                    onChange={(_, d) => setValues((v) => ({ ...v, [f.key]: d.value }))}
                  />
                </Field>
              ))}
            </div>
          </div>

          <div style={card}>
            <div style={sectionTitle}>II · Nội dung đề nghị</div>
            <div>
              <div style={subLabel}>Chỉ tiêu thử nghiệm - chọn ít nhất một</div>
              <div className="dlp-chiprow">
                {REQ_PARAMS.map((p) => (
                  <InteractionTag
                    key={p}
                    appearance="outline"
                    className={params.includes(p) ? "dlp-chip--picked" : "dlp-chip--unpicked"}
                  >
                    <InteractionTagPrimary
                      aria-pressed={params.includes(p)}
                      disabled={!canWrite}
                      onClick={() => toggle(params, setParams, p)}
                    >
                      {params.includes(p) ? "✓ " : ""}
                      {p}
                    </InteractionTagPrimary>
                  </InteractionTag>
                ))}
              </div>
            </div>
            <div>
              <div style={subLabel}>Hình thức nhận kết quả - chọn ít nhất một</div>
              <div className="dlp-chiprow">
                {REQ_DELIVERY.map((p) => (
                  <InteractionTag
                    key={p}
                    appearance="outline"
                    className={delivery.includes(p) ? "dlp-chip--picked" : "dlp-chip--unpicked"}
                  >
                    <InteractionTagPrimary
                      aria-pressed={delivery.includes(p)}
                      disabled={!canWrite}
                      onClick={() => toggle(delivery, setDelivery, p)}
                    >
                      {delivery.includes(p) ? "✓ " : ""}
                      {p}
                    </InteractionTagPrimary>
                  </InteractionTag>
                ))}
              </div>
            </div>
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
                disabled={!canWrite}
                placeholder="Ví dụ: mã lô LOT-0825; khách xin trả kết quả sớm hơn nếu được"
                onChange={(_, d) => setNote(d.value)}
              />
            </Field>
          </div>

          <div style={{ ...card, gap: 12 }}>
            <div style={sectionTitle}>III · Cam kết và bản BM01 gốc</div>
            <FileDropField
              accept="image/jpeg,image/png,application/pdf"
              disabled={!canWrite}
              idle="Tải bản BM01 có chữ ký khách hàng (JPEG · PNG · PDF)"
              selected={bm01 ? `Đã đính kèm ${bm01} · bấm để thay tệp khác` : undefined}
              buttonLabel={bm01 ? "Chọn tệp khác" : "Chọn tệp"}
              onFile={(file) => setBm01(file.name)}
            />
            <span style={hintText}>
              Bản scan/ảnh có chữ ký khách hàng là bằng chứng cam kết. Chọn revision BM01 đang hiệu
              lực: Rev 00.
            </span>
            <span style={hintText}>
              Hồ sơ chưa có ô hạn trả kết quả - hẹn ngày trả với khách ngoài hệ thống. Mã lô là ô
              ghi chú tự do, không bắt buộc.
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
          <MessageBar intent={ready ? "success" : "warning"}>
            <MessageBarBody>
              <MessageBarTitle>
                {ready ? "Sẵn sàng tiếp nhận:" : "Hồ sơ chưa hợp lệ:"}
              </MessageBarTitle>{" "}
              {ready
                ? "Hoàn tất tiếp nhận sẽ sinh mã hồ sơ và chuyển hồ sơ sang «Chờ thanh toán / Chờ phân công»."
                : "Lưu nháp được bất kỳ lúc nào. Hồ sơ ở trạng thái «Chờ bổ sung thông tin» cho tới khi đủ trường bắt buộc."}
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
            <div style={sectionTitle}>Mã hồ sơ</div>
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
