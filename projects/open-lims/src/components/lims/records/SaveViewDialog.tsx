import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  Input,
  Option,
} from "@fluentui/react-components";
import { useState } from "react";
import type { RecordsView } from "@/lib/admin/records-view-state";
import type { ViewScope } from "@/features/view";

const SCOPE_LABELS: Record<ViewScope, string> = {
  private: "Chỉ mình tôi",
  branch: "Chia sẻ trong chi nhánh",
  tenant: "Toàn đơn vị",
};

export function SaveViewDialog({
  view,
  open,
  onOpenChange,
}: {
  view: RecordsView;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<ViewScope>("private");
  const [makeDefault, setMakeDefault] = useState(false);

  // Số dòng mỗi trang KHÔNG thuộc chế độ xem (nó là lựa chọn nhất thời ở chân bảng), nên không
  // kể vào đây nữa - con số 25 viết cứng trước đây còn mâu thuẫn với kích thước trang thật.
  const summary = `${view.state.tags.length} nhãn, ${view.state.conds.length} điều kiện, ${view.visibleColumns.length} cột (${view.state.pinned.length} cột ghim), mật độ ${
    view.state.density === "compact" ? "Compact" : "Comfortable"
  }.`;

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface style={{ maxWidth: 460 }}>
        <DialogBody>
          <DialogTitle>Lưu chế độ xem</DialogTitle>
          <DialogContent>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <Field label="Tên chế độ xem">
                <Input
                  value={name}
                  onChange={(_, d) => setName(d.value)}
                  placeholder="Ví dụ: Sầu riêng quá hạn"
                />
              </Field>
              {/* Giá trị gửi lên máy chủ là mã (`private`/`branch`/`tenant`), không phải câu
                  hiển thị - trước đây ô này chỉ giữ một chuỗi tiếng Việt rồi bị bỏ đi. */}
              <Field label="Phạm vi chia sẻ">
                <Dropdown
                  value={SCOPE_LABELS[scope]}
                  selectedOptions={[scope]}
                  onOptionSelect={(_, d) => setScope((d.optionValue as ViewScope) ?? scope)}
                >
                  {(Object.keys(SCOPE_LABELS) as ViewScope[]).map((value) => (
                    <Option key={value} value={value} text={SCOPE_LABELS[value]}>
                      {SCOPE_LABELS[value]}
                    </Option>
                  ))}
                </Dropdown>
              </Field>
              <Checkbox
                checked={makeDefault}
                onChange={(_, d) => setMakeDefault(!!d.checked)}
                label="Đặt làm chế độ xem mặc định"
              />
              <span className="dlp-datagrid__secondary">Lưu cùng: {summary}</span>
            </div>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => onOpenChange(false)}>Huỷ</Button>
            <Button
              appearance="primary"
              disabled={!name.trim()}
              onClick={() => {
                view.saveView(name.trim(), makeDefault, scope);
                setName("");
                onOpenChange(false);
              }}
            >
              Lưu chế độ xem
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
