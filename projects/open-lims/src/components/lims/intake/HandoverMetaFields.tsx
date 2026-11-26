import { Dropdown, Field, Option, Spinner, Textarea } from "@fluentui/react-components";
import { useHandoverCounterparts } from "@/features/reception/hooks";
import type { HandoverCounterpart } from "@/features/reception/types";
import { FieldLabel } from "@/components/lims/common";

export type ScanMethod = "QR" | "MANUAL";

/**
 * Ba trường nhật ký mà `POST /handovers` nhận ngoài danh sách mã quét: phương thức quét, người
 * đối ứng và ghi chú (`HandoverResource.CreateHandoverRequestBody`). Dùng chung cho màn Tiếp nhận
 * (S-07, qua `HandoverCard`) và màn Bàn giao độc lập (S-09) - hai màn ghi cùng một bản ghi
 * `ops.handover`, nên phải hỏi cùng một bộ câu hỏi.
 *
 * `note` bắt buộc khi nhập tay: một mã vào hệ thống không qua máy quét là ngoại lệ cần có lý do
 * trong nhật ký, không phải thao tác thường ngày.
 */
/**
 * Nhãn một người trong ô chọn.
 *
 * Hai người trùng tên là chuyện có thật trong danh sách chi nhánh, và khi đó nhãn "tên · chức
 * danh" vẫn có thể ra hai dòng giống hệt nhau - người chọn không có gì để phân biệt, chọn nhầm
 * thì nhật ký ghi sai tên người nhận mẫu mà không sửa được. Chỉ thêm mã người dùng vào đúng
 * những dòng thật sự đụng nhau: thêm cho tất cả là bắt mọi người đọc một con số họ không cần.
 */
function personLabel(
  person: { id: string; fullName: string; jobTitle?: string },
  ambiguous?: Set<string>,
) {
  const named = person.jobTitle ? `${person.fullName} · ${person.jobTitle}` : person.fullName;
  return ambiguous?.has(named) ? `${named} · mã ${person.id}` : named;
}

export function handoverMetaIncomplete(
  counterpartUserId: string,
  scanMethod: ScanMethod,
  note: string,
) {
  return !counterpartUserId.trim() || (scanMethod === "MANUAL" && !note.trim());
}

export function HandoverMetaFields({
  counterpartUserId,
  scanMethod,
  note,
  disabled,
  people: givenPeople,
  onCounterpartUserId,
  onScanMethod,
  onNote,
}: {
  counterpartUserId: string;
  scanMethod: ScanMethod;
  note: string;
  disabled?: boolean;
  /** Danh sách người đối ứng dựng sẵn. Bản minh hoạ truyền vào để màn không gọi
   *  `GET /handovers/counterparts` - không có phiên đăng nhập thật thì gọi cũng chỉ ra lỗi. */
  people?: HandoverCounterpart[];
  onCounterpartUserId: (value: string) => void;
  onScanMethod: (value: ScanMethod) => void;
  onNote: (value: string) => void;
}) {
  const counterparts = useHandoverCounterparts(!disabled && !givenPeople);
  const people = givenPeople ?? counterparts.data?.content ?? [];
  const selectedCounterpart = people.find(
    (person: HandoverCounterpart) => person.id === counterpartUserId,
  );
  const ambiguousLabels = new Set(
    people
      .map((person: HandoverCounterpart) => personLabel(person))
      .filter((label, index, all) => all.indexOf(label) !== index),
  );
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
        <Field label="Phương thức">
          <Dropdown
            style={{ minWidth: 0 }}
            value={scanMethod === "QR" ? "Quét QR" : "Nhập tay"}
            selectedOptions={[scanMethod]}
            disabled={disabled}
            onOptionSelect={(_, data) => onScanMethod(data.optionValue as ScanMethod)}
          >
            <Option value="QR">Quét QR</Option>
            <Option value="MANUAL">Nhập tay</Option>
          </Dropdown>
        </Field>
        {/* Chọn theo tên, không gõ số id: đọc số cho nhau qua hành lang rồi gõ nhầm một chữ số
            là ghi sai tên người vào một nhật ký chỉ ghi thêm, không sửa được. Danh sách lấy từ
            `GET /handovers/counterparts` - người trong chi nhánh của chính người đang thao tác. */}
        <Field
          label={
            <FieldLabel
              label="Người giao/nhận đối ứng"
              tooltip="Người ở đầu bên kia của lượt bàn giao này"
            />
          }
          required
          validationState={!givenPeople && counterparts.isError ? "warning" : "none"}
          validationMessage={
            !givenPeople && counterparts.isError
              ? "Không tải được danh sách người trong chi nhánh."
              : undefined
          }
        >
          <Dropdown
            style={{ minWidth: 0 }}
            value={selectedCounterpart ? personLabel(selectedCounterpart, ambiguousLabels) : ""}
            selectedOptions={counterpartUserId ? [counterpartUserId] : []}
            disabled={disabled || (!givenPeople && counterparts.isLoading)}
            placeholder={!givenPeople && counterparts.isLoading ? "Đang tải…" : "Chọn người"}
            onOptionSelect={(_, data) => onCounterpartUserId(data.optionValue ?? "")}
          >
            {people.map((person: HandoverCounterpart) => (
              <Option key={person.id} value={person.id}>
                {personLabel(person, ambiguousLabels)}
              </Option>
            ))}
          </Dropdown>
          {!givenPeople && counterparts.isLoading ? <Spinner size="tiny" /> : null}
        </Field>
      </div>
      <Field label="Ghi chú" required={scanMethod === "MANUAL"}>
        <Textarea
          rows={2}
          value={note}
          disabled={disabled}
          placeholder={
            scanMethod === "MANUAL" ? "Nêu lý do phải nhập tay" : "Ghi chú bàn giao (nếu có)"
          }
          onChange={(_, data) => onNote(data.value)}
        />
      </Field>
    </>
  );
}
