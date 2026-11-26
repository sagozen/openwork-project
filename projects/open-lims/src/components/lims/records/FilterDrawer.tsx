import {
  Button,
  Drawer,
  DrawerBody,
  DrawerHeader,
  DrawerHeaderTitle,
  Dropdown,
  Input,
  Option,
} from "@fluentui/react-components";
import { Dismiss20Regular } from "@fluentui/react-icons";
import type { ReactNode } from "react";
import { COND_FIELDS, opsFor, type CondField, type Condition } from "@/lib/admin/records-view-data";
import type { RecordsView } from "@/lib/admin/records-view-state";

export function FilterDrawer({
  view,
  open,
  onOpenChange,
  extra,
}: {
  view: RecordsView;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Nhóm bộ lọc do máy chủ đảm nhiệm (trạng thái, chi nhánh, khoảng ngày…). */
  extra?: ReactNode;
}) {
  const conds = view.state.conds;
  const set = (next: Condition[]) => view.patch({ conds: next });

  return (
    <Drawer
      type="overlay"
      position="end"
      separator
      open={open}
      onOpenChange={(_, d) => onOpenChange(d.open)}
      style={{ width: 420 }}
    >
      <DrawerHeader>
        <DrawerHeaderTitle
          action={
            <Button
              appearance="subtle"
              icon={<Dismiss20Regular />}
              aria-label="Đóng"
              onClick={() => onOpenChange(false)}
            />
          }
        >
          Bộ lọc nâng cao
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingBottom: 16 }}>
          {conds.map((c, i) => {
            const ops = opsFor(c.field);
            return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="dlp-datagrid__secondary" style={{ width: 30, flexShrink: 0 }}>
                  {i === 0 ? "Khi" : "VÀ"}
                </span>
                <Dropdown
                  style={{ flex: 1, minWidth: 0 }}
                  value={COND_FIELDS.find((f) => f.value === c.field)?.label ?? ""}
                  selectedOptions={[c.field]}
                  onOptionSelect={(_, d) => {
                    const field = (d.optionValue ?? c.field) as CondField;
                    const next = [...conds];
                    next[i] = { field, op: opsFor(field)[0]!.value, val: "" };
                    set(next);
                  }}
                >
                  {COND_FIELDS.map((f) => (
                    <Option key={f.value} value={f.value} text={f.label}>
                      {f.label}
                    </Option>
                  ))}
                </Dropdown>
                <Dropdown
                  style={{ width: 130, minWidth: 0 }}
                  value={ops.find((o) => o.value === c.op)?.label ?? ""}
                  selectedOptions={[c.op]}
                  onOptionSelect={(_, d) => {
                    const next = [...conds];
                    next[i] = { ...c, op: d.optionValue ?? c.op };
                    set(next);
                  }}
                >
                  {ops.map((o) => (
                    <Option key={o.value} value={o.value} text={o.label}>
                      {o.label}
                    </Option>
                  ))}
                </Dropdown>
                {c.field === "customer" || c.field === "product" ? (
                  <Input
                    style={{ width: 120 }}
                    value={c.val}
                    onChange={(_, d) => {
                      const next = [...conds];
                      next[i] = { ...c, val: d.value };
                      set(next);
                    }}
                  />
                ) : null}
                <Button
                  appearance="subtle"
                  icon={<Dismiss20Regular />}
                  aria-label="Xoá điều kiện"
                  onClick={() => set(conds.filter((_, k) => k !== i))}
                />
              </div>
            );
          })}
          <div>
            <Button
              size="small"
              onClick={() => set([...conds, { field: "progress", op: "is", val: "" }])}
            >
              + Thêm điều kiện
            </Button>
          </div>
          <span className="dlp-datagrid__secondary">
            Các điều kiện kết hợp bằng VÀ. Điều kiện HOẶC và nhóm điều kiện sẽ bổ sung ở giai đoạn
            sau.
          </span>

          {extra ? (
            <div
              style={{
                borderTop: "1px solid var(--border-subtle)",
                paddingTop: 12,
                display: "grid",
                gap: 12,
              }}
            >
              {extra}
            </div>
          ) : null}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <Button onClick={() => view.patch({ conds: [] })}>Xoá điều kiện</Button>
            <div style={{ flex: 1 }} />
            <Button appearance="primary" onClick={() => onOpenChange(false)}>
              Áp dụng
            </Button>
          </div>
        </div>
      </DrawerBody>
    </Drawer>
  );
}
