import { Button, Checkbox, MessageBar, MessageBarBody } from "@fluentui/react-components";
import { card, hintText, sectionTitle } from "@/components/lims/request-styles";
import {
  HandoverMetaFields,
  handoverMetaIncomplete,
  type ScanMethod,
} from "@/components/lims/intake/HandoverMetaFields";
import { HandoverLog } from "@/components/lims/intake/HandoverLog";
import type { HandoverLogEntry } from "@/features/request/types";
import type { HandoverCounterpart } from "@/features/reception/types";
import { formatDateTime } from "@/lib/format";

export type HandoverStep = "DELIVER" | "RECEIVE";
export type { ScanMethod };

/** Nhãn tiếng Việt của từng bước, dùng cho nút và câu dẫn TRƯỚC khi có bản ghi nào để máy chủ
 *  đặt tên. Sau khi ghi, nhãn hiển thị lấy thẳng từ `step.name` của máy chủ (`HandoverLog`) - một
 *  bộ từ vựng, do máy chủ sở hữu, không dịch lại ở hai nơi. */
const STEP_LABEL: Record<HandoverStep, string> = {
  DELIVER: "Một cửa giao mẫu",
  RECEIVE: "Lab nhận mẫu",
};

export function HandoverCard({
  sampleCode,
  isLab,
  disabled,
  busy,
  error,
  success,
  counterpartUserId,
  scanMethod,
  note,
  people,
  log,
  logPending,
  repeatAcknowledged,
  onRepeatAcknowledged,
  onCounterpartUserId,
  onScanMethod,
  onNote,
  onSubmit,
}: {
  sampleCode: string;
  isLab: boolean;
  disabled?: boolean;
  busy?: boolean;
  error?: string;
  success?: string;
  counterpartUserId: string;
  scanMethod: ScanMethod;
  note: string;
  /** Danh sách người đối ứng dựng sẵn - xem `HandoverMetaFields`. */
  people?: HandoverCounterpart[];
  log?: HandoverLogEntry[];
  logPending?: boolean;
  repeatAcknowledged: boolean;
  onRepeatAcknowledged: (value: boolean) => void;
  onCounterpartUserId: (value: string) => void;
  onScanMethod: (value: ScanMethod) => void;
  onNote: (value: string) => void;
  onSubmit: () => void;
}) {
  const step: HandoverStep = isLab ? "RECEIVE" : "DELIVER";
  // `ops.handover` chỉ ghi thêm (V10), nên bước này ghi lần thứ hai là HỢP LỆ - đó là cách sửa
  // một lượt quét nhầm. Cái không hợp lệ là ghi lần thứ hai mà không biết mình đang làm vậy.
  // Nên: không chặn, mà bắt xác nhận có ý thức, kèm nêu đích danh bản ghi đã có.
  const priorSameStep = (log ?? []).filter((entry) => entry.step.code === step);
  const lastPrior = priorSameStep[0];
  const needsRepeatAck = priorSameStep.length > 0;
  const blocked =
    disabled ||
    busy ||
    handoverMetaIncomplete(counterpartUserId, scanMethod, note) ||
    (needsRepeatAck && !repeatAcknowledged);

  return (
    <div style={card}>
      <div>
        <div style={sectionTitle}>{isLab ? "Lab xác nhận nhận mẫu" : "Bàn giao mẫu vào lab"}</div>
        <div style={{ ...hintText, marginTop: 4 }}>
          Mã quét: <span className="dlp-num">{sampleCode}</span> · bước {STEP_LABEL[step]}
        </div>
      </div>

      <HandoverLog entries={log} pending={logPending} />

      {needsRepeatAck ? (
        <MessageBar intent="warning">
          <MessageBarBody>
            Hồ sơ này đã có {priorSameStep.length} lượt «{STEP_LABEL[step]}»
            {lastPrior
              ? `, gần nhất do ${lastPrior.performedBy.fullName ?? `mã ${lastPrior.performedBy.id}`} ghi lúc ${formatDateTime(lastPrior.performedAt)}`
              : ""}
            . Ghi thêm sẽ tạo một dòng mới trong nhật ký, không thay thế dòng cũ.
          </MessageBarBody>
        </MessageBar>
      ) : null}

      <HandoverMetaFields
        counterpartUserId={counterpartUserId}
        scanMethod={scanMethod}
        note={note}
        disabled={disabled || busy}
        people={people}
        onCounterpartUserId={onCounterpartUserId}
        onScanMethod={onScanMethod}
        onNote={onNote}
      />

      {needsRepeatAck ? (
        <Checkbox
          checked={repeatAcknowledged}
          disabled={disabled || busy}
          onChange={(_, data) => onRepeatAcknowledged(!!data.checked)}
          label="Tôi xác nhận đây là bản ghi bổ sung hoặc sửa lượt quét trước, không phải bấm nhầm."
        />
      ) : null}

      {error ? (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      ) : null}
      {success ? (
        <MessageBar intent="success">
          <MessageBarBody>{success}</MessageBarBody>
        </MessageBar>
      ) : null}
      <Button appearance="primary" disabled={blocked} onClick={onSubmit}>
        Ghi nhận {step === "DELIVER" ? "giao mẫu" : "nhận mẫu"}
      </Button>
    </div>
  );
}
