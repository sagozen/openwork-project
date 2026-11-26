import { useState } from "react";
import {
  Button,
  Dropdown,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerHeaderTitle,
  Field,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Option,
  Textarea,
} from "@fluentui/react-components";
import { Dismiss20Regular } from "@fluentui/react-icons";
import { FieldLabel } from "@/components/lims/common";
import { MAX_RAW_RESULTS_PER_TASK, TEST_PART_NAMES } from "@/features/lab";
import type {
  SampleResultSet,
  SampleRawInput,
  SampleParameter,
} from "@/features/sample/sample-api";
const partName = (part: string) => TEST_PART_NAMES[part as keyof typeof TEST_PART_NAMES] ?? part;
import { apiErrorMessage } from "@/lib/api";
import { IMPORT_COLUMNS, IMPORT_TEMPLATE, parseRawResultRows } from "./import-result-parse";
import type { ParsedRawRow } from "./import-result-parse";
import { RESULT_VALUE_NAMES } from "@/features/sample/sample-api";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sets: SampleResultSet[];
  /** Dùng chung state phần thử với bảng kết quả: dán vào bộ nào thì bảng mở đúng bộ đó, không có
   *  bản sao nào để lệch. */
  part: string;
  onPart: (part: string) => void;
  sampleCode: string;
  unit: string;
  onUnit: (unit: string) => void;
  parameter: SampleParameter;
  /** Lưu một dòng. Ném lỗi khi máy chủ từ chối để màn này ghi lý do vào đúng dòng đó. */
  onImportRow: (input: SampleRawInput) => Promise<void>;
  /** Gọi một lần sau cả lượt để nạp lại task, thay vì nạp lại sau mỗi dòng. */
  onDone: () => Promise<void> | void;
}

type RowState = { status: "pending" | "saved" | "failed"; message?: string };

const STATUS_LABELS: Record<RowState["status"], string> = {
  pending: "Chờ lưu",
  saved: "Đã lưu",
  failed: "Lỗi lưu",
};

export function ImportResultDrawer({
  open,
  onOpenChange,
  sets,
  part,
  onPart,
  sampleCode,
  unit,
  onUnit,
  parameter,
  onImportRow,
  onDone,
}: Props) {
  const [text, setText] = useState("");
  const [rows, setRows] = useState<ParsedRawRow[] | null>(null);
  const [states, setStates] = useState<Record<number, RowState>>({});
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const activeSet = sets.find((set) => set.testPart === part) ?? sets[0];
  // Each parameter/test part has five repeat measurements on this sample.
  const usedHere = activeSet ? activeSet.rawResults.length : 0;
  const capacity = activeSet
    ? Math.max(0, MAX_RAW_RESULTS_PER_TASK - activeSet.rawResults.length)
    : 0;
  const blockedReason = `Mẫu ${sampleCode} đã dùng hết ${MAX_RAW_RESULTS_PER_TASK} chỗ cho thành phần thử này`;

  const reset = () => {
    setRows(null);
    setStates({});
    setDone(false);
  };
  /** Chốt danh sách dòng tại thời điểm bấm kiểm tra: sau khi lưu một phần, sửa ô dán không được
   *  phép đổi ngầm dòng đã gửi lên máy chủ. */
  const check = () => {
    if (saved) return;
    const parsed = parseRawResultRows(text, parameter);
    let used = 0;
    setRows(
      parsed.map((row) => {
        if (row.error) return row;
        used += 1;
        return used > capacity
          ? {
              ...row,
              input: undefined,
              error: blockedReason,
            }
          : row;
      }),
    );
    setStates({});
    setDone(false);
  };
  const savable = (rows ?? []).filter((row) => row.input && states[row.line]?.status !== "saved");
  /** Gửi tuần tự từng dòng: hợp đồng MVP chỉ có API thêm một kết quả gốc, không có giao dịch gộp -
   *  lỗi giữa chừng để lại các dòng trước đó đã lưu, nên trạng thái phải hiện theo từng dòng và
   *  lần bấm lại chỉ gửi những dòng chưa lưu. */
  const save = async () => {
    if (!activeSet || !savable.length) return;
    setRunning(true);
    setDone(false);
    for (const row of savable) {
      try {
        await onImportRow({
          testPart: activeSet.testPart,
          ...row.input!,
          unit,
        });
        setStates((current) => ({ ...current, [row.line]: { status: "saved" } }));
      } catch (caught) {
        setStates((current) => ({
          ...current,
          [row.line]: { status: "failed", message: apiErrorMessage(caught) },
        }));
      }
    }
    setDone(true);
    try {
      await onDone();
      setRefreshError("");
    } catch (cause) {
      setRefreshError(apiErrorMessage(cause));
    } finally {
      setRunning(false);
    }
  };

  const saved = Object.values(states).filter((state) => state.status === "saved").length;
  const failed = Object.values(states).filter((state) => state.status === "failed").length;
  const blocked = (rows ?? []).filter((row) => row.error).length;

  return (
    <Drawer
      type="overlay"
      position="end"
      separator
      open={open}
      onOpenChange={(_, data) => {
        if (!running) onOpenChange(data.open);
      }}
      style={{ width: 720, maxWidth: "100vw" }}
    >
      <DrawerHeader>
        <DrawerHeaderTitle
          action={
            <Button
              appearance="subtle"
              icon={<Dismiss20Regular />}
              aria-label="Đóng"
              disabled={running}
              onClick={() => onOpenChange(false)}
            />
          }
        >
          Dán kết quả từ Excel
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
          {/* `multiline`: MessageBar một dòng cắt cụt câu ở mép drawer ("...những dòng đã lưu
              v") và đẩy cả thân drawer ra thanh cuộn ngang. */}
          <MessageBar intent="info" layout="multiline">
            <MessageBarBody>
              <MessageBarTitle>Mỗi dòng là một kết quả gốc.</MessageBarTitle> Các dòng được lưu lần
              lượt: nếu dừng giữa chừng, những dòng đã lưu vẫn nằm lại trong bộ và không sửa/xoá
              được.
            </MessageBarBody>
          </MessageBar>
          <Field
            label={
              <FieldLabel
                label="Thành phần thử"
                tooltip={
                  capacity > 0
                    ? `Mẫu ${sampleCode} đã dùng ${usedHere}/${MAX_RAW_RESULTS_PER_TASK} chỗ cho thành phần thử này · còn nhận ${capacity} dòng · đơn vị ${unit}`
                    : `${blockedReason} · đơn vị ${unit}`
                }
              />
            }
          >
            <Dropdown
              positioning={{ position: "below", align: "start", autoSize: true }}
              value={activeSet ? `${partName(activeSet.testPart)} · ${activeSet.testPart}` : ""}
              selectedOptions={activeSet ? [activeSet.testPart] : []}
              disabled={running || saved > 0}
              onOptionSelect={(_, data) => {
                onPart(data.optionValue as string);
                reset();
              }}
            >
              {sets.map((set) => (
                <Option key={set.testPart} value={set.testPart}>
                  {`${partName(set.testPart)} · ${set.testPart}`}
                </Option>
              ))}
            </Dropdown>
          </Field>
          <Field
            label={
              <FieldLabel
                label="Dán từ Excel hoặc CSV"
                tooltip={`Cột theo thứ tự: ${IMPORT_COLUMNS.join(" · ")}. Trị số theo cấu hình chỉ tiêu; đơn vị lấy từ ô đã chọn. Dòng tiêu đề được bỏ qua.`}
              />
            }
          >
            <Textarea
              rows={6}
              value={text}
              placeholder={IMPORT_TEMPLATE}
              disabled={running || saved > 0}
              onChange={(_, data) => {
                setText(data.value);
                if (rows) reset();
              }}
            />
          </Field>
          <Field label="Đơn vị kết quả">
            <Dropdown
              value={unit || "Không đơn vị"}
              selectedOptions={[unit]}
              disabled={running || saved > 0}
              onOptionSelect={(_, data) => onUnit(data.optionValue ?? "")}
            >
              {(parameter.allowedUnits.length ? parameter.allowedUnits : [""]).map((item) => (
                <Option key={item} value={item}>
                  {item || "Không đơn vị"}
                </Option>
              ))}
            </Dropdown>
          </Field>
          {/* Placeholder là hai dòng số liệu trông hệt dữ liệu thật, nên ô rỗng đọc như ô đã có
              nội dung - và nút Kiểm tra dữ liệu thì mờ đi mà không nói vì sao. */}
          {!text.trim() ? (
            <span className="dlp-datagrid__secondary">
              Ô đang trống - hai dòng mờ ở trên chỉ là ví dụ về định dạng. Dán dữ liệu vào rồi bấm
              Kiểm tra dữ liệu.
            </span>
          ) : null}
          {refreshError ? (
            <MessageBar intent="warning">
              <MessageBarBody>
                Dữ liệu đã gửi; không tải lại được: {refreshError}
                <Button
                  disabled={running}
                  onClick={async () => {
                    setRunning(true);
                    try {
                      await onDone();
                      setRefreshError("");
                    } catch (cause) {
                      setRefreshError(apiErrorMessage(cause));
                    } finally {
                      setRunning(false);
                    }
                  }}
                >
                  Tải lại dữ liệu
                </Button>
              </MessageBarBody>
            </MessageBar>
          ) : null}
          {rows ? (
            <>
              <div style={{ overflowX: "auto", minWidth: 0 }}>
                <table className="dlp-datagrid dlp-datagrid--medium" style={{ width: "100%" }}>
                  <thead>
                    <tr>
                      <th>Dòng</th>
                      <th>Loại trị số</th>
                      <th>Trị số đo</th>
                      <th>Đơn vị</th>
                      <th>Ghi chú</th>
                      <th>Trạng thái</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const state = states[row.line];
                      return (
                        <tr key={row.line}>
                          <td className="dlp-num">{row.line}</td>
                          <td>{row.input ? RESULT_VALUE_NAMES[row.input.valueType] : "-"}</td>
                          <td className="dlp-num">{row.input?.value ?? row.cells[0] ?? "-"}</td>
                          <td>{unit || "Không đơn vị"}</td>
                          <td>{row.input?.comment ?? row.cells[1] ?? "-"}</td>
                          <td>
                            {row.error ??
                              state?.message ??
                              STATUS_LABELS[state?.status ?? "pending"]}
                          </td>
                        </tr>
                      );
                    })}
                    {!rows.length ? (
                      <tr>
                        <td colSpan={6}>Không đọc được dòng nào từ nội dung đã dán.</td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
              {blocked ? (
                <MessageBar intent="warning" layout="multiline">
                  <MessageBarBody>
                    {blocked} dòng không gửi được, sửa trong nguồn dán rồi bấm Kiểm tra dữ liệu lại.
                  </MessageBarBody>
                </MessageBar>
              ) : null}
              {done ? (
                <MessageBar intent={failed ? "warning" : "success"} layout="multiline">
                  <MessageBarBody>
                    <MessageBarTitle>
                      Đã lưu {saved}/{saved + failed} dòng đã gửi.
                    </MessageBarTitle>
                    {failed
                      ? " Bấm Lưu lại chỉ gửi những dòng còn lỗi; các dòng đã lưu không gửi lại."
                      : " Đóng màn này để chọn kết quả cuối trong bảng."}
                    {saved ? " Đóng rồi mở lại để dán một lượt dữ liệu mới." : ""}
                  </MessageBarBody>
                </MessageBar>
              ) : null}
            </>
          ) : null}
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button disabled={running || saved > 0 || !text.trim()} onClick={check}>
          Kiểm tra dữ liệu
        </Button>
        <Button
          appearance="primary"
          disabled={running || !savable.length}
          onClick={() => void save()}
        >
          {running ? "Đang lưu…" : `Lưu ${savable.length} dòng`}
        </Button>
        <Button disabled={running} onClick={() => onOpenChange(false)}>
          Đóng
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}
