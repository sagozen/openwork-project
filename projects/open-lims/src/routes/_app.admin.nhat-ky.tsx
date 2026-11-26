import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Button, Dropdown, Field, Input, Option } from "@fluentui/react-components";
import { Search20Regular } from "@fluentui/react-icons";
import { AdminSettingsShell } from "@/components/lims/AdminSettingsShell";
import { FieldLabel } from "@/components/lims/common";
import { AuditEventList } from "@/components/lims/audit/AuditEventList";
import { NoAccess } from "@/components/lims/NoAccess";
import {
  KNOWN_ACTIONS,
  KNOWN_TARGET_TYPES,
  actionLabel,
  flattenAuditPages,
  targetLabel,
  useAuditEvents,
  type AuditEvent,
  type AuditQuery,
} from "@/features/audit";
import {
  ANY,
  AUDIT_EVENTS,
  EMPTY_AUDIT_FILTERS,
  filterAuditEvents,
  type AuditFilters,
} from "@/lib/admin/audit-data";
import { PERM } from "@/lib/admin/rbac";
import { useAuth } from "@/lib/auth/AuthProvider";

export const Route = createFileRoute("/_app/admin/nhat-ky")({
  head: () => ({
    meta: [
      { title: "Nhật ký hệ thống - DLP LIMS" },
      {
        name: "description",
        content: "Tra cứu nhật ký toàn hệ theo người thực hiện, hành động và đối tượng.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AuditLogScreen,
});

/** Bộ lọc màn hình sang tham số truy vấn của máy chủ.
 *
 *  `ANY` là giá trị của ô "Mọi ..." trên giao diện chứ không phải một mã hành động - bỏ hẳn khỏi
 *  chuỗi truy vấn thay vì gửi đi. Ô ngày dùng `datetime-local` nên không mang múi giờ; chuyển
 *  sang ISO có múi giờ để máy chủ không phải đoán người dùng đang ở đâu. */
function toAuditQuery(filters: AuditFilters): AuditQuery {
  const instant = (value: string) => (value ? new Date(value).toISOString() : undefined);
  return {
    actorUserId: filters.actorUserId.trim() || undefined,
    action: filters.action === ANY ? undefined : filters.action,
    targetType: filters.targetType === ANY ? undefined : filters.targetType,
    targetId: filters.targetId.trim() || undefined,
    from: instant(filters.from),
    to: instant(filters.to),
  };
}

/** Dòng nhật ký dựng sẵn của bản minh hoạ mang hình dạng phẳng (`actorName`, `detail` là chuỗi),
 *  còn máy chủ trả `actor` lồng và `detail` là map. Quy bản minh hoạ về hình dạng của máy chủ để
 *  hai chế độ dùng chung đúng một thành phần hiển thị. */
function demoEvents(filters: AuditFilters): AuditEvent[] {
  return filterAuditEvents(AUDIT_EVENTS, filters).map((event) => ({
    id: event.id,
    occurredAt: event.occurredAt,
    actor: { userId: event.actorUserId, fullName: event.actorName },
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    ...(event.detail ? { detail: { "Nội dung": event.detail } } : {}),
  }));
}

function AuditLogScreen() {
  const { can, usesClerk } = useAuth();
  // Bộ lọc ĐANG GÕ tách khỏi bộ lọc ĐÃ ÁP: mỗi lần tra cứu tự ghi một dòng vào chính nhật ký
  // này, nên tra theo từng ký tự người dùng gõ sẽ nhấn chìm nhật ký dưới các lần tra nó.
  const [draft, setDraft] = useState<AuditFilters>(EMPTY_AUDIT_FILTERS);
  const [applied, setApplied] = useState<AuditFilters>(EMPTY_AUDIT_FILTERS);

  const allowed = can(PERM.AUDIT_READ);
  const query = useAuditEvents(toAuditQuery(applied), usesClerk && allowed);

  const events = useMemo(
    () => (usesClerk ? flattenAuditPages(query.data?.pages) : demoEvents(applied)),
    [usesClerk, query.data, applied],
  );

  if (!allowed) return <NoAccess screen="Nhật ký hệ thống" />;

  const update = (patch: Partial<AuditFilters>) => setDraft((prev) => ({ ...prev, ...patch }));

  return (
    <AdminSettingsShell code="A-09">
      <div style={{ display: "grid", gap: 12 }}>
        <section className="dlp-card" style={{ padding: 16, display: "grid", gap: 12 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 12,
            }}
          >
            <Field label="Người thực hiện (mã người dùng)">
              <Input
                value={draft.actorUserId}
                placeholder="vd 42"
                onChange={(_, d) => update({ actorUserId: d.value })}
              />
            </Field>
            <Field label="Hành động">
              <Dropdown
                value={draft.action === ANY ? "Mọi hành động" : actionLabel(draft.action)}
                selectedOptions={[draft.action]}
                onOptionSelect={(_, d) => update({ action: d.optionValue ?? ANY })}
              >
                <Option value={ANY}>Mọi hành động</Option>
                {KNOWN_ACTIONS.map((item) => (
                  <Option key={item.code} value={item.code} text={item.label}>
                    {item.label}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <Field label="Loại đối tượng">
              <Dropdown
                value={draft.targetType === ANY ? "Mọi loại" : targetLabel(draft.targetType)}
                selectedOptions={[draft.targetType]}
                onOptionSelect={(_, d) => update({ targetType: d.optionValue ?? ANY })}
              >
                <Option value={ANY}>Mọi loại</Option>
                {KNOWN_TARGET_TYPES.map((item) => (
                  <Option key={item.code} value={item.code} text={item.label}>
                    {item.label}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <Field
              label={
                <FieldLabel
                  label="Mã đối tượng"
                  tooltip="Định danh nội bộ của đối tượng, không phải mã hồ sơ hiển thị."
                />
              }
            >
              <Input value={draft.targetId} onChange={(_, d) => update({ targetId: d.value })} />
            </Field>
            <Field label="Từ thời điểm">
              <Input
                type="datetime-local"
                value={draft.from}
                onChange={(_, d) => update({ from: d.value })}
              />
            </Field>
            <Field label="Đến thời điểm">
              <Input
                type="datetime-local"
                value={draft.to}
                onChange={(_, d) => update({ to: d.value })}
              />
            </Field>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button
              appearance="primary"
              icon={<Search20Regular />}
              onClick={() => setApplied(draft)}
            >
              Tra cứu
            </Button>
            <Button
              appearance="secondary"
              onClick={() => {
                setDraft(EMPTY_AUDIT_FILTERS);
                setApplied(EMPTY_AUDIT_FILTERS);
              }}
            >
              Xoá bộ lọc
            </Button>
          </div>

          {/* Nói thẳng giới hạn thay vì bày một ô lọc rỗng: dòng nhật ký chưa mang thông tin chi
              nhánh nên không lọc theo chi nhánh được. */}
          <small className="dlp-datagrid__secondary">
            Phạm vi tra cứu là toàn đơn vị. Chưa lọc được theo chi nhánh - dòng nhật ký hiện chưa
            mang thông tin chi nhánh.
          </small>
        </section>

        <section className="dlp-card" style={{ padding: 16, display: "grid", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <h2 style={{ margin: 0, fontSize: "var(--font-size-400)", fontWeight: 600 }}>
              Dòng nhật ký
            </h2>
            <div style={{ flex: 1 }} />
            {/* Còn trang sau thì con số này là "đã tải", không phải tổng - máy chủ phân trang
                bằng con trỏ nên không biết tổng số dòng khớp bộ lọc. */}
            <span className="dlp-datagrid__secondary">
              {events.length} dòng{query.hasNextPage ? " đã tải" : ""}
            </span>
          </div>

          <AuditEventList
            events={events}
            isLoading={usesClerk && query.isLoading}
            error={usesClerk ? query.error : undefined}
            hasNextPage={usesClerk && query.hasNextPage}
            isFetchingNextPage={query.isFetchingNextPage}
            onLoadMore={() => void query.fetchNextPage()}
          />
        </section>
      </div>
    </AdminSettingsShell>
  );
}
