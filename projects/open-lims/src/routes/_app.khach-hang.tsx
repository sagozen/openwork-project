import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  Dropdown,
  InteractionTag,
  InteractionTagPrimary,
  Option,
} from "@fluentui/react-components";
import { ArrowDownload20Regular } from "@fluentui/react-icons";
import {
  EmptyState,
  PageHead,
  SearchInput,
  StatStrip,
  Toolbar,
  useDlpToast,
  type StatItem,
} from "@/components/lims/common";
import { CustomerDetailDrawer } from "@/components/lims/customer/CustomerDetailDrawer";
import { CustomerLedgerActions } from "@/components/lims/customer/CustomerLedgerActions";
import { NoAccess } from "@/components/lims/NoAccess";
import {
  CUSTOMER_BRANCHES,
  MOCK_CUSTOMERS,
  customerDebt,
  debtBucket,
  type CustomerRow,
} from "@/lib/admin/customer-data";
import {
  mergeStatement,
  toLedgerInvoice,
  toLedgerRow,
  toListFilters,
  type LedgerRow,
} from "@/lib/admin/customer-remote";
import { exportCustomersWorkbook } from "@/lib/admin/customer-export";
import { toneToColor } from "@/lib/admin/tone";
import { formatAmount } from "@/lib/format";
import { useAuth } from "@/lib/auth/AuthProvider";
import { canManageCustomer, canManageDebt, canViewCustomerLedger } from "@/lib/auth/nav-access";
import { useDebounced } from "@/lib/use-debounced";
import {
  useCustomerApi,
  useCustomerList,
  useCustomerStatement,
  useDebtSummary,
  useLockCustomer,
  usePatchCustomer,
} from "@/features/customer";

export const Route = createFileRoute("/_app/khach-hang")({
  head: () => ({
    meta: [
      { title: "Khách hàng & công nợ - DLP LIMS" },
      {
        name: "description",
        content:
          "Danh sách khách hàng kèm công nợ, tải Excel chi tiết, khoá khách hàng và sửa thông tin.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: CustomerScreen,
});

const STATUS_FILTERS = [
  ["all", "Tất cả"],
  ["debt", "Đang còn nợ"],
  ["overdue", "Quá hạn"],
  ["locked", "Đã khoá"],
] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number][0];

function CustomerScreen() {
  const { can, usesClerk, branches } = useAuth();
  const notify = useDlpToast();
  // Mốc tính quá hạn cố định trong suốt phiên xem: bảng, badge và file Excel phải cùng một "hôm
  // nay", nếu không hai người mở cùng màn ở hai thời điểm sẽ đọc ra hai số ngày trễ khác nhau.
  const [today] = useState(() => new Date());
  const [demoCustomers, setDemoCustomers] = useState<CustomerRow[]>(MOCK_CUSTOMERS);
  const [query, setQuery] = useState("");
  const [branchFilter, setBranchFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  // Debounce từ khoá trước khi gọi API: mỗi phím một queryKey sẽ làm bảng nháy rỗng và trông như
  // ô tìm không lọc được (cùng bệnh với hàng chờ tiếp nhận).
  const debouncedQuery = useDebounced(query.trim());

  const canWrite = canManageCustomer(can);
  /** Ghi sổ (phát hành hoá đơn, ghi phiếu thu) là quyền riêng: xem được công nợ không có nghĩa
   *  là được ghi tiền vào sổ. */
  const canWriteLedger = canManageDebt(can);

  /** Mọi thay đổi bộ lọc đều quay về trang 1: giữ nguyên số trang khi kết quả vừa hẹp lại sẽ cho
   *  một bảng rỗng, và bảng rỗng đọc ra là "không có khách hàng nào" chứ không phải "trang này
   *  không còn dòng". */
  const applyFilter =
    <T,>(setter: (value: T) => void) =>
    (value: T) => {
      setter(value);
      setPage(1);
    };

  // Nhánh thật lọc và phân trang PHÍA MÁY CHỦ: số dư nằm ở bảng hoá đơn, nên "còn nợ"/"quá hạn"
  // không lọc đúng được trên một trang đã tải, và tổng số dòng cũng sẽ sai.
  const remoteFilters = useMemo(
    () => ({
      q: debouncedQuery || undefined,
      branchId: branchFilter === "all" ? undefined : branchFilter,
      ...toListFilters(statusFilter),
      page,
      size: 20,
    }),
    [debouncedQuery, branchFilter, statusFilter, page],
  );

  const remoteList = useCustomerList(remoteFilters, usesClerk);
  const remoteSummary = useDebtSummary(usesClerk);

  const customers: LedgerRow[] = useMemo(
    () => (usesClerk ? (remoteList.data?.data ?? []).map(toLedgerRow) : demoCustomers),
    [usesClerk, remoteList.data, demoCustomers],
  );

  const rows = useMemo(
    () =>
      // Nhánh thật đã được máy chủ lọc rồi - lọc lại ở đây sẽ cắt mất dòng của trang hiện tại.
      usesClerk
        ? customers
        : customers.filter((c) => {
            const q = query.trim().toLowerCase();
            const matchQuery =
              !q ||
              c.name.toLowerCase().includes(q) ||
              c.id.toLowerCase().includes(q) ||
              c.taxCode.includes(q) ||
              c.representative.toLowerCase().includes(q) ||
              c.phone.replace(/\s/g, "").includes(q.replace(/\s/g, ""));
            const matchBranch = branchFilter === "all" || c.branch === branchFilter;
            const debt = customerDebt(c, today);
            const matchStatus =
              statusFilter === "all" ||
              (statusFilter === "debt" && debt.outstanding > 0) ||
              (statusFilter === "overdue" && debt.overdue > 0) ||
              (statusFilter === "locked" && c.status === "locked");
            return matchQuery && matchBranch && matchStatus;
          }),
    [usesClerk, customers, query, branchFilter, statusFilter, today],
  );

  const stats = useMemo<StatItem[]>(() => {
    // Nhánh thật lấy tổng TOÀN HỆ từ máy chủ, không cộng dồn trang đang xem: dải chỉ số nói
    // "tổng còn nợ" thì phải là tổng của mọi khách hàng, không phải của 20 dòng đầu.
    if (usesClerk) {
      const summary = remoteSummary.data;
      const total = remoteList.data?.page.total ?? 0;
      const outstandingAll = summary?.outstanding ?? 0;
      const overdueAll = summary?.overdue ?? 0;
      return [
        { label: "Khách hàng", value: total, tone: "info" },
        {
          label: "Tổng còn nợ",
          value: formatAmount(outstandingAll),
          hint: `${summary?.openInvoices ?? 0} hoá đơn chưa tất toán`,
          tone: outstandingAll > 0 ? "warning" : "success",
        },
        {
          label: "Nợ quá hạn",
          value: formatAmount(overdueAll),
          hint: `${summary?.customersInDebt ?? 0} khách hàng còn nợ`,
          tone: overdueAll > 0 ? "danger" : "success",
        },
        {
          label: "Hoá đơn quá hạn",
          value: summary?.overdueInvoices ?? 0,
          hint: "Đã qua ngày đến hạn",
          tone: (summary?.overdueInvoices ?? 0) > 0 ? "danger" : "success",
        },
      ];
    }

    let outstanding = 0;
    let overdue = 0;
    let overdueCount = 0;
    let lockedCount = 0;
    for (const c of customers) {
      const debt = customerDebt(c, today);
      outstanding += debt.outstanding;
      overdue += debt.overdue;
      if (debt.overdue > 0) overdueCount += 1;
      if (c.status === "locked") lockedCount += 1;
    }
    return [
      { label: "Khách hàng", value: customers.length, tone: "info" },
      {
        label: "Tổng còn nợ",
        value: formatAmount(outstanding),
        hint: "Tất cả khoản phải thu chưa tất toán",
        tone: outstanding > 0 ? "warning" : "success",
      },
      {
        label: "Nợ quá hạn",
        value: formatAmount(overdue),
        hint: `${overdueCount} khách hàng quá hạn`,
        tone: overdue > 0 ? "danger" : "success",
      },
      {
        label: "Đang bị khoá",
        value: lockedCount,
        hint: "Không tạo được yêu cầu mới",
        tone: lockedCount > 0 ? "danger" : "success",
      },
    ];
  }, [usesClerk, remoteSummary.data, remoteList.data, customers, today]);

  // Chi nhánh: demo lọc theo TÊN (fixture chỉ có tên); nhánh thật lọc theo id từ `GET /me.branches`
  // — cùng nguồn với bộ lọc hồ sơ. Không dựng từ trang đang tải: trang đã lọc thì dropdown mất
  // các chi nhánh khác và trông như bộ lọc hỏng.
  const branchOptions = useMemo(() => {
    if (!usesClerk) {
      return CUSTOMER_BRANCHES.map((b) => ({ value: b, label: b }));
    }
    return branches.map((b) => ({ value: b.id, label: b.name }));
  }, [usesClerk, branches]);

  const selected = customers.find((c) => c.id === openId) ?? null;

  // Sao kê chỉ tải khi ngăn kéo mở - danh sách không cần tới hoá đơn của từng khách.
  const statement = useCustomerStatement(
    usesClerk ? (selected?.remoteId ?? null) : null,
    usesClerk && !!selected,
  );
  const open =
    selected && usesClerk && statement.data ? mergeStatement(selected, statement.data) : selected;

  const patchCustomer = usePatchCustomer();
  const lockCustomer = useLockCustomer();
  const customerApi = useCustomerApi();

  if (!canViewCustomerLedger(can)) return <NoAccess screen="Khách hàng & công nợ" />;

  return (
    <>
      <div
        style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 1400, minWidth: 0 }}
      >
        <PageHead
          crumbs={[{ label: "Khách hàng" }, { label: "Danh sách & công nợ" }]}
          title="Khách hàng & công nợ"
          description="Màn hình dành riêng cho lãnh đạo · thông tin khách hàng, dư nợ theo từng hoá đơn, khoá khách hàng và cập nhật thông tin"
          actions={
            <Button
              appearance="primary"
              icon={<ArrowDownload20Regular />}
              disabled={rows.length === 0}
              onClick={async () => {
                // Nhánh thật: danh sách không mang hoá đơn, nên phải lấy sao kê của đúng trang
                // đang xem trước khi xuất - nếu không sheet «Chi tiết công nợ» sẽ rỗng và người
                // nhận file tưởng khách không nợ khoản nào.
                let exported = rows;
                if (usesClerk) {
                  const statements = await Promise.all(
                    rows.map((row) =>
                      row.remoteId
                        ? customerApi
                            .statement(row.remoteId)
                            .then((full) => ({
                              ...row,
                              invoices: full.invoices.map(toLedgerInvoice),
                            }))
                            .catch(() => row)
                        : Promise.resolve(row),
                    ),
                  );
                  exported = statements;
                }
                exportCustomersWorkbook(exported, today);
                notify(
                  "Đã tải Excel chi tiết",
                  `${exported.length} khách hàng · gồm sheet «Chi tiết công nợ» theo từng hoá đơn`,
                );
              }}
            >
              Tải Excel chi tiết
            </Button>
          }
        />

        <StatStrip items={stats} title="Tổng quan công nợ" />

        <Toolbar
          left={
            <>
              <SearchInput
                value={query}
                onChange={applyFilter(setQuery)}
                placeholder={
                  usesClerk
                    ? "Tìm tên, mã KH, MST…"
                    : "Tìm tên, mã KH, MST, người đại diện, SĐT…"
                }
                label="Tìm khách hàng"
                width={320}
              />
              {branchOptions.length > 0 ? (
                <Dropdown
                  value={
                    branchFilter === "all"
                      ? "Mọi chi nhánh"
                      : (branchOptions.find((b) => b.value === branchFilter)?.label ??
                        branchFilter)
                  }
                  selectedOptions={[branchFilter]}
                  onOptionSelect={(_, d) => applyFilter(setBranchFilter)(d.optionValue ?? "all")}
                  style={{ width: 220, minWidth: 220 }}
                  aria-label="Lọc theo chi nhánh phục vụ"
                >
                  <Option value="all" text="Mọi chi nhánh">
                    Mọi chi nhánh
                  </Option>
                  {branchOptions.map((b) => (
                    <Option key={b.value} value={b.value} text={b.label}>
                      {b.label}
                    </Option>
                  ))}
                </Dropdown>
              ) : null}
              <div className="dlp-chiprow" role="group" aria-label="Lọc theo tình trạng công nợ">
                {STATUS_FILTERS.map(([value, chipLabel]) => {
                  const picked = statusFilter === value;
                  return (
                    <InteractionTag
                      key={value}
                      appearance="outline"
                      size="small"
                      className={picked ? "dlp-chip--picked" : "dlp-chip--unpicked"}
                    >
                      <InteractionTagPrimary
                        aria-pressed={picked}
                        onClick={() => applyFilter(setStatusFilter)(value)}
                      >
                        {picked ? "✓ " : ""}
                        {chipLabel}
                      </InteractionTagPrimary>
                    </InteractionTag>
                  );
                })}
              </div>
            </>
          }
          right={
            <span className="dlp-datagrid__secondary">
              {usesClerk
                ? `${rows.length}/${remoteList.data?.page.total ?? 0} khách hàng`
                : `${rows.length}/${customers.length} khách hàng`}
            </span>
          }
        />

        <div className="dlp-card" style={{ overflowX: "auto" }}>
          <table className="dlp-datagrid" style={{ minWidth: 1080, tableLayout: "fixed" }}>
            <thead>
              <tr>
                <th style={{ width: 40 }}>TT</th>
                <th style={{ width: 230 }}>Khách hàng</th>
                <th style={{ width: 110 }}>Mã số thuế</th>
                <th style={{ width: 170 }}>Liên hệ</th>
                <th style={{ width: 140 }}>Chi nhánh</th>
                <th style={{ width: 150 }}>Công nợ</th>
                <th style={{ width: 150 }}>Tình trạng nợ</th>
                <th className="dlp-stickycol dlp-stickycol--head" style={{ width: 110 }}>
                  Hành động
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c, i) => {
                // Nhánh thật: số dư do máy chủ tính trên TOÀN BỘ hoá đơn của khách. Tính lại ở
                // đây sẽ ra 0 vì danh sách cố ý không tải hoá đơn.
                const debt = c.remoteDebt ?? customerDebt(c, today);
                const bucket = c.remoteBucket ?? debtBucket(debt);
                return (
                  <tr key={c.id}>
                    <td className="dlp-datagrid__secondary dlp-num">{i + 1}</td>
                    <td>
                      <button
                        type="button"
                        className="dlp-linkcell"
                        onClick={() => setOpenId(c.id)}
                        title="Mở hồ sơ khách hàng"
                      >
                        {c.name}
                      </button>
                      <div className="dlp-datagrid__secondary">
                        <span className="dlp-num">{c.id}</span> · {c.segment}
                        {c.status === "locked" ? (
                          <>
                            {" · "}
                            <Badge appearance="tint" color="danger" size="small">
                              Đã khoá
                            </Badge>
                          </>
                        ) : null}
                      </div>
                    </td>
                    <td className="dlp-num">{c.taxCode}</td>
                    <td>
                      <div className="dlp-truncate">{c.representative}</div>
                      <div className="dlp-datagrid__secondary dlp-num">{c.phone}</div>
                      <div className="dlp-datagrid__secondary dlp-truncate">{c.email}</div>
                    </td>
                    <td>
                      <div className="dlp-truncate">{c.branch}</div>
                      <div className="dlp-datagrid__secondary">{c.totalRecords} hồ sơ</div>
                    </td>
                    <td>
                      <div className="dlp-num" style={{ fontWeight: 600 }}>
                        {debt.outstanding > 0 ? formatAmount(debt.outstanding) : "Không nợ"}
                      </div>
                      <div className="dlp-datagrid__secondary dlp-num">
                        Hạn mức {formatAmount(c.creditLimit)}
                      </div>
                    </td>
                    <td>
                      <Badge appearance="tint" color={toneToColor(bucket.tone)}>
                        {bucket.label}
                      </Badge>
                      <div className="dlp-datagrid__secondary dlp-num" style={{ marginTop: 2 }}>
                        {debt.openInvoices} hoá đơn
                        {debt.overdue > 0 ? ` · quá hạn ${formatAmount(debt.overdue)}` : ""}
                      </div>
                      {debt.overLimit ? (
                        <div
                          className="dlp-datagrid__secondary"
                          style={{ color: "var(--status-danger-foreground)" }}
                        >
                          Vượt hạn mức
                        </div>
                      ) : null}
                    </td>
                    <td className="dlp-stickycol">
                      <Button appearance="subtle" size="small" onClick={() => setOpenId(c.id)}>
                        Xem hồ sơ
                      </Button>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ padding: 0 }}>
                    <EmptyState
                      title="Không có khách hàng nào khớp bộ lọc"
                      hint="Thử xoá từ khoá hoặc chọn lại chi nhánh/tình trạng công nợ."
                    />
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {usesClerk && (remoteList.data?.page.total ?? 0) > (remoteList.data?.page.size ?? 20) ? (
          <div
            style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 12 }}
          >
            <span className="dlp-datagrid__secondary">
              Trang {remoteList.data?.page.page ?? 1} /{" "}
              {Math.max(
                1,
                Math.ceil((remoteList.data?.page.total ?? 0) / (remoteList.data?.page.size ?? 20)),
              )}
            </span>
            <Button
              appearance="secondary"
              size="small"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Trang trước
            </Button>
            <Button
              appearance="secondary"
              size="small"
              disabled={
                page >=
                Math.ceil((remoteList.data?.page.total ?? 0) / (remoteList.data?.page.size ?? 20))
              }
              onClick={() => setPage((p) => p + 1)}
            >
              Trang sau
            </Button>
          </div>
        ) : null}
      </div>

      <CustomerDetailDrawer
        customer={open}
        canWrite={canWrite}
        today={today}
        ledgerActions={
          // Chỉ nhánh thật và chỉ người có quyền ghi: nhánh demo không có chỗ lưu, và một ô nhập
          // không lưu được gì còn tệ hơn là không bày ra.
          usesClerk && canWriteLedger && open?.remoteId ? (
            <CustomerLedgerActions
              customerId={open.remoteId}
              outstanding={open.remoteDebt?.outstanding ?? 0}
              onDone={(title, detail) => notify(title, detail)}
            />
          ) : undefined
        }
        onClose={() => setOpenId(null)}
        onSave={(customer, changes) => {
          const remoteId = (customer as LedgerRow).remoteId;
          if (usesClerk && remoteId) {
            patchCustomer.mutate(
              {
                id: remoteId,
                patch: {
                  name: changes.name,
                  representative: changes.representative,
                  phone: changes.phone,
                  email: changes.email,
                  address: changes.address,
                  contractCode: changes.contractCode,
                  creditLimit: changes.creditLimit,
                  paymentTermDays: changes.paymentTermDays,
                  // `branch` và `segment` ở ngăn kéo là CHỮ hiển thị; máy chủ nhận id chi nhánh và
                  // mã nhóm. Chưa có ô chọn nào trả về hai giá trị đó nên không gửi lên - gửi
                  // nguyên chữ sẽ bị từ chối, mà đoán lấy id thì sai âm thầm.
                },
              },
              {
                onSuccess: () =>
                  notify("Đã cập nhật thông tin khách hàng", `${customer.id} · ${changes.name}`),
                onError: (error) =>
                  notify("Không cập nhật được khách hàng", String((error as Error).message)),
              },
            );
            return;
          }
          setDemoCustomers((prev) =>
            prev.map((c) => (c.id === customer.id ? { ...c, ...changes } : c)),
          );
          notify("Đã cập nhật thông tin khách hàng", `${customer.id} · ${changes.name}`);
        }}
        onLock={(customer, reason) => {
          const remoteId = (customer as LedgerRow).remoteId;
          if (usesClerk && remoteId) {
            lockCustomer.mutate(
              { id: remoteId, reason, lock: true },
              {
                onSuccess: () => notify(`Đã khoá khách hàng ${customer.id}`, `Lý do: ${reason}`),
                onError: (error) =>
                  notify("Không khoá được khách hàng", String((error as Error).message)),
              },
            );
            return;
          }
          setDemoCustomers((prev) =>
            prev.map((c) =>
              c.id === customer.id
                ? {
                    ...c,
                    status: "locked",
                    lockReason: reason,
                    lockedOn: today.toISOString().slice(0, 10),
                  }
                : c,
            ),
          );
          notify(`Đã khoá khách hàng ${customer.id}`, `Lý do: ${reason}`);
        }}
        onUnlock={(customer, reason) => {
          const remoteId = (customer as LedgerRow).remoteId;
          if (usesClerk && remoteId) {
            lockCustomer.mutate(
              { id: remoteId, reason, lock: false },
              {
                onSuccess: () => notify(`Đã mở khoá khách hàng ${customer.id}`, `Lý do: ${reason}`),
                onError: (error) =>
                  notify("Không mở khoá được khách hàng", String((error as Error).message)),
              },
            );
            return;
          }
          setDemoCustomers((prev) =>
            prev.map((c) => {
              if (c.id !== customer.id) return c;
              // Bỏ hẳn lý do và ngày khoá thay vì giữ lại: hồ sơ đang hoạt động mà vẫn mang một
              // câu "đang bị khoá vì…" là thông tin sai ngay trên màn hình.
              const { lockReason: _reason, lockedOn: _on, ...rest } = c;
              return { ...rest, status: "active" };
            }),
          );
          notify(`Đã mở khoá khách hàng ${customer.id}`, `Lý do: ${reason}`);
        }}
      />
    </>
  );
}
