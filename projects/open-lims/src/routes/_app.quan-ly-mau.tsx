import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Field,
  FluentProvider,
  Input,
  Select,
  Spinner,
  MessageBar,
  MessageBarBody,
} from "@fluentui/react-components";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import { PageHead } from "@/components/lims/common";
import { NoAccess } from "@/components/lims/NoAccess";
import { useAuth } from "@/lib/auth/AuthProvider";
import { resolveNavAccess } from "@/lib/auth/nav-access";
import { PERM } from "@/lib/admin/rbac";
import { apiErrorMessage, useApiClient } from "@/lib/api";
import { sampleApi } from "@/features/sample/sample-api";
import { sampleDateRange, type SampleDatePreset } from "@/features/sample/date-filter";
import { toneToColor } from "@/lib/admin/tone";
export const Route = createFileRoute("/_app/quan-ly-mau")({ component: Screen });
function Screen() {
  const { can } = useAuth();
  return resolveNavAccess(can).sampleManagement ? <Samples /> : <NoAccess screen="Quản lý mẫu" />;
}
function Samples() {
  const api = useApiClient();
  const navigate = useNavigate();
  const [datePreset, setDatePreset] = useState<SampleDatePreset>("all");
  const [dateFrom, setFrom] = useState("");
  const [dateTo, setTo] = useState("");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState("");
  const { can } = useAuth();
  const list = useQuery({
    queryKey: ["managed-samples", { dateFrom, dateTo, status, q, page }],
    queryFn: () =>
      sampleApi.list(api, { fromDate: dateFrom, toDate: dateTo, status, q, page, size: 50 }),
  });
  const detail = useQuery({
    queryKey: ["managed-sample", selected],
    queryFn: () => sampleApi.detail(api, selected),
    enabled: !!selected,
  });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 1400, minWidth: 0 }}>
      <PageHead
        title="Quản lý mẫu"
        description="Lọc theo ngày tạo hồ sơ. Số ngày tính theo lịch Việt Nam, ngày tạo là ngày 0. Đã phê duyệt là quyết định lãnh đạo trong hệ thống."
      />
      <div
        className="dlp-card"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))",
          gap: 12,
          padding: 16,
          alignItems: "end",
        }}
      >
        <Field label="Ngày tạo hồ sơ">
          <Select
            value={datePreset}
            onChange={(_, data) => {
              const preset = data.value as SampleDatePreset;
              setDatePreset(preset);
              setPage(1);
              if (preset === "custom") return;
              const range = preset === "all" ? { from: "", to: "" } : sampleDateRange(preset);
              setFrom(range.from);
              setTo(range.to);
            }}
          >
            <option value="all">Tất cả</option>
            <option value="today">Hôm nay</option>
            <option value="yesterday">Hôm qua</option>
            <option value="3days">3 ngày</option>
            <option value="7days">7 ngày</option>
            <option value="custom">Tuỳ chọn</option>
          </Select>
        </Field>
        {datePreset === "custom" ? (
          <>
            <Field label="Từ ngày tạo hồ sơ">
              <Input
                type="date"
                value={dateFrom}
                onChange={(_, d) => {
                  setFrom(d.value);
                  setPage(1);
                }}
              />
            </Field>
            <Field label="Đến ngày tạo hồ sơ">
              <Input
                type="date"
                value={dateTo}
                onChange={(_, d) => {
                  setTo(d.value);
                  setPage(1);
                }}
              />
            </Field>
          </>
        ) : null}
        <Field label="Trạng thái">
          <Select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Tất cả</option>
            {[
              ["NOT_ARRIVED", "Chưa đến"],
              ["AWAITING_CHECK", "Chờ kiểm tra tiếp nhận"],
              ["RECEIVED", "Đã tiếp nhận"],
              ["HANDED_OVER", "Đã bàn giao"],
              ["IN_TESTING", "Đang thử nghiệm"],
              ["ON_HOLD", "Tạm giữ"],
              ["REJECTED", "Từ chối tiếp nhận"],
              ["SUBMITTED", "Đã gửi kiểm tra kỹ thuật"],
              ["RETURNED", "Trả về chỉnh sửa"],
              ["REVIEWED", "Đã kiểm tra kỹ thuật"],
              ["APPROVED", "Đã phê duyệt"],
              ["RELEASED", "Đã phát hành"],
            ].map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Mã mẫu / hồ sơ">
          <Input
            value={q}
            onChange={(_, d) => {
              setQ(d.value);
              setPage(1);
            }}
          />
        </Field>
      </div>
      {list.isPending ? <Spinner label="Đang tải mẫu…" /> : null}
      {list.error ? (
        <MessageBar intent="error">
          <MessageBarBody>{apiErrorMessage(list.error)}</MessageBarBody>
        </MessageBar>
      ) : null}
      <div className="dlp-card" style={{ minWidth: 0, overflowX: "auto" }}>
        <table className="dlp-datagrid" style={{ minWidth: 800 }}>
          <thead>
            <tr>
              <th>Mã mẫu</th>
              <th>Hồ sơ</th>
              <th>Mẫu</th>
              <th>Ngày tạo hồ sơ</th>
              <th>Số ngày</th>
              <th>Trạng thái</th>
              <th>Lãnh đạo</th>
            </tr>
          </thead>
          <tbody>
            {list.data?.data.map((s) => (
              <tr key={s.code}>
                <td>
                  <Button appearance="subtle" onClick={() => setSelected(s.code)}>
                    {s.code}
                  </Button>
                </td>
                <td>{s.requestCode}</td>
                <td>{s.product}</td>
                <td>
                  {new Date(s.requestCreatedAt).toLocaleDateString("vi-VN", {
                    timeZone: "Asia/Ho_Chi_Minh",
                  })}
                </td>
                <td>{s.elapsedDays}</td>
                <td>
                  <Badge
                    appearance="tint"
                    color={s.status.tone === "info" ? "brand" : toneToColor(s.status.tone)}
                  >
                    {s.status.name}
                  </Badge>
                </td>
                <td>
                  <Badge appearance="tint" color={toneToColor(s.approvalStatus.tone)}>
                    {s.approvalStatus.name}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.data && !list.data.data.length ? <p>Không có mẫu phù hợp.</p> : null}
      <div>
        <Button disabled={page <= 1} onClick={() => setPage((v) => v - 1)}>
          Trước
        </Button>{" "}
        Trang {page}/{(list.data ? Math.ceil(list.data.page.total / list.data.page.size) : 1) || 1}{" "}
        <Button
          disabled={
            page >= ((list.data ? Math.ceil(list.data.page.total / list.data.page.size) : 1) || 1)
          }
          onClick={() => setPage((v) => v + 1)}
        >
          Sau
        </Button>
      </div>
      <Drawer
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected("");
        }}
      >
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>Chi tiết mẫu {selected}</DrawerTitle>
            <DrawerDescription>Thông tin trong phạm vi quyền của bạn</DrawerDescription>
          </DrawerHeader>
          <FluentProvider
            style={{ padding: 24, minHeight: 0, overflow: "auto", overflowWrap: "anywhere" }}
          >
            {detail.isPending ? <Spinner /> : null}
            {detail.error ? <p>{apiErrorMessage(detail.error)}</p> : null}
            {detail.data ? (
              <>
                <p>Hồ sơ: {detail.data.requestCode}</p>
                <p>
                  <Badge
                    appearance="tint"
                    color={
                      detail.data.status.tone === "info"
                        ? "brand"
                        : toneToColor(detail.data.status.tone)
                    }
                  >
                    {detail.data.status.name}
                  </Badge>{" "}
                  · {detail.data.elapsedDays} ngày
                </p>
                <p>
                  <Badge appearance="tint" color={toneToColor(detail.data.approvalStatus.tone)}>
                    {detail.data.approvalStatus.name}
                  </Badge>
                </p>
                <p>Chỉ tiêu: {detail.data.parameters?.map((p) => p.name).join(", ")}</p>
                {can(PERM.LAB_READ) ? (
                  <Button
                    onClick={() =>
                      void navigate({ to: "/nhap-ket-qua", search: { code: selected } })
                    }
                  >
                    Mở kết quả mẫu
                  </Button>
                ) : null}
              </>
            ) : null}
            <Button onClick={() => setSelected("")}>Đóng</Button>
          </FluentProvider>
        </DrawerContent>
      </Drawer>
    </div>
  );
}
