import {
  Badge,
  Button,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerHeaderTitle,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Option,
  Textarea,
} from "@fluentui/react-components";
import { Dismiss20Regular, Edit20Regular, LockClosed20Regular } from "@fluentui/react-icons";
import { useState } from "react";
import { FieldLabel } from "@/components/lims/common";
import {
  CUSTOMER_BRANCHES,
  CUSTOMER_SEGMENTS,
  customerDebt,
  debtBucket,
  invoiceBalance,
  invoiceOverdueDays,
  type CustomerEditableFields,
  type CustomerRow,
} from "@/lib/admin/customer-data";
import { formatAmount } from "@/lib/format";
import { toneToColor } from "@/lib/admin/tone";

const label: React.CSSProperties = { color: "var(--foreground-secondary)" };
const groupTitle: React.CSSProperties = {
  font: "600 12px/16px var(--font-family-base)",
  color: "var(--foreground-secondary)",
  marginBottom: 8,
};
const boxed: React.CSSProperties = {
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-surface)",
  overflow: "hidden",
};

function Row({ name, value }: { name: string; value: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 12, padding: "6px 10px", minWidth: 0 }}>
      <span style={{ ...label, flex: "0 0 132px" }}>{name}</span>
      <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{value}</span>
    </div>
  );
}

function draftFrom(customer: CustomerRow): CustomerEditableFields {
  return {
    name: customer.name,
    address: customer.address,
    representative: customer.representative,
    phone: customer.phone,
    email: customer.email,
    branch: customer.branch,
    segment: customer.segment,
    ...(customer.contractCode ? { contractCode: customer.contractCode } : {}),
    creditLimit: customer.creditLimit,
    paymentTermDays: customer.paymentTermDays,
  };
}

/* K-01b · Hồ sơ khách hàng: xem đầy đủ thông tin, công nợ chi tiết, sửa thông tin và khoá/mở
   khoá. Khoá và mở khoá đều đòi lý do - đó là thao tác chặn khách hàng phát sinh yêu cầu mới,
   nên phải trả lời được "vì sao" khi đối chiếu về sau. */
export function CustomerDetailDrawer({
  customer,
  canWrite,
  today,
  onClose,
  onSave,
  onLock,
  onUnlock,
  ledgerActions,
}: {
  customer: CustomerRow | null;
  canWrite: boolean;
  today: Date;
  onClose: () => void;
  onSave: (customer: CustomerRow, changes: CustomerEditableFields) => void;
  onLock: (customer: CustomerRow, reason: string) => void;
  /** Ô thao tác ghi sổ (phát hành hoá đơn, ghi phiếu thu). Truyền từ chỗ gọi thay vì dựng ở đây:
   *  ngăn kéo này dùng chung cho cả nhánh demo lẫn nhánh thật, và chỉ nhánh thật mới có chỗ ghi. */
  ledgerActions?: React.ReactNode;
  onUnlock: (customer: CustomerRow, reason: string) => void;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "lock">("view");
  const [reason, setReason] = useState("");
  // Biểu mẫu nạp lại mỗi khi đổi khách hàng - `customer.id` làm khoá thay vì một useEffect đồng
  // bộ hai chiều, cùng cách với hồ sơ người dùng (A-01c).
  const [draft, setDraft] = useState<CustomerEditableFields | null>(null);
  const [draftFor, setDraftFor] = useState<string | null>(null);
  if (customer && draftFor !== customer.id) {
    setDraftFor(customer.id);
    setDraft(draftFrom(customer));
    setMode("view");
    setReason("");
  }

  if (!customer) return null;
  const form = draft ?? draftFrom(customer);
  const set = <K extends keyof CustomerEditableFields>(key: K, value: CustomerEditableFields[K]) =>
    setDraft({ ...form, [key]: value });

  const debt = customerDebt(customer, today);
  const bucket = debtBucket(debt);
  const locked = customer.status === "locked";
  const nameInvalid = form.name.trim().length === 0;
  const limitInvalid = !Number.isFinite(form.creditLimit) || form.creditLimit < 0;
  const termInvalid = !Number.isFinite(form.paymentTermDays) || form.paymentTermDays < 0;
  const editInvalid = nameInvalid || limitInvalid || termInvalid;

  const close = () => {
    setMode("view");
    setReason("");
    onClose();
  };

  return (
    <Drawer type="overlay" position="end" size="full" open onOpenChange={close}>
      <DrawerHeader>
        <DrawerHeaderTitle
          action={
            <Button
              appearance="subtle"
              icon={<Dismiss20Regular />}
              aria-label="Đóng hồ sơ khách hàng"
              onClick={close}
            />
          }
        >
          {customer.name}
        </DrawerHeaderTitle>
        <div className="dlp-chiprow" style={{ marginTop: 4 }}>
          <Badge appearance="tint" color={locked ? "danger" : "success"}>
            {locked ? "Đã khoá" : "Đang hoạt động"}
          </Badge>
          <Badge appearance="tint" color={toneToColor(bucket.tone)}>
            {bucket.label}
          </Badge>
          <span className="dlp-datagrid__secondary dlp-num">{customer.id}</span>
        </div>
      </DrawerHeader>

      <DrawerBody>
        <div style={{ display: "grid", gap: 16, paddingBottom: 12 }}>
          {locked ? (
            <MessageBar intent="error" layout="multiline">
              <MessageBarBody>
                <MessageBarTitle>Khách hàng đang bị khoá từ {customer.lockedOn}:</MessageBarTitle>{" "}
                {customer.lockReason} Không thể tạo yêu cầu thử nghiệm mới cho khách hàng này cho
                tới khi được mở khoá.
              </MessageBarBody>
            </MessageBar>
          ) : debt.overLimit ? (
            <MessageBar intent="warning" layout="multiline">
              <MessageBarBody>
                <MessageBarTitle>Vượt hạn mức công nợ:</MessageBarTitle> còn nợ{" "}
                {formatAmount(debt.outstanding)} trên hạn mức {formatAmount(customer.creditLimit)}.
              </MessageBarBody>
            </MessageBar>
          ) : null}

          {mode === "edit" ? (
            <div style={{ display: "grid", gap: 12 }}>
              <div style={groupTitle}>Sửa thông tin khách hàng</div>
              <Field
                label="Tên khách hàng"
                required
                validationState={nameInvalid ? "error" : "none"}
                validationMessage={nameInvalid ? "Tên khách hàng không được để trống." : undefined}
              >
                <Input value={form.name} onChange={(_, d) => set("name", d.value)} />
              </Field>
              <Field label="Người đại diện">
                <Input
                  value={form.representative}
                  onChange={(_, d) => set("representative", d.value)}
                />
              </Field>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Field label="Điện thoại">
                  <Input value={form.phone} onChange={(_, d) => set("phone", d.value)} />
                </Field>
                <Field label="Email">
                  <Input
                    type="email"
                    value={form.email}
                    onChange={(_, d) => set("email", d.value)}
                  />
                </Field>
              </div>
              <Field label="Địa chỉ">
                <Textarea
                  value={form.address}
                  resize="vertical"
                  onChange={(_, d) => set("address", d.value)}
                />
              </Field>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Field label="Phân loại">
                  <Dropdown
                    value={form.segment}
                    selectedOptions={[form.segment]}
                    onOptionSelect={(_, d) =>
                      set("segment", (d.optionValue as CustomerRow["segment"]) ?? form.segment)
                    }
                  >
                    {CUSTOMER_SEGMENTS.map((s) => (
                      <Option key={s} value={s}>
                        {s}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
                <Field label="Chi nhánh phục vụ">
                  <Dropdown
                    value={form.branch}
                    selectedOptions={[form.branch]}
                    onOptionSelect={(_, d) => set("branch", d.optionValue ?? form.branch)}
                  >
                    {CUSTOMER_BRANCHES.map((b) => (
                      <Option key={b} value={b}>
                        {b}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              </div>
              <Field label="Số hợp đồng">
                <Input
                  value={form.contractCode ?? ""}
                  placeholder="HĐ-2026/000"
                  onChange={(_, d) => set("contractCode", d.value)}
                />
              </Field>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Field
                  label="Hạn mức công nợ (VND)"
                  validationState={limitInvalid ? "error" : "none"}
                  validationMessage={limitInvalid ? "Nhập số không âm." : undefined}
                >
                  <Input
                    type="number"
                    min={0}
                    step={1_000_000}
                    value={String(form.creditLimit)}
                    onChange={(_, d) => set("creditLimit", Number(d.value))}
                  />
                </Field>
                <Field
                  label="Hạn thanh toán (ngày)"
                  validationState={termInvalid ? "error" : "none"}
                  validationMessage={termInvalid ? "Nhập số không âm." : undefined}
                >
                  <Input
                    type="number"
                    min={0}
                    value={String(form.paymentTermDays)}
                    onChange={(_, d) => set("paymentTermDays", Number(d.value))}
                  />
                </Field>
              </div>
            </div>
          ) : (
            <>
              <div>
                <div style={groupTitle}>Thông tin khách hàng</div>
                <div style={boxed}>
                  <Row
                    name="Mã khách hàng"
                    value={<span className="dlp-num">{customer.id}</span>}
                  />
                  <Row
                    name="Mã số thuế"
                    value={<span className="dlp-num">{customer.taxCode}</span>}
                  />
                  <Row name="Phân loại" value={customer.segment} />
                  <Row name="Người đại diện" value={customer.representative} />
                  <Row
                    name="Điện thoại"
                    value={<span className="dlp-num">{customer.phone}</span>}
                  />
                  <Row name="Email" value={customer.email} />
                  <Row name="Địa chỉ" value={customer.address} />
                  <Row name="Chi nhánh phục vụ" value={customer.branch} />
                  <Row
                    name="Số hợp đồng"
                    value={customer.contractCode ?? "Chưa có hợp đồng khung"}
                  />
                  <Row name="Khách hàng từ" value={customer.createdOn} />
                </div>
              </div>

              <div>
                <div style={groupTitle}>Công nợ</div>
                <div style={boxed}>
                  <Row
                    name="Hạn mức"
                    value={
                      <>
                        {formatAmount(customer.creditLimit)} · thanh toán trong{" "}
                        {customer.paymentTermDays} ngày
                      </>
                    }
                  />
                  <Row
                    name="Còn nợ"
                    value={<strong className="dlp-num">{formatAmount(debt.outstanding)}</strong>}
                  />
                  <Row
                    name="Trong đó quá hạn"
                    value={
                      <span
                        className="dlp-num"
                        style={
                          debt.overdue > 0
                            ? { color: "var(--status-danger-foreground)" }
                            : undefined
                        }
                      >
                        {formatAmount(debt.overdue)}
                        {debt.overdueDays > 0 ? ` · trễ ${debt.overdueDays} ngày` : ""}
                      </span>
                    }
                  />
                  <Row
                    name="Hoạt động"
                    value={`${customer.totalRecords} hồ sơ · gần nhất ${customer.lastRecordOn}`}
                  />
                </div>
              </div>

              <div>
                <div style={groupTitle}>Chi tiết khoản phải thu</div>
                <div className="dlp-card" style={{ overflowX: "auto", padding: 0 }}>
                  <table className="dlp-datagrid" style={{ minWidth: 460 }}>
                    <thead>
                      <tr>
                        <th>Hoá đơn</th>
                        <th>Hồ sơ</th>
                        <th>Hạn TT</th>
                        <th style={{ textAlign: "right" }}>Còn nợ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {customer.invoices.map((invoice) => {
                        const balance = invoiceBalance(invoice);
                        const late = invoiceOverdueDays(invoice, today);
                        return (
                          <tr key={invoice.id}>
                            <td className="dlp-num">{invoice.id}</td>
                            <td className="dlp-num">{invoice.recordCode}</td>
                            <td className="dlp-num">
                              {invoice.dueOn}
                              {late > 0 ? (
                                <div
                                  className="dlp-datagrid__secondary"
                                  style={{ color: "var(--status-danger-foreground)" }}
                                >
                                  trễ {late} ngày
                                </div>
                              ) : null}
                            </td>
                            <td className="dlp-num" style={{ textAlign: "right" }}>
                              {balance > 0 ? formatAmount(balance) : "Đã thanh toán"}
                              <div className="dlp-datagrid__secondary">
                                {formatAmount(invoice.amount)}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {ledgerActions ? (
                <div>
                  <div style={groupTitle}>Ghi sổ công nợ</div>
                  {ledgerActions}
                </div>
              ) : null}
            </>
          )}

          {mode === "lock" ? (
            <Field
              label={
                <FieldLabel
                  label={locked ? "Lý do mở khoá" : "Lý do khoá khách hàng"}
                  tooltip={
                    locked
                      ? "Ghi rõ căn cứ mở khoá (đã thanh toán, đã bổ sung hồ sơ…)."
                      : "Khoá sẽ chặn tạo yêu cầu thử nghiệm mới cho khách hàng này."
                  }
                />
              }
              required
            >
              <Textarea
                value={reason}
                resize="vertical"
                placeholder={
                  locked
                    ? "Khách hàng đã thanh toán toàn bộ công nợ quá hạn ngày…"
                    : "Quá hạn công nợ trên 60 ngày, đã nhắc 2 lần…"
                }
                onChange={(_, d) => setReason(d.value)}
              />
            </Field>
          ) : null}
        </div>
      </DrawerBody>

      <DrawerFooter>
        {mode === "view" ? (
          <>
            <Button
              appearance="primary"
              icon={<Edit20Regular />}
              disabled={!canWrite}
              onClick={() => setMode("edit")}
            >
              Sửa thông tin
            </Button>
            <Button
              icon={<LockClosed20Regular />}
              disabled={!canWrite}
              onClick={() => {
                setReason("");
                setMode("lock");
              }}
            >
              {locked ? "Mở khoá" : "Khoá khách hàng"}
            </Button>
            <Button appearance="subtle" onClick={close}>
              Đóng
            </Button>
          </>
        ) : mode === "edit" ? (
          <>
            <Button
              appearance="primary"
              disabled={editInvalid}
              onClick={() => {
                onSave(customer, { ...form, name: form.name.trim() });
                setMode("view");
              }}
            >
              Lưu thay đổi
            </Button>
            <Button
              appearance="subtle"
              onClick={() => {
                setDraft(draftFrom(customer));
                setMode("view");
              }}
            >
              Huỷ
            </Button>
          </>
        ) : (
          <>
            <Button
              appearance="primary"
              disabled={reason.trim().length === 0}
              onClick={() => {
                const note = reason.trim();
                if (locked) onUnlock(customer, note);
                else onLock(customer, note);
                setReason("");
                setMode("view");
              }}
            >
              {locked ? "Xác nhận mở khoá" : "Xác nhận khoá"}
            </Button>
            <Button
              appearance="subtle"
              onClick={() => {
                setReason("");
                setMode("view");
              }}
            >
              Huỷ
            </Button>
          </>
        )}
      </DrawerFooter>
    </Drawer>
  );
}
