import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Button,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Option,
  Spinner,
} from "@fluentui/react-components";
import { FieldLabel, useDlpToast, type FilterChip, type StatItem } from "@/components/lims/common";
import { apiErrorMessage } from "@/lib/api";
import { RecordsScreen } from "@/components/lims/records/RecordsScreen";
import type { TagDef } from "@/lib/admin/records-view-data";
import {
  recordsViewToRequestFilters,
  useRecordsRows,
  useRecordsViewState,
  type RecordsViewSync,
} from "@/lib/admin/records-view-state";
import { useSavedViews, useSaveView } from "@/features/view";
import type { RecordRow, Tone } from "@/lib/admin/records-data";
import { useAuth } from "@/lib/auth/AuthProvider";
import { useNotifications } from "@/features/notification";
import { PERM } from "@/lib/admin/rbac";
import {
  requestKeys,
  requestTagKeys,
  useRequestApi,
  useRequestFilterOptions,
  useRequestList,
  useRequestTags,
} from "../hooks";
import type { FilterOption, RequestListFilters, RequestListItem } from "../types";
import { formatDate } from "./format";
import { RequestError } from "./request-ui";

/** Bộ lọc do máy chủ đảm nhiệm; không suy ra được từ dữ liệu dòng nên giữ riêng ở màn này.
 *  Trạng thái và thanh toán nhận NHIỀU giá trị - máy chủ đọc bằng tham số lặp lại. */
interface ServerFilters {
  status: string[];
  payment: string[];
  branchId: string;
  fromDate: string;
  toDate: string;
}

/** Các cách sắp xếp máy chủ nhận (`sort=<field>:<asc|desc>`).
 *
 *  Danh sách đóng ở cả hai đầu: máy chủ chỉ chấp nhận `createdAt`, `code`, `status` và TỪ CHỐI
 *  400 với tên cột lạ thay vì lặng lẽ bỏ qua. Nên chỗ này không được bịa thêm lựa chọn. */
const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: "createdAt:desc", label: "Mới tạo trước" },
  { value: "createdAt:asc", label: "Cũ nhất trước" },
  { value: "code:asc", label: "Mã lượt tăng dần" },
  { value: "code:desc", label: "Mã lượt giảm dần" },
  { value: "status:asc", label: "Trạng thái A→Z" },
];

const DEFAULT_SORT = "createdAt:desc";

const PAGE_SIZE = 50;

const EMPTY_SERVER_FILTERS: ServerFilters = {
  status: [],
  payment: [],
  branchId: "",
  fromDate: "",
  toDate: "",
};

/** Chuyển hồ sơ từ API sang đúng hình dạng dòng mà màn Hồ sơ kiểm nghiệm dùng chung.
 *  `TestRequestSummaryResponse` chưa có hạn trả kết quả nên cột "Hạn trả" để trống thay vì bịa.
 *
 *  Hồ sơ nhiều mẫu (CR-20260831-001): `item.product` chỉ là tên mẫu ĐẦU TIÊN, `item.sampleCount`
 *  là tổng số mẫu - cột Sản phẩm hiện "{tên mẫu đầu} +{n còn lại}" (ui-ux-spec 13.13/mục 15).
 *  Danh sách KHÔNG trả tên đủ của mọi mẫu (chỉ `GET .../{code}` mới có `samples[]` đầy đủ), nên
 *  tooltip chỉ nói số mẫu còn lại - xem chi tiết hồ sơ để có bảng mẫu đủ tên. */
function toRecordRow(item: RequestListItem): RecordRow {
  const extra = item.sampleCount - 1;
  return {
    id: item.code ?? item.id,
    ...(item.code ? {} : { draftId: item.id }),
    customer: item.customer?.name ?? "",
    product: extra > 0 ? `${item.product} +${extra}` : item.product,
    ...(extra > 0
      ? {
          productTooltip: `${item.product} và ${extra} mẫu khác (${item.sampleCount} mẫu) - xem chi tiết hồ sơ để có đủ tên từng mẫu.`,
        }
      : {}),
    criteria: item.parameterCodes.join(" + "),
    statusTone: item.status.tone,
    status: item.status.name,
    payTone: item.payment.tone,
    pay: item.payment.name,
    due: "-",
    tags: item.tags.map((t) => t.name),
    handler: item.handler?.fullName ?? item.handler?.id ?? "-",
    branch: item.receptionBranch.name,
    createdAt: formatDate(item.createdAt),
  };
}

export function RemoteRecordsPage({ canWrite }: { canWrite: boolean }) {
  const navigate = useNavigate();
  const { can, branches } = useAuth();
  const api = useRequestApi();
  const queryClient = useQueryClient();
  const toast = useDlpToast();
  const [page, setPage] = useState(1);
  const size = PAGE_SIZE;
  const [sort, setSort] = useState(DEFAULT_SORT);
  const [server, setServer] = useState<ServerFilters>(EMPTY_SERVER_FILTERS);

  // API bỏ hẳn khoá `customer` khi người dùng không được xem PII; cột khách hàng cũng ẩn theo
  // đúng quyền đó thay vì đoán từ dữ liệu đã tải.
  const canPii = can(PERM.REQUEST_CUSTOMER_VIEW);
  // Từ vựng của thanh lọc và danh mục chi nhánh, cả hai đều từ máy chủ. Chi nhánh lấy từ
  // `GET /me.branches` - chưa có endpoint danh mục chi nhánh riêng, và dù sao người dùng cũng
  // chỉ lọc được trong phạm vi mình với tới.
  const options = useRequestFilterOptions();
  // Danh mục nhãn thật của đơn vị. Trước đây màn này dựng danh mục từ 50 dòng đang tải, nên nhãn
  // nào không có mặt ở trang 1 thì không chọn được, và con số bên cạnh mỗi nhãn là số của trang
  // chứ không phải số hồ sơ thực sự mang nhãn đó.
  const tags = useRequestTags();
  // Vài thông báo mới nhất cho rail bên phải của bố cục worklist. Cùng nguồn với chuông trên
  // thanh tiêu đề, chỉ cắt ngắn - không phải một danh sách thứ hai để lệch nhau.
  const notifications = useNotifications(undefined, true);
  // Chế độ xem lưu trên máy chủ: dùng được ở máy khác, và chia sẻ được cho đồng nghiệp - hai
  // điều màn hình vẫn hứa nhưng trước đây chỉ có localStorage đứng sau.
  const savedViews = useSavedViews();
  const viewMutations = useSaveView();
  const viewSync = useMemo<RecordsViewSync>(() => {
    const rows = savedViews.data?.views ?? [];
    return {
      savedViews: rows.map((view) => ({
        id: view.id,
        name: view.name,
        group: view.ownedByMe ? "Chế độ xem của tôi" : "Chế độ xem được chia sẻ",
        count: 0,
        tags: view.definition?.tags ?? [],
        conds: view.definition?.conds ?? [],
        ...(view.definition
          ? {
              layout: {
                order: view.definition.order,
                hidden: view.definition.hidden,
                pinned: view.definition.pinned,
                density: view.definition.density,
                tagMode: view.definition.tagMode,
              },
            }
          : {}),
        ownedByMe: view.ownedByMe,
      })),
      defaultViewId: rows.find((view) => view.isDefault)?.id ?? null,
      onSave: (input) => viewMutations.create.mutate(input),
      onDelete: (id) => viewMutations.remove.mutate(id),
    };
  }, [savedViews.data, viewMutations.create, viewMutations.remove]);

  const base = useRecordsViewState(canPii, viewSync);

  const filters = useMemo<RequestListFilters>(() => {
    const fromView = recordsViewToRequestFilters(base.state, base.query, page, { size, sort });
    // Điều kiện "tiến độ quá hạn" của bộ lọc nâng cao cũng dịch sang trạng thái thanh toán,
    // nên gộp với lựa chọn ở ngăn lọc thay vì hai bên ghi đè lên nhau.
    const paymentStatus = [...new Set([...(fromView.paymentStatus ?? []), ...server.payment])];
    return {
      ...fromView,
      paymentStatus,
      ...(server.status.length ? { status: server.status } : {}),
      ...(server.branchId ? { branchId: server.branchId } : {}),
      ...(server.fromDate ? { fromDate: server.fromDate } : {}),
      ...(server.toDate ? { toDate: server.toDate } : {}),
    };
  }, [base.state, base.query, page, size, sort, server]);

  const query = useRequestList(filters);
  const items = query.data?.data;
  const rows = useMemo(() => (items ?? []).map(toRecordRow), [items]);
  const rowsPart = useRecordsRows(base, rows, { serverQuery: true, serverTags: true });
  const view = { ...base, ...rowsPart };

  const summary = query.data?.summary;
  const pageInfo = query.data?.page;
  const stats: StatItem[] = [
    { label: "Chờ phân công lấy mẫu", value: summary?.awaitingSampling ?? "-", tone: "warning" },
    { label: "Mẫu chưa về PTN", value: summary?.pendingLab ?? "-", tone: "info" },
    { label: "Chờ phê duyệt phiếu", value: summary?.awaitingApproval ?? "-", tone: "brand" },
    { label: "Quá hạn thanh toán", value: summary?.paymentOverdue ?? "-", tone: "danger" },
  ];

  const patchServer = (next: Partial<ServerFilters>) => {
    setPage(1);
    setServer((prev) => ({ ...prev, ...next }));
  };

  // Chip hiện TÊN người dùng đọc được, không phải mã enum: đó là cả lý do bỏ ô gõ tay đi.
  const labelOf = (options: FilterOption[] | undefined, code: string) =>
    options?.find((option) => option.code === code)?.name ?? code;

  const extraChips: FilterChip[] = [
    ...server.status.map((code) => ({
      label: `Trạng thái: ${labelOf(options.data?.statuses, code)}`,
      remove: () => patchServer({ status: server.status.filter((item) => item !== code) }),
    })),
    ...server.payment.map((code) => ({
      label: `Thanh toán: ${labelOf(options.data?.paymentStatuses, code)}`,
      remove: () => patchServer({ payment: server.payment.filter((item) => item !== code) }),
    })),
    ...(server.branchId
      ? [
          {
            label: `Chi nhánh: ${
              branches.find((branch) => branch.id === server.branchId)?.name ?? server.branchId
            }`,
            remove: () => patchServer({ branchId: "" }),
          },
        ]
      : []),
    ...(
      [
        ["fromDate", "Từ ngày"],
        ["toDate", "Đến ngày"],
      ] as ["fromDate" | "toDate", string][]
    )
      .filter(([key]) => server[key] !== "")
      .map(([key, label]) => ({
        label: `${label}: ${server[key]}`,
        remove: () => patchServer({ [key]: "" }),
      })),
  ];

  // Gắn/gỡ nhãn cho các phiếu đang chọn. Endpoint là theo TỪNG hồ sơ, nên đây là N lời gọi chứ
  // không phải một lệnh hàng loạt: cố tình chạy tuần tự và báo đúng số thành công/thất bại, thay
  // vì bắn song song rồi báo "xong" trong khi vài phiếu đã hỏng giữa chừng.
  const tagBulk = useMutation({
    mutationFn: async ({ tagCode, attach }: { tagCode: string; attach: boolean }) => {
      // Bản nháp chưa có mã hồ sơ (BR-003 chỉ cấp mã khi rời trạng thái DRAFT), mà endpoint gắn
      // nhãn khoá theo mã - nên bỏ qua chúng thay vì gửi một mã không tồn tại.
      const codes = view.selected.filter((id) => rows.some((row) => row.id === id && !row.draftId));
      let done = 0;
      const failures: string[] = [];
      for (const code of codes) {
        try {
          await (attach ? api.attachTag(code, tagCode) : api.detachTag(code, tagCode));
          done += 1;
        } catch {
          failures.push(code);
        }
      }
      return { done, failures };
    },
    onSuccess: ({ done, failures }, { tagCode, attach }) => {
      const name = tagCatalog.find((tag) => tag.code === tagCode)?.name ?? tagCode;
      const verb = attach ? "Đã gắn nhãn" : "Đã gỡ nhãn";
      toast(
        failures.length ? `${verb} - còn ${failures.length} phiếu lỗi` : verb,
        `${name} · ${done} phiếu`,
      );
      void queryClient.invalidateQueries({ queryKey: requestKeys.all });
      void queryClient.invalidateQueries({ queryKey: requestTagKeys.all });
    },
    onError: (error) => toast("Không đổi được nhãn", apiErrorMessage(error)),
  });

  const tagCatalog: TagDef[] = (tags.data?.tags ?? []).map((tag) => ({
    code: tag.code,
    name: tag.name,
    group: tag.groupName,
    color: tag.tone as Tone,
    count: tag.usageCount,
    scope: tag.scope,
  }));

  const overdue = summary?.paymentOverdue ?? 0;

  return (
    <RecordsScreen
      view={view}
      canPii={canPii}
      canWrite={canWrite}
      stats={stats}
      tagCatalog={tagCatalog}
      // Trạng thái do máy chủ định nghĩa: cột của bảng theo trạng thái dựng từ chính dữ liệu.
      boardBaseColumns={[]}
      panels={{
        notifs: (notifications.data?.pages[0]?.items ?? []).slice(0, 5).map((item) => ({
          text: item.title,
          time: formatDate(item.occurredAt),
        })),
        // Hàng chờ tác vụ nền vẫn chưa có API - để trống thay vì bịa tiến độ.
        queue: [],
        unavailableNote: "Chưa có thông báo nào.",
      }}
      bulkSupported={false}
      onAttachTag={(tagCode) => tagBulk.mutate({ tagCode, attach: true })}
      onDetachTag={(tagCode) => tagBulk.mutate({ tagCode, attach: false })}
      tagBusy={tagBulk.isPending}
      showViewCounts={false}
      searchPlaceholder="Tìm mã lượt, khách hàng, container"
      onCreate={() => void navigate({ to: "/tao-yeu-cau" })}
      exportDisabled={query.isPending}
      alert={
        overdue > 0 ? (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Nhắc thanh toán:</MessageBarTitle> {overdue} hồ sơ quá hạn thanh toán
              - bị khoá chuyển lab cho tới khi có chứng từ.
            </MessageBarBody>
          </MessageBar>
        ) : null
      }
      extraChips={extraChips}
      onClearExtraFilters={() => {
        setPage(1);
        setServer(EMPTY_SERVER_FILTERS);
      }}
      extraFilters={
        <>
          <span className="dlp-label">Bộ lọc máy chủ</span>
          <Field
            label={<FieldLabel label="Trạng thái" />}
            validationState={options.isError ? "error" : "none"}
            validationMessage={options.isError ? "Không tải được danh sách trạng thái." : undefined}
          >
            <Dropdown
              multiselect
              placeholder="Mọi trạng thái"
              disabled={!options.data}
              value={server.status.map((code) => labelOf(options.data?.statuses, code)).join(", ")}
              selectedOptions={server.status}
              onOptionSelect={(_, d) => patchServer({ status: d.selectedOptions })}
            >
              {(options.data?.statuses ?? []).map((item) => (
                <Option key={item.code} value={item.code} text={item.name}>
                  {item.name}
                </Option>
              ))}
            </Dropdown>
          </Field>
          <Field label="Thanh toán">
            <Dropdown
              multiselect
              placeholder="Mọi trạng thái thanh toán"
              disabled={!options.data}
              value={server.payment
                .map((code) => labelOf(options.data?.paymentStatuses, code))
                .join(", ")}
              selectedOptions={server.payment}
              onOptionSelect={(_, d) => patchServer({ payment: d.selectedOptions })}
            >
              {(options.data?.paymentStatuses ?? []).map((item) => (
                <Option key={item.code} value={item.code} text={item.name}>
                  {item.name}
                </Option>
              ))}
            </Dropdown>
          </Field>
          {/* Một chi nhánh thì không có gì để chọn - ẩn hẳn thay vì bày một ô chỉ có một mục. */}
          {branches.length > 1 ? (
            <Field label="Chi nhánh">
              <Dropdown
                placeholder="Mọi chi nhánh"
                value={branches.find((branch) => branch.id === server.branchId)?.name ?? ""}
                selectedOptions={server.branchId ? [server.branchId] : []}
                onOptionSelect={(_, d) => patchServer({ branchId: d.optionValue ?? "" })}
              >
                <Option value="" text="Mọi chi nhánh">
                  Mọi chi nhánh
                </Option>
                {branches.map((branch) => (
                  <Option key={branch.id} value={branch.id} text={branch.name}>
                    {branch.name}
                  </Option>
                ))}
              </Dropdown>
            </Field>
          ) : null}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Từ ngày">
              <Input
                type="date"
                value={server.fromDate}
                onChange={(_, d) => patchServer({ fromDate: d.value })}
              />
            </Field>
            <Field label="Đến ngày">
              <Input
                type="date"
                value={server.toDate}
                onChange={(_, d) => patchServer({ toDate: d.value })}
              />
            </Field>
          </div>
        </>
      }
      status={
        <>
          {query.isPending ? <Spinner label="Đang tải hồ sơ…" /> : null}
          <RequestError error={query.error} fallback="Không thể tải danh sách hồ sơ." />
        </>
      }
      footer={
        pageInfo ? (
          <div
            className="dlp-card"
            style={{
              padding: "12px 14px",
              display: "flex",
              flexWrap: "nowrap",
              gap: 12,
              alignItems: "center",
            }}
          >
            <Button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Trang trước
            </Button>
            <span className="dlp-datagrid__secondary">
              Trang {pageInfo.number} · {pageInfo.total} hồ sơ
            </span>
            <Button
              disabled={page * pageInfo.size >= pageInfo.total}
              onClick={() => setPage((p) => p + 1)}
            >
              Trang sau
            </Button>
            <div style={{ flex: 1 }} />
            <Field label="Sắp xếp" orientation="horizontal">
              <Dropdown
                value={SORT_OPTIONS.find((item) => item.value === sort)?.label ?? sort}
                selectedOptions={[sort]}
                style={{ minWidth: 170 }}
                onOptionSelect={(_, d) => {
                  setPage(1);
                  setSort(d.optionValue ?? DEFAULT_SORT);
                }}
              >
                {SORT_OPTIONS.map((item) => (
                  <Option key={item.value} value={item.value} text={item.label}>
                    {item.label}
                  </Option>
                ))}
              </Dropdown>
            </Field>
          </div>
        ) : null
      }
    />
  );
}
