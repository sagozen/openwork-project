import { useEffect, useRef, useState } from "react";
import { Badge, Button, Combobox, Option, Spinner, Tooltip } from "@fluentui/react-components";
import { AddCircle20Regular, ArrowSwap20Regular, Info20Regular } from "@fluentui/react-icons";
import { hintText } from "../request-styles";
import { CustomerAvatar } from "./CustomerAvatar";
import { CustomerCreateDialog } from "./CustomerCreateDialog";
import { CustomerDetailDialog } from "./CustomerDetailDialog";
import type { CustomerRecord, NewCustomerInput } from "./types";

/** Giá trị riêng cho dòng «tạo mới» trong danh sách xổ xuống - không đụng với mã khách hàng. */
const CREATE_VALUE = "__create-customer__";

export interface CustomerPickerProps {
  value?: CustomerRecord;
  onChange: (customer: CustomerRecord | undefined) => void;
  /** Nạp danh sách gợi ý theo từ khoá. Bên gọi tự quyết định tìm ở dữ liệu tĩnh hay qua API. */
  onSearch: (query: string) => Promise<CustomerRecord[]>;
  onCreate: (input: NewCustomerInput) => Promise<CustomerRecord>;
  disabled?: boolean;
}

/** Ô chọn khách hàng: gõ để lọc, chọn trong danh sách xổ xuống, tạo mới ngay tại dòng cuối, và
 *  xem chi tiết bằng popup. Mỗi dòng có ảnh đại diện công ty kèm mã số thuế để không chọn nhầm
 *  hai công ty tên gần giống nhau. */
export function CustomerPicker({
  value,
  onChange,
  onSearch,
  onCreate,
  disabled,
}: CustomerPickerProps) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<CustomerRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);

  // Hàm tìm kiếm do bên gọi cấp có thể đổi định danh mỗi lần render (phụ thuộc client API), nên
  // giữ qua ref - hiệu ứng tìm kiếm chỉ chạy lại khi từ khoá đổi.
  const searchRef = useRef(onSearch);
  searchRef.current = onSearch;

  // Tìm sau khi ngừng gõ 250ms để một lần gõ tên công ty không bắn hàng chục lượt tìm kiếm.
  useEffect(() => {
    const keyword = query.trim();
    if (!keyword) {
      setOptions([]);
      setLoading(false);
      setError(undefined);
      return;
    }
    let alive = true;
    setLoading(true);
    const timer = setTimeout(() => {
      searchRef
        .current(keyword)
        .then((result) => {
          if (!alive) return;
          setOptions(result);
          setError(undefined);
        })
        .catch((e: unknown) => {
          if (!alive) return;
          setOptions([]);
          setError(e instanceof Error ? e.message : "Không tìm được khách hàng.");
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query]);

  const select = (customer: CustomerRecord) => {
    onChange(customer);
    setQuery("");
    setOptions([]);
  };

  const dialogs = (
    <>
      <CustomerCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        initialName={query}
        onCreate={async (input) => {
          const created = await onCreate(input);
          select(created);
          return created;
        }}
      />
      {value ? (
        <CustomerDetailDialog customer={value} open={detailOpen} onOpenChange={setDetailOpen} />
      ) : null}
    </>
  );

  // Đã chọn: thay ô tìm kiếm bằng thẻ khách hàng gọn, kèm hai việc còn lại là xem chi tiết và
  // đổi sang khách khác.
  if (value) {
    return (
      <>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: 10,
            border: "1px solid var(--border-default)",
            borderRadius: "var(--radius-surface)",
            background: "var(--background-card)",
          }}
        >
          <CustomerAvatar customer={value} size={40} />
          <div style={{ display: "grid", gap: 2, minWidth: 0, flex: 1 }}>
            <span
              style={{
                font: "600 14px/20px var(--font-family-base)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {value.name}
            </span>
            <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <Badge appearance="tint" color="informative">
                {value.id}
              </Badge>
              <span style={hintText}>
                {value.taxCode ? `MST ${value.taxCode}` : "Chưa có mã số thuế"}
              </span>
            </span>
            {value.representative || value.phone ? (
              <span style={hintText}>
                {[value.representative, value.phone].filter(Boolean).join(" · ")}
              </span>
            ) : null}
            {value.email ? <span style={hintText}>{value.email}</span> : null}
            {value.address ? <span style={hintText}>{value.address}</span> : null}
          </div>
          <Tooltip content="Xem chi tiết khách hàng" relationship="label">
            <Button
              appearance="subtle"
              icon={<Info20Regular />}
              onClick={() => setDetailOpen(true)}
            />
          </Tooltip>
          <Tooltip content="Chọn khách hàng khác" relationship="label">
            <Button
              appearance="subtle"
              icon={<ArrowSwap20Regular />}
              disabled={disabled}
              onClick={() => onChange(undefined)}
            />
          </Tooltip>
        </div>
        {dialogs}
      </>
    );
  }

  return (
    <>
      <Combobox
        freeform
        disabled={disabled}
        value={query}
        selectedOptions={[]}
        style={{ width: "100%" }}
        placeholder="Gõ tên công ty hoặc mã số thuế theo BM01"
        expandIcon={loading ? <Spinner size="tiny" /> : undefined}
        onChange={(e) => setQuery(e.target.value)}
        onOptionSelect={(_, data) => {
          if (data.optionValue === CREATE_VALUE) {
            setCreateOpen(true);
            return;
          }
          const hit = options.find((c) => c.id === data.optionValue);
          if (hit) select(hit);
        }}
      >
        {options.map((c) => (
          <Option key={c.id} value={c.id} text={c.name}>
            <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
              <CustomerAvatar customer={c} size={24} />
              <span style={{ display: "grid", gap: 1, minWidth: 0 }}>
                <span style={{ font: "14px/20px var(--font-family-base)" }}>{c.name}</span>
                <span style={hintText}>
                  {[c.taxCode ? `MST ${c.taxCode}` : null, c.id].filter(Boolean).join(" · ")}
                </span>
              </span>
            </span>
          </Option>
        ))}
        <Option value={CREATE_VALUE} text="Tạo khách hàng mới">
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              color: "var(--foreground-brand)",
            }}
          >
            <AddCircle20Regular />
            {query.trim() ? `Tạo khách hàng mới «${query.trim()}»` : "Tạo khách hàng mới"}
          </span>
        </Option>
      </Combobox>
      {error || loading || (query.trim() && options.length === 0) ? (
        <span style={hintText}>
          {error
            ? error
            : loading
              ? "Đang tìm khách hàng…"
              : "Không có khách hàng khớp - chọn «Tạo khách hàng mới» ở cuối danh sách."}
        </span>
      ) : null}
      {dialogs}
    </>
  );
}
