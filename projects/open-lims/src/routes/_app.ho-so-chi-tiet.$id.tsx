import { parseVndInput } from "@/lib/format";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  Badge,
  Button,
  Field,
  Input,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  Tab,
  TabList,
  Textarea,
} from "@fluentui/react-components";
import { ArrowDownload20Regular } from "@fluentui/react-icons";
import {
  FileDropField,
  PageHead,
  PermissionButton,
  VndAmountInput,
  useDlpToast,
} from "@/components/lims/common";
import { HandoverCard, type ScanMethod } from "@/components/lims/intake/HandoverCard";
import { AssignSamplingDrawer } from "@/components/lims/sampling/AssignSamplingDrawer";
import { NoAccess } from "@/components/lims/NoAccess";
import { useAuth } from "@/lib/auth/AuthProvider";
import { PERM } from "@/lib/admin/rbac";
import {
  MOCK_RECORDS,
  PII_MASK,
  RECORD_ACCESS_LOG,
  RECORD_AUDIT,
  RECORD_BM02_HEAD,
  RECORD_CERTIFICATES,
  RECORD_CHECK_CONCLUSION,
  RECORD_DRAFT_NOTE,
  RECORD_DRAFT_SENDS,
  RECORD_FIELDS,
  RECORD_FIELD_CHECK,
  RECORD_FIELD_FIX,
  RECORD_FILES,
  RECORD_FIX_NOTE,
  RECORD_SAMPLE_ROWS,
  RECORD_SAMPLING_ASSIGN,
  RECORD_SAMPLING_SIGN,
  RECORD_SEAL_CHECK,
  RECORD_TASKS,
  RECORD_TASK_PROGRESS,
  RECORD_TIMELINE,
} from "@/lib/admin/records-data";
import { HANDOVER_COUNTERPARTS, HANDOVER_LOG } from "@/lib/admin/lab-data";
import { toneToColor } from "@/lib/admin/tone";
import { RemoteRecordDetailPage } from "@/features/request/ui/remote-record-detail-page";

export const Route = createFileRoute("/_app/ho-so-chi-tiet/$id")({
  head: () => ({
    meta: [
      { title: "Chi tiết hồ sơ kiểm nghiệm - DLP LIMS" },
      {
        name: "description",
        content:
          "Chi tiết hồ sơ kiểm nghiệm: khai báo BM01, thanh toán, lấy mẫu BM02/BM03, mẫu & kết quả, phiếu và lịch sử.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: RecordDetail,
});

const TABS = [
  "Tổng quan",
  "Thanh toán",
  "Lấy mẫu",
  "Mẫu & kết quả",
  "Phiếu",
  "Lịch sử",
  "Huỷ & bàn giao",
] as const;

// Cổng thô cho các nút hành động trên chi tiết hồ sơ; `allowedActions` theo hồ sơ (server trả,
// khác vocabulary quyền toàn cục - xem api-map.md request) mới là cổng tinh cho từng nút.
function canWriteRequestActions(can: (perm: string) => boolean): boolean {
  return (
    can(PERM.REQUEST_PATCH_GROUP_A) ||
    can(PERM.REQUEST_CANCEL) ||
    can(PERM.PAYMENT_CONFIRM) ||
    can(PERM.PAYMENT_EXCEPTION)
  );
}

function RecordDetail() {
  const { id } = Route.useParams();
  const { can, usesClerk } = useAuth();
  if (!can(PERM.REQUEST_READ)) return <NoAccess screen="Chi tiết hồ sơ" />;
  return usesClerk ? (
    <RemoteRecordDetailPage code={id} canWrite={canWriteRequestActions(can)} />
  ) : (
    <DemoRecordDetail />
  );
}

function DemoRecordDetail() {
  const { id } = Route.useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const toast = useDlpToast();
  const [tab, setTab] = useState<string>(TABS[0]);
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignedTo, setAssignedTo] = useState<string | null>(null);

  const record = MOCK_RECORDS.find((r) => r.id === id) ?? MOCK_RECORDS[0]!;
  const canPii = can(PERM.REQUEST_CUSTOMER_VIEW);

  if (!can(PERM.REQUEST_READ)) return <NoAccess screen="Chi tiết hồ sơ" />;
  const canWrite = canWriteRequestActions(can);
  const customer = canPii ? record.customer : PII_MASK;

  return (
    <>
      <PageHead
        crumbs={[{ label: "Hồ sơ kiểm nghiệm", to: "/ho-so" }, { label: record.id }]}
        title={`Hồ sơ ${record.id}`}
        description={`${record.product} · ${customer} · ${record.criteria === "VO + CD" ? "Vàng O + Cadimi" : record.criteria}`}
        actions={
          <>
            <PermissionButton
              allowed={canWrite}
              appearance="primary"
              onClick={() => setAssignOpen(true)}
            >
              {assignedTo ? "Đổi người lấy mẫu" : "Phân công lấy mẫu"}
            </PermissionButton>
            <PermissionButton
              allowed={canWrite}
              onClick={() => void navigate({ to: "/sua-ho-so", search: { code: record.id } })}
            >
              Sửa hồ sơ
            </PermissionButton>
            <PermissionButton allowed={canWrite} onClick={() => setTab("Huỷ & bàn giao")}>
              Huỷ hồ sơ
            </PermissionButton>
          </>
        }
      />

      {assignedTo ? (
        <MessageBar intent="success" style={{ marginBottom: 12 }}>
          <MessageBarBody>
            <MessageBarTitle>Đã phân công lấy mẫu:</MessageBarTitle>
            {assignedTo}
          </MessageBarBody>
        </MessageBar>
      ) : null}

      <AssignSamplingDrawer
        recordId={record.id}
        open={assignOpen}
        onOpenChange={setAssignOpen}
        onConfirm={(r) => {
          setAssignOpen(false);
          setAssignedTo(`${r.samplerName} · ${r.date} ${r.time} · ${r.place}`);
          toast(
            `Đã phân công ${record.id} cho ${r.samplerName}`,
            `Điện thoại nhân viên đã nhận thông báo: ${r.date} ${r.time} · ${r.place}`,
          );
        }}
      />

      <div className="dlp-chiprow" style={{ marginBottom: 16 }}>
        <Badge appearance="tint" color={toneToColor(record.statusTone)}>
          {record.status}
        </Badge>
        <Badge appearance="tint" color={toneToColor(record.payTone)}>
          Thanh toán: {record.pay}
        </Badge>
      </div>

      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)}>
        {TABS.map((t) => (
          <Tab key={t} value={t}>
            {t}
          </Tab>
        ))}
      </TabList>

      <div style={{ marginTop: 16 }}>
        {tab === "Tổng quan" ? <TabOverview canPii={canPii} /> : null}
        {tab === "Thanh toán" ? <TabPayment canWrite={canWrite} /> : null}
        {tab === "Lấy mẫu" ? <TabSampling canPii={canPii} code={record.id} /> : null}
        {tab === "Mẫu & kết quả" ? <TabResults /> : null}
        {tab === "Phiếu" ? <TabCertificates canWrite={canWrite} code={record.id} /> : null}
        {tab === "Lịch sử" ? <TabHistory /> : null}
        {tab === "Huỷ & bàn giao" ? (
          <TabCancelHandover canWrite={canWrite} code={record.id} />
        ) : null}
      </div>
    </>
  );
}

function Section({
  title,
  children,
  actions,
}: {
  title: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="dlp-card" style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: "var(--font-size-400)", fontWeight: 600 }}>{title}</h2>
        <div style={{ flex: 1 }} />
        {actions}
      </div>
      {children}
    </div>
  );
}

function FieldGrid({
  items,
  canPii = true,
}: {
  items: { k: string; v: string; pii?: boolean }[];
  canPii?: boolean;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
        gap: "12px 24px",
      }}
    >
      {items.map((f) => (
        <div key={f.k}>
          <div style={{ fontSize: "var(--font-size-200)", color: "var(--foreground-secondary)" }}>
            {f.k}
          </div>
          <div style={{ fontWeight: 500 }}>{f.pii && !canPii ? <em>{PII_MASK}</em> : f.v}</div>
        </div>
      ))}
    </div>
  );
}

function TabOverview({ canPii }: { canPii: boolean }) {
  return (
    <div className="dlp-split">
      <div>
        <Section
          title="Khai báo BM01/HD-01 · Rev 00"
          actions={
            <Button size="small" icon={<ArrowDownload20Regular />}>
              BM01-26100012-goc.pdf
            </Button>
          }
        >
          <FieldGrid items={RECORD_FIELDS} canPii={canPii} />
        </Section>
      </div>
      <Section title="Nhật ký hồ sơ">
        <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 14 }}>
          {RECORD_TIMELINE.map((t) => (
            <li key={t.what} style={{ display: "flex", gap: 10 }}>
              <span
                aria-hidden="true"
                style={{
                  marginTop: 6,
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: "var(--action-primary)",
                  flex: "0 0 auto",
                }}
              />
              <span>
                <span style={{ display: "block", fontWeight: 500 }}>{t.what}</span>
                <span
                  style={{
                    display: "block",
                    fontSize: "var(--font-size-200)",
                    color: "var(--foreground-secondary)",
                  }}
                >
                  {t.who}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}

function TabPayment({ canWrite }: { canWrite: boolean }) {
  const toast = useDlpToast();
  const [evidence, setEvidence] = useState<string>();
  const [amount, setAmount] = useState("");
  const paymentAmount = parseVndInput(amount);
  const validPaymentAmount =
    Number.isFinite(paymentAmount) && paymentAmount > 0 && paymentAmount <= Number.MAX_SAFE_INTEGER;
  const [note, setNote] = useState("");
  const [exceptionReason, setExceptionReason] = useState("");
  const [exceptionEvidence, setExceptionEvidence] = useState<string>();

  return (
    <div className="dlp-split">
      <Section title="Xác nhận thanh toán">
        <div style={{ display: "grid", gap: 12, maxWidth: 460 }}>
          <Field label="Tài liệu bằng chứng">
            <FileDropField
              accept=".pdf,image/jpeg,image/png"
              idle="Tải chứng từ thanh toán (JPEG · PNG · PDF)"
              selected={evidence ? `Đã chọn ${evidence}` : undefined}
              onFile={(file) => setEvidence(file.name)}
            />
          </Field>
          <Field label="Số tiền (VND)" required hint="Ví dụ: 1,500,000.50 ₫">
            <VndAmountInput
              required
              placeholder="1,500,000.50"
              value={amount}
              onChange={setAmount}
            />
          </Field>
          <Field label="Ghi chú (tuỳ chọn)">
            <Textarea
              value={note}
              placeholder="Số UNC, ngân hàng, ngày chuyển…"
              onChange={(_, d) => setNote(d.value)}
            />
          </Field>
          <PermissionButton
            allowed={canWrite}
            appearance="primary"
            disabled={!evidence || !validPaymentAmount}
            tooltip={
              !evidence
                ? "Cần chứng từ thanh toán"
                : !validPaymentAmount
                  ? "Cần số tiền dương hợp lệ"
                  : ""
            }
            onClick={() =>
              toast(
                "Đã xác nhận thanh toán",
                `${evidence}${amount ? ` · ${amount} VND` : ""} · hồ sơ mở đường chuyển lab`,
              )
            }
          >
            Xác nhận đã thanh toán
          </PermissionButton>
        </div>
      </Section>
      <div>
        <MessageBar intent="warning" style={{ marginBottom: 16 }}>
          <MessageBarBody>
            <MessageBarTitle>Chờ xác nhận thanh toán.</MessageBarTitle> Còn 2 ngày trước khi khoá
            chuyển lab.
          </MessageBarBody>
        </MessageBar>
        {/* Ngoại lệ thanh toán đi cùng bộ điều kiện với bản chạy thật: phải có lý do VÀ tài liệu
            bằng chứng thì nút mới mở, vì đây là lần duy nhất hồ sơ đi tiếp mà chưa có tiền về. */}
        <Section title="Ngoại lệ thanh toán">
          <div style={{ display: "grid", gap: 12 }}>
            <Field label="Lý do">
              <Textarea
                value={exceptionReason}
                placeholder="Ví dụ: khách là đối tác trả sau theo hợp đồng khung 2026"
                onChange={(_, d) => setExceptionReason(d.value)}
              />
            </Field>
            <Field label="Tài liệu bằng chứng">
              <FileDropField
                accept=".pdf,image/jpeg,image/png"
                idle="Tải văn bản phê duyệt ngoại lệ (JPEG · PNG · PDF)"
                selected={exceptionEvidence ? `Đã chọn ${exceptionEvidence}` : undefined}
                onFile={(file) => setExceptionEvidence(file.name)}
              />
            </Field>
            <PermissionButton
              allowed={canWrite}
              disabled={!exceptionReason.trim() || !exceptionEvidence}
              tooltip={
                exceptionReason.trim() && exceptionEvidence
                  ? ""
                  : "Cần lý do và tài liệu bằng chứng"
              }
              onClick={() =>
                toast(
                  "Đã cấp ngoại lệ thanh toán",
                  "Hồ sơ đi tiếp được; nhật ký ghi người cấp, lý do và tài liệu bằng chứng.",
                  "warning",
                )
              }
            >
              Cấp ngoại lệ
            </PermissionButton>
          </div>
        </Section>
      </div>
    </div>
  );
}

function TabSampling({ canPii, code }: { canPii: boolean; code: string }) {
  const navigate = useNavigate();
  return (
    <>
      <MessageBar intent="info" style={{ marginBottom: 16 }}>
        <MessageBarBody>
          Chỉ đọc: bản chụp hiện trường BM02/BM03 do nhân viên lấy mẫu ghi nhận. Các trường được bảo
          vệ phải chỉnh sửa qua quy trình yêu cầu sửa hồ sơ.
        </MessageBarBody>
        <MessageBarActions>
          <Button size="small" onClick={() => void navigate({ to: "/lay-mau", search: { code } })}>
            Mở màn lấy mẫu
          </Button>
        </MessageBarActions>
      </MessageBar>

      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(auto-fit, minmax(320px,1fr))",
        }}
      >
        <Section title="1. Phân công lấy mẫu">
          <FieldGrid items={RECORD_SAMPLING_ASSIGN} />
        </Section>
        <Section title="6. BM02 - ký và thời gian">
          <FieldGrid items={RECORD_SAMPLING_SIGN} />
        </Section>
      </div>

      <Section
        title="2. Đối soát hiện trường - 7 trường truy xuất"
        actions={
          <>
            <Badge appearance="tint" color={toneToColor(RECORD_CHECK_CONCLUSION.tone)}>
              {RECORD_CHECK_CONCLUSION.state}
            </Badge>
          </>
        }
      >
        <div style={{ overflow: "auto" }}>
          <table className="dlp-datagrid" style={{ minWidth: 720 }}>
            <thead>
              <tr>
                <th>Trường truy xuất</th>
                <th>Khai báo BM01</th>
                <th>Giá trị thực tế</th>
                <th style={{ width: 120 }}>Đối soát</th>
              </tr>
            </thead>
            <tbody>
              {RECORD_FIELD_CHECK.map((r) => (
                <tr key={r.field}>
                  <td>{r.field}</td>
                  <td className="dlp-num">{r.declared}</td>
                  <td className="dlp-num">{r.actual}</td>
                  <td>
                    <Badge appearance="tint" color={r.match ? "success" : "warning"}>
                      {r.match ? "Khớp" : "Lệch"}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div
          style={{
            marginTop: 10,
            fontSize: "var(--font-size-200)",
            color: "var(--foreground-secondary)",
          }}
        >
          {RECORD_CHECK_CONCLUSION.by}
        </div>
      </Section>

      <Section
        title="3. Đề nghị sửa thông tin hiện trường"
        actions={
          <span style={{ fontSize: "var(--font-size-200)", color: "var(--foreground-secondary)" }}>
            {RECORD_FIX_NOTE}
          </span>
        }
      >
        <div style={{ overflow: "auto" }}>
          <table className="dlp-datagrid" style={{ minWidth: 860 }}>
            <thead>
              <tr>
                <th>Trường</th>
                <th style={{ width: 200 }}>Giá trị cũ → mới</th>
                <th>Lý do · minh chứng</th>
                <th style={{ width: 220 }}>Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              {RECORD_FIELD_FIX.map((r) => (
                <tr key={r.field}>
                  <td>{r.field}</td>
                  <td className="dlp-num">
                    <s style={{ color: "var(--foreground-secondary)" }}>{r.from}</s> → {r.to}
                  </td>
                  <td>
                    <div>{r.reason}</div>
                    <div className="dlp-datagrid__secondary">{r.proof}</div>
                  </td>
                  <td>
                    <Badge appearance="tint" color={toneToColor(r.tone)}>
                      {r.status}
                    </Badge>
                    <div className="dlp-datagrid__secondary">{r.by}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="4. BM02 - phần I">
        <FieldGrid items={RECORD_BM02_HEAD} canPii={canPii} />
        <div
          style={{
            marginTop: 12,
            fontSize: "var(--font-size-200)",
            color: "var(--foreground-secondary)",
          }}
        >
          Mã vùng trồng và mã CSĐG chỉ có ở bảng dòng mẫu (GAP-BM-03). Khối nhận diện khách hàng ẩn
          theo phân quyền và mỗi lượt xem được audit.
        </div>
      </Section>

      <Section title="5. BM02 - bảng dòng mẫu">
        <div style={{ overflow: "auto" }}>
          <table className="dlp-datagrid" style={{ minWidth: 1080 }}>
            <thead>
              <tr>
                <th>Tên mẫu</th>
                <th>Mã vùng trồng</th>
                <th>Mã CSĐG</th>
                <th>Mã container</th>
                <th>Biển số xe</th>
                <th>Số rơ-moóc</th>
                <th>Phương pháp lấy mẫu</th>
                <th>Khối lượng</th>
                <th>Chỉ tiêu</th>
              </tr>
            </thead>
            <tbody>
              {RECORD_SAMPLE_ROWS.map((r) => (
                <tr key={r.name}>
                  <td style={{ fontWeight: 600 }}>{r.name}</td>
                  <td className="dlp-num">{r.zone}</td>
                  <td className="dlp-num">{r.pack}</td>
                  <td className="dlp-num">{r.container}</td>
                  <td className="dlp-num">{r.plate}</td>
                  <td className="dlp-num">{r.trailer}</td>
                  <td>{r.method}</td>
                  <td className="dlp-num">{r.weight}</td>
                  <td>{r.criteria}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(auto-fit, minmax(320px,1fr))",
        }}
      >
        <Section title="7. BM03 - tem niêm phong">
          <FieldGrid items={RECORD_SEAL_CHECK} />
        </Section>
        <Section title="8. File đính kèm">
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
            {RECORD_FILES.map((f) => (
              <li key={f.name} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ flex: 1 }}>
                  <span style={{ display: "block", fontWeight: 500 }}>{f.name}</span>
                  <span
                    style={{
                      display: "block",
                      fontSize: "var(--font-size-200)",
                      color: "var(--foreground-secondary)",
                    }}
                  >
                    {f.meta}
                  </span>
                </span>
                <Button size="small" icon={<ArrowDownload20Regular />} appearance="subtle">
                  Tải về
                </Button>
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </>
  );
}

function TabResults() {
  return (
    <>
      <Section
        title="Cây mã mẫu và analysis task"
        actions={
          <Badge appearance="tint" color="informative">
            {RECORD_TASK_PROGRESS}
          </Badge>
        }
      >
        <div style={{ overflow: "auto" }}>
          <table className="dlp-datagrid" style={{ minWidth: 960 }}>
            <thead>
              <tr>
                <th style={{ width: 200 }}>Mã</th>
                <th>Chỉ tiêu</th>
                <th>Thành phần</th>
                <th>Người phụ trách</th>
                <th style={{ width: 180 }}>Trạng thái</th>
                <th style={{ width: 160 }}>Cập nhật</th>
              </tr>
            </thead>
            <tbody>
              {RECORD_TASKS.map((t) => (
                <tr key={t.code}>
                  <td className="dlp-num" style={{ paddingLeft: t.child ? 28 : undefined }}>
                    {t.child ? "└ " : ""}
                    {t.code}
                  </td>
                  <td>{t.criteria}</td>
                  <td>{t.part}</td>
                  <td>{t.owner}</td>
                  <td>
                    <Badge appearance="tint" color={toneToColor(t.tone)}>
                      {t.status}
                    </Badge>
                  </td>
                  <td className="dlp-num">{t.updated}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}

function TabCertificates({ canWrite, code }: { canWrite: boolean; code: string }) {
  const navigate = useNavigate();
  return (
    <>
      <MessageBar intent="info" style={{ marginBottom: 16 }}>
        <MessageBarBody>
          Tại đây bạn có thể xem trước và tải PDF. Phát hành, thu hồi, thay thế và gửi email được
          quản lý tập trung tại màn Trả kết quả.
        </MessageBarBody>
        <MessageBarActions>
          <Button
            size="small"
            onClick={() => void navigate({ to: "/tra-ket-qua", search: { code } })}
          >
            Mở màn trả kết quả
          </Button>
        </MessageBarActions>
      </MessageBar>

      <Section title="Phiên bản phiếu kết quả">
        <div style={{ overflow: "auto" }}>
          <table className="dlp-datagrid" style={{ minWidth: 1040 }}>
            <thead>
              <tr>
                <th style={{ width: 140 }}>Số phiếu</th>
                <th style={{ width: 90 }}>Phiên bản</th>
                <th style={{ width: 170 }}>Trạng thái</th>
                <th style={{ width: 150 }}>Ngày tạo</th>
                <th>Phê duyệt · ký</th>
                <th style={{ width: 150 }}>Mã tra cứu</th>
                <th style={{ width: 130 }}>Checksum PDF</th>
                <th className="dlp-stickycol dlp-stickycol--head" style={{ width: 150 }}>
                  Hành động
                </th>
              </tr>
            </thead>
            <tbody>
              {RECORD_CERTIFICATES.map((c) => (
                <tr key={c.no + c.version}>
                  <td className="dlp-num">{c.no}</td>
                  <td className="dlp-num">{c.version}</td>
                  <td>
                    <Badge appearance="tint" color={toneToColor(c.tone)}>
                      {c.status}
                    </Badge>
                  </td>
                  <td className="dlp-num">{c.created}</td>
                  <td>{c.approver}</td>
                  <td className="dlp-num">{c.lookup}</td>
                  <td className="dlp-num">{c.checksum}</td>
                  <td className="dlp-stickycol">
                    <Button size="small" appearance="subtle">
                      Xem trước
                    </Button>
                    <Button size="small" appearance="subtle" icon={<ArrowDownload20Regular />} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(auto-fit, minmax(320px,1fr))",
        }}
      >
        <Section title="Lần gửi bản nháp cho khách">
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
            {RECORD_DRAFT_SENDS.map((d) => (
              <li key={d.at}>
                <span style={{ display: "block", fontWeight: 500 }}>{d.who}</span>
                <span className="dlp-datagrid__secondary">
                  {d.to} · {d.at}
                </span>
              </li>
            ))}
          </ul>
          <div
            style={{
              marginTop: 12,
              fontSize: "var(--font-size-200)",
              color: "var(--foreground-secondary)",
            }}
          >
            {RECORD_DRAFT_NOTE}
          </div>
        </Section>

        <Section title="Hành động trên hồ sơ">
          {canWrite ? (
            <div className="dlp-chiprow">
              <Button appearance="primary" as="a" href="/tra-ket-qua">
                Mở màn phát hành / trả kết quả
              </Button>
              <Button as="a" href="/sua-ho-so">
                Yêu cầu sửa hồ sơ
              </Button>
            </div>
          ) : null}
          <div
            style={{
              marginTop: canWrite ? 12 : 0,
              fontSize: "var(--font-size-200)",
              color: "var(--foreground-secondary)",
            }}
          >
            Hành động này chỉ hiển thị với người có quyền phát hành hoặc trả kết quả. Quyền truy cập
            được máy chủ kiểm tra trước khi xử lý.
          </div>
        </Section>
      </div>
    </>
  );
}

/* Tab «Huỷ & bàn giao» - hai thao tác cuối đường của một hồ sơ chưa phát hành, dựng đúng bộ điều
   kiện của bản chạy thật: huỷ phải có lý do VÀ tài liệu bằng chứng, bàn giao dùng chung thẻ
   `HandoverCard` với màn Tiếp nhận và màn Bàn giao. */
function TabCancelHandover({ canWrite, code }: { canWrite: boolean; code: string }) {
  const toast = useDlpToast();
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState<string>();
  const [cancelled, setCancelled] = useState(false);

  const [counterpart, setCounterpart] = useState("");
  const [scanMethod, setScanMethod] = useState<ScanMethod>("QR");
  const [note, setNote] = useState("");
  const [repeatAcknowledged, setRepeatAcknowledged] = useState(false);
  const [handoverDone, setHandoverDone] = useState<string>();

  return (
    <div className="dlp-split">
      <Section title="Huỷ hồ sơ">
        {cancelled ? (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Hồ sơ đã huỷ:</MessageBarTitle> {reason}
            </MessageBarBody>
          </MessageBar>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            <Field label="Lý do">
              <Textarea
                value={reason}
                placeholder="Ví dụ: khách rút yêu cầu trước khi lấy mẫu"
                onChange={(_, d) => setReason(d.value)}
              />
            </Field>
            <Field label="Tài liệu bằng chứng">
              <FileDropField
                accept=".pdf,image/jpeg,image/png"
                idle="Tải văn bản đề nghị huỷ của khách (JPEG · PNG · PDF)"
                selected={evidence ? `Đã chọn ${evidence}` : undefined}
                onFile={(file) => setEvidence(file.name)}
              />
            </Field>
            <PermissionButton
              allowed={canWrite}
              disabled={!reason.trim() || !evidence}
              tooltip={reason.trim() && evidence ? "" : "Cần lý do và tài liệu bằng chứng"}
              onClick={() => {
                setCancelled(true);
                toast(
                  `Đã huỷ hồ sơ ${code}`,
                  "Nhật ký ghi người huỷ, lý do và tài liệu bằng chứng.",
                  "warning",
                );
              }}
            >
              Xác nhận huỷ
            </PermissionButton>
            <span
              style={{ fontSize: "var(--font-size-200)", color: "var(--foreground-secondary)" }}
            >
              Hồ sơ đã phát hành thì không huỷ được - dùng Thu hồi/Thay thế phiếu ở màn Trả kết quả.
            </span>
          </div>
        )}
      </Section>

      <HandoverCard
        sampleCode={code}
        isLab
        disabled={!canWrite || cancelled}
        success={handoverDone}
        counterpartUserId={counterpart}
        scanMethod={scanMethod}
        note={note}
        people={HANDOVER_COUNTERPARTS}
        log={HANDOVER_LOG}
        repeatAcknowledged={repeatAcknowledged}
        onRepeatAcknowledged={setRepeatAcknowledged}
        onCounterpartUserId={setCounterpart}
        onScanMethod={setScanMethod}
        onNote={setNote}
        onSubmit={() => {
          setHandoverDone(`Đã ghi nhận lab nhận mẫu lúc ${new Date().toLocaleString("vi-VN")}`);
          toast(`Lab đã nhận mẫu ${code}`, "Người giao - người nhận - thời điểm đã vào nhật ký.");
        }}
      />
    </div>
  );
}

function TabHistory() {
  return (
    <div className="dlp-split">
      <Section
        title="Lịch sử thay đổi hồ sơ"
        actions={
          <Badge appearance="tint" color="informative">
            {RECORD_AUDIT.length} bản ghi
          </Badge>
        }
      >
        <div style={{ overflow: "auto" }}>
          <table className="dlp-datagrid" style={{ minWidth: 760 }}>
            <thead>
              <tr>
                <th style={{ width: 160 }}>Thời điểm</th>
                <th>Nội dung thay đổi</th>
                <th>Giá trị cũ → mới</th>
                <th style={{ width: 180 }}>Người thực hiện</th>
              </tr>
            </thead>
            <tbody>
              {RECORD_AUDIT.map((a) => (
                <tr key={a.at}>
                  <td className="dlp-num">{a.at}</td>
                  <td>{a.what}</td>
                  <td className="dlp-datagrid__secondary">{a.delta}</td>
                  <td>{a.who}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      <div>
        <MessageBar intent="info" style={{ marginBottom: 16 }}>
          <MessageBarBody>
            Lịch sử được lưu trong 5 năm. Huỷ hồ sơ không giải phóng mã lượt đã cấp.
          </MessageBarBody>
        </MessageBar>
        <Section title="Lượt truy cập thông tin khách hàng">
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
            {RECORD_ACCESS_LOG.map((l) => (
              <li key={l.at}>
                <span style={{ display: "block" }}>{l.who}</span>
                <span
                  style={{
                    fontSize: "var(--font-size-200)",
                    color: "var(--foreground-secondary)",
                  }}
                >
                  {l.at}
                </span>
              </li>
            ))}
          </ul>
          <div
            style={{
              marginTop: 12,
              fontSize: "var(--font-size-200)",
              color: "var(--foreground-secondary)",
            }}
          >
            Mỗi lần mở thông tin khách hàng đều được ghi vào nhật ký truy cập.
          </div>
        </Section>
      </div>
    </div>
  );
}
