import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { Button, Spinner } from "@fluentui/react-components";
import { ArrowUpload20Regular, CheckmarkCircle20Regular } from "@fluentui/react-icons";
// Đường dẫn thẳng tới module trần dung lượng chứ không qua `@/lib/api`: ô chọn tệp là thành phần
// hiển thị, không cần kéo theo client HTTP và các hook truy vấn của cả tầng API.
import { MAX_UPLOAD_LABEL, isOversized, oversizedFilesMessage } from "@/lib/api/upload-limits";

type FileHandlerResult = void | Promise<void>;

interface FileDropFieldBaseProps {
  accept: string;
  /** Chữ hiện khi chưa chọn gì - nói rõ cần tệp gì và định dạng nào. */
  idle: ReactNode;
  /** Chữ hiện khi đã có tệp; vắng mặt nghĩa là ô này không giữ trạng thái đã chọn. */
  selected?: ReactNode;
  pending?: boolean;
  pendingLabel?: string;
  disabled?: boolean;
  buttonLabel?: string;
  compact?: boolean;
}

type FileDropFieldProps = FileDropFieldBaseProps &
  (
    | {
        multiple: true;
        onFiles: (files: File[]) => FileHandlerResult;
        onFile?: never;
      }
    | {
        multiple?: false;
        onFile: (file: File) => FileHandlerResult;
        onFiles?: never;
      }
  );

/**
 * Ô chọn tệp dạng khung đứt nét, dùng chung cho mọi chỗ người dùng đính kèm tài liệu.
 *
 * Trước đây chỉ ô BM01 ở màn tạo hồ sơ được dựng như thế này, còn ô chứng từ thanh toán và ô bản
 * scan đã ký để nguyên `<input type="file">` của trình duyệt - ra nút xám «Choose File / No file
 * chosen» bằng tiếng Anh, giữa một màn tiếng Việt. Cùng một thao tác mà ba màn trông khác nhau,
 * nên gom về một chỗ: thêm một chỗ đính kèm nữa thì dùng lại, không dựng lại.
 */
export function FileDropField(props: FileDropFieldProps) {
  const {
    accept,
    idle,
    selected,
    pending,
    pendingLabel = "Đang tải…",
    disabled,
    buttonLabel = selected ? "Chọn tệp khác" : "Chọn tệp",
    compact,
  } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [rejected, setRejected] = useState<string>();
  const [internalPending, setInternalPending] = useState(false);
  const showPending = Boolean(pending || internalPending);
  const blocked = Boolean(disabled || showPending);

  const runHandler = (handler: () => FileHandlerResult) => {
    const result = handler();
    if (result && typeof (result as Promise<void>).then === "function") {
      setInternalPending(true);
      void (result as Promise<void>).finally(() => setInternalPending(false));
    }
  };

  /**
   * Chặn tệp quá trần ngay tại đây, một lần cho mọi màn.
   *
   * Máy chủ từ chối thân yêu cầu quá khổ ở tầng HTTP với phản hồi rỗng, nên để tệp đi tiếp là đổi
   * vài phút sóng 4G lấy một câu báo lỗi chung. Đặt ở ô chọn tệp thay vì ở từng màn vì mọi chỗ
   * đính kèm đều đi qua đây - thêm một màn mới là đã có sẵn chặn, không phải nhớ chép lại.
   *
   * Giữ những tệp đạt thay vì bỏ cả lượt chọn: bốn tấm đạt mà một tấm quá nặng thì bắt chọn lại từ
   * đầu là phạt nhầm người; câu báo gọi thẳng tên tấm bị loại nên không ai phải đoán.
   */
  const receiveFiles = (files: File[]) => {
    if (blocked || files.length === 0) return;
    setRejected(oversizedFilesMessage(files));
    const accepted = files.filter((file) => !isOversized(file));
    if (!accepted.length) return;
    if (props.multiple) runHandler(() => props.onFiles(accepted));
    else runHandler(() => props.onFile(accepted[0]!));
  };

  const handleDrag = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!blocked) setDragging(event.type === "dragenter" || event.type === "dragover");
  };

  return (
    <div
      className="dlp-file-drop"
      data-compact={compact || undefined}
      data-dragging={dragging || undefined}
      data-selected={Boolean(selected) || undefined}
      data-disabled={blocked || undefined}
      data-pending={showPending || undefined}
      data-error={Boolean(rejected) || undefined}
      onDragEnter={handleDrag}
      onDragOver={handleDrag}
      onDragLeave={handleDrag}
      onDrop={(event) => {
        handleDrag(event);
        setDragging(false);
        receiveFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <div className="dlp-file-drop__icon" aria-hidden="true">
        {selected ? <CheckmarkCircle20Regular /> : <ArrowUpload20Regular />}
      </div>
      <div className="dlp-file-drop__content">
        {showPending ? (
          <Spinner size="tiny" label={pendingLabel} />
        ) : (
          <>
            <div className="dlp-file-drop__title">{selected ?? idle}</div>
            <div className="dlp-file-drop__hint">
              {dragging
                ? "Thả tệp để chọn"
                : `Kéo thả tệp vào đây hoặc chọn từ thiết bị · tối đa ${MAX_UPLOAD_LABEL} mỗi tệp`}
            </div>
          </>
        )}
      </div>
      {!showPending ? (
        <Button
          type="button"
          appearance={selected ? "secondary" : "primary"}
          icon={<ArrowUpload20Regular />}
          disabled={blocked}
          onClick={() => inputRef.current?.click()}
        >
          {buttonLabel}
        </Button>
      ) : null}
      {rejected ? (
        <div className="dlp-file-drop__error" role="alert">
          {rejected}
        </div>
      ) : null}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={props.multiple}
        disabled={blocked}
        className="dlp-file-drop__input"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          // Trả ô về rỗng để chọn lại đúng tệp vừa chọn vẫn bắn sự kiện (trình duyệt bỏ qua khi
          // giá trị không đổi) - người dùng sửa file rồi chọn lại là chuyện thường.
          event.currentTarget.value = "";
          receiveFiles(files);
        }}
      />
    </div>
  );
}
