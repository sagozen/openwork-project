import { useEffect, useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Spinner,
} from "@fluentui/react-components";
import { hintText } from "../request-styles";
import type { CustomerRecord, NewCustomerInput } from "./types";

const FIELDS = [
  ["name", "Tên công ty", "Cty TNHH XNK Nông sản An Phát"],
  ["taxCode", "Mã số thuế", "0312445671"],
  ["representative", "Người đại diện", "Ngô Thị Kim Chi"],
  ["phone", "Điện thoại", "0918442117"],
  ["email", "Email", "an.nguyen@example.com"],
  ["address", "Địa chỉ", "12 Nguyễn Văn Cừ, Q.5, TP.HCM"],
] as const;

/** Tạo khách hàng mới ngay trong luồng chọn khách: tạo xong là chọn luôn, người nhập không phải
 *  quay lại ô tìm kiếm. Tên là trường bắt buộc duy nhất, đúng như API `/customers`. */
export function CustomerCreateDialog({
  open,
  onOpenChange,
  onCreate,
  initialName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: NewCustomerInput) => Promise<CustomerRecord>;
  initialName?: string;
}) {
  const [values, setValues] = useState<NewCustomerInput>({ name: "" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  // Chữ đã gõ ở ô tìm kiếm là tên khách hàng người nhập đang tìm - điền sẵn để khỏi gõ lại.
  useEffect(() => {
    if (!open) return;
    setValues({ name: initialName?.trim() ?? "" });
    setError(undefined);
    setPending(false);
  }, [open, initialName]);

  const submit = async () => {
    setPending(true);
    setError(undefined);
    try {
      const input: NewCustomerInput = { name: values.name.trim() };
      for (const [key] of FIELDS) {
        const value = values[key]?.trim();
        if (key !== "name" && value) input[key] = value;
      }
      await onCreate(input);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tạo được khách hàng.");
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface style={{ maxWidth: 560 }}>
        <DialogBody>
          <DialogTitle>Tạo khách hàng mới</DialogTitle>
          <DialogContent>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {error ? (
                <MessageBar intent="error">
                  <MessageBarBody>{error}</MessageBarBody>
                </MessageBar>
              ) : null}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))",
                  gap: 12,
                }}
              >
                {FIELDS.map(([key, label, placeholder]) => (
                  <Field key={key} label={label} required={key === "name"}>
                    <Input
                      value={values[key] ?? ""}
                      placeholder={placeholder}
                      disabled={pending}
                      onChange={(_, d) => setValues((prev) => ({ ...prev, [key]: d.value }))}
                    />
                  </Field>
                ))}
              </div>
              <span style={hintText}>
                Khách hàng tạo xong sẽ được chọn ngay cho hồ sơ này. Chỉ tên công ty là bắt buộc.
              </span>
            </div>
          </DialogContent>
          <DialogActions>
            <Button disabled={pending} onClick={() => onOpenChange(false)}>
              Huỷ
            </Button>
            <Button
              appearance="primary"
              disabled={pending || !values.name.trim()}
              icon={pending ? <Spinner size="tiny" /> : undefined}
              onClick={() => void submit()}
            >
              Tạo và chọn khách hàng
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
