import { useEffect, useMemo, useState } from "react";
import {
  Button,
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
  Switch,
} from "@fluentui/react-components";
import { FieldLabel, FileDropField, useDlpToast } from "@/components/lims/common";
import { useAuth } from "@/lib/auth/AuthProvider";
import { createIamApi } from "@/features/iam/api/iamApi";
import type { IamSignatureProfile } from "@/features/iam/types/iam";
import { apiErrorMessage } from "@/lib/api";
import { formatNowIn, TIMEZONES, useUserPrefs, type UserPrefs } from "@/lib/auth/user-prefs";

/** Chức danh trên `ops.app_user` giới hạn 120 ký tự; máy chủ từ chối phần vượt quá. */
const MAX_JOB_TITLE = 120;

const SIGNATURE_HINT =
  "PNG nền trong suốt hoặc JPEG nền trắng · tối đa 2 MB · cạnh dài tối đa 600 px. " +
  "Ảnh này được in lên phiếu kết quả của những hồ sơ bạn phê duyệt.";

export function ProfileDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { user, getToken, usesClerk } = useAuth();
  const api = useMemo(() => createIamApi(getToken), [getToken]);
  const { prefs, update } = useUserPrefs();
  const toast = useDlpToast();
  const [draft, setDraft] = useState<UserPrefs>(prefs);
  // Chữ ký và chức danh nằm ở route riêng (`/me/signature`), không thuộc `GET /me`, nên giữ
  // state riêng thay vì nhét vào `UserPrefs` (chỉ lưu trên máy).
  const [signature, setSignature] = useState<IamSignatureProfile>();
  const [jobTitle, setJobTitle] = useState("");
  const [signatureFile, setSignatureFile] = useState<File>();
  const [signaturePreview, setSignaturePreview] = useState<string>();
  const [signatureError, setSignatureError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setDraft({ ...prefs, name: prefs.name || user?.name || "" });
    if (!open) setSignatureFile(undefined);
  }, [open, prefs, user?.name]);

  // Hồ sơ chữ ký đang lưu. Chỉ hỏi máy chủ khi đang chạy với danh tính thật - chế độ giả lập
  // không có token để gọi.
  useEffect(() => {
    if (!open || !usesClerk) return;
    let cancelled = false;
    void api
      .signature()
      .then((profile) => {
        if (cancelled) return;
        setSignature(profile);
        setJobTitle(profile.jobTitle ?? "");
        setSignatureError(undefined);
      })
      .catch((error: unknown) => {
        if (!cancelled) setSignatureError(apiErrorMessage(error, "Không đọc được hồ sơ chữ ký."));
      });
    return () => {
      cancelled = true;
    };
  }, [open, usesClerk, api]);

  // Ảnh đã lưu, để người ký tự kiểm tra thứ sẽ được in ra. Tệp vừa chọn được xem trước tại chỗ và
  // lấn lượt tải này, vì nó mới là thứ sắp được ghi.
  useEffect(() => {
    if (signatureFile) {
      const objectUrl = URL.createObjectURL(signatureFile);
      setSignaturePreview(objectUrl);
      return () => URL.revokeObjectURL(objectUrl);
    }
    if (!open || !usesClerk || !signature?.hasSignature) {
      setSignaturePreview(undefined);
      return;
    }
    let cancelled = false;
    let objectUrl: string | undefined;
    void api
      .signatureImage()
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setSignaturePreview(objectUrl);
      })
      .catch(() => {
        // Không đọc được ảnh không cản trở việc sửa chức danh; ô xem trước đơn giản là trống.
        if (!cancelled) setSignaturePreview(undefined);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [open, usesClerk, signature?.hasSignature, signatureFile, api]);

  const patch = (p: Partial<UserPrefs>) => setDraft((d) => ({ ...d, ...p }));

  /**
   * Ảnh mới đi hai bước: tải tệp lấy `documentId`, rồi gắn id đó vào hồ sơ. Không gửi
   * `signatureDocumentId` khi không có tệp mới - bỏ trống là giữ nguyên ảnh đang lưu, còn chức
   * danh thì luôn ghi đè (xoá ô nhập là xoá chức danh).
   */
  const saveSignature = async () => {
    const documentId = signatureFile
      ? (await api.uploadSignatureImage(signatureFile)).id
      : undefined;
    const nothingChanged = !documentId && jobTitle.trim() === (signature?.jobTitle ?? "");
    if (nothingChanged) return;
    const saved = await api.updateSignature({
      jobTitle: jobTitle.trim(),
      ...(documentId ? { signatureDocumentId: documentId } : {}),
    });
    setSignature(saved);
    setSignatureFile(undefined);
  };

  const save = () => {
    if (!usesClerk) {
      update(draft);
      onOpenChange(false);
      toast(
        "Đã lưu hồ sơ cá nhân",
        signatureFile
          ? `Múi giờ hiển thị: ${draft.timezone} · ảnh chữ ký ${signatureFile.name} chỉ xem trước ở bản minh hoạ`
          : `Múi giờ hiển thị: ${draft.timezone}`,
      );
      return;
    }
    setSaving(true);
    // Chữ ký lưu trước: nếu ảnh bị từ chối (nền tối, quá khổ, tệp hỏng) thì hộp thoại phải mở
    // nguyên trạng với thông báo của máy chủ, chứ không đóng lại như thể đã lưu xong.
    void (async () => {
      try {
        await saveSignature();
        await api.updatePreferences(draft.timezone);
        update(draft);
        onOpenChange(false);
        toast("Đã lưu hồ sơ cá nhân", `Múi giờ hiển thị: ${draft.timezone}`);
      } catch (error: unknown) {
        toast("Không thể lưu hồ sơ", apiErrorMessage(error, "Vui lòng thử lại."), "error");
      } finally {
        setSaving(false);
      }
    })();
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface style={{ maxWidth: 520 }}>
        <DialogBody>
          <DialogTitle>Hồ sơ cá nhân</DialogTitle>
          <DialogContent>
            <div style={{ display: "grid", gap: 12, paddingBlock: 4 }}>
              {/* Danh tính thật: tên do quản trị đặt trong danh bạ người dùng, không sửa được ở
                  đây (không có route nào ghi `app_user.full_name` từ màn này). Trước đây ô này
                  nhận chữ rồi lưu vào tuỳ chọn trên máy - gõ xong thì header đổi tên trong khi
                  dữ liệu hệ thống không hề đổi, và cái tên đó còn dính sang tài khoản đăng nhập
                  sau trên cùng trình duyệt. */}
              <Field
                label={
                  <FieldLabel
                    label="Họ và tên"
                    tooltip={usesClerk ? "Do quản trị đặt trong danh bạ người dùng" : undefined}
                  />
                }
              >
                {usesClerk ? (
                  <Input value={user?.name ?? ""} readOnly disabled />
                ) : (
                  <Input value={draft.name} onChange={(_, d) => patch({ name: d.value })} />
                )}
              </Field>
              <Field label="Email">
                <Input value={user?.email ?? ""} readOnly disabled />
              </Field>
              {/* Bàn giao giờ chọn người theo tên (`GET /handovers/counterparts`) nên không ai
                  phải đọc số này cho nhau nữa. Giữ lại vì mã người dùng vẫn là thứ hỗ trợ hỏi tới
                  khi tra một dòng nhật ký. */}
              <Field
                label={
                  <FieldLabel
                    label="Mã người dùng"
                    tooltip="Dùng khi cần đối chiếu một dòng nhật ký với hỗ trợ"
                  />
                }
              >
                <Input value={user?.id ?? ""} readOnly disabled />
              </Field>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Field label="Số điện thoại">
                  <Input
                    value={draft.phone}
                    placeholder="09xx xxx xxx"
                    onChange={(_, d) => patch({ phone: d.value })}
                  />
                </Field>
                <Field label="Chi nhánh">
                  <Input value={user?.branch ?? ""} readOnly disabled />
                </Field>
              </div>
              <Field label="Vai trò">
                <Input value={user?.role ?? ""} readOnly disabled />
              </Field>
              <Field label="Ngôn ngữ">
                <Dropdown
                  selectedOptions={[draft.lang]}
                  value={draft.lang === "vi" ? "Tiếng Việt" : "English"}
                  onOptionSelect={(_, d) => patch({ lang: d.optionValue as UserPrefs["lang"] })}
                >
                  <Option value="vi">Tiếng Việt</Option>
                  <Option value="en">English</Option>
                </Dropdown>
              </Field>
              <Field
                label={
                  <FieldLabel
                    label="Múi giờ hiển thị"
                    tooltip={`Giờ hiện tại: ${formatNowIn(draft.timezone)}`}
                  />
                }
              >
                <Dropdown
                  selectedOptions={[draft.timezone]}
                  value={TIMEZONES.find((t) => t.id === draft.timezone)?.label ?? draft.timezone}
                  onOptionSelect={(_, d) => patch({ timezone: d.optionValue as string })}
                >
                  {TIMEZONES.map((t) => (
                    <Option key={t.id} value={t.id} text={t.label}>
                      {t.label}
                    </Option>
                  ))}
                </Dropdown>
              </Field>
              <Switch
                checked={draft.theme === "dark"}
                onChange={(_, d) => patch({ theme: d.checked ? "dark" : "light" })}
                label="Giao diện tối"
              />
              {/* Chức danh và ảnh chữ ký hiện ở cả hai chế độ: đây là thứ được in dưới chữ ký
                  trên phiếu kết quả, nên bản minh hoạ giấu đi thì khách không góp ý được về nó.
                  Bản minh hoạ chỉ xem trước tại chỗ, không gọi `/me/signature`. */}
              <div style={{ display: "grid", gap: 12, paddingBlockStart: 4 }}>
                <Field
                  label={
                    <FieldLabel
                      label="Chức danh"
                      tooltip="In dưới chữ ký trên phiếu kết quả. Để trống nếu không có chức danh."
                    />
                  }
                  validationState={signatureError ? "error" : "none"}
                  validationMessage={signatureError}
                >
                  <Input
                    value={jobTitle}
                    maxLength={MAX_JOB_TITLE}
                    placeholder="Ví dụ: Giám đốc Trung tâm"
                    onChange={(_, d) => setJobTitle(d.value)}
                  />
                </Field>
                <Field label={<FieldLabel label="Ảnh chữ ký" tooltip={SIGNATURE_HINT} />}>
                  <FileDropField
                    accept="image/png,image/jpeg"
                    compact
                    disabled={saving}
                    pending={saving && Boolean(signatureFile)}
                    pendingLabel="Đang lưu ảnh chữ ký…"
                    idle="Chọn ảnh chữ ký để xem trước"
                    selected={
                      signatureFile
                        ? `Đã chọn ${signatureFile.name}`
                        : signature?.hasSignature
                          ? "Đang dùng ảnh chữ ký đã lưu"
                          : undefined
                    }
                    buttonLabel={signatureFile || signature?.hasSignature ? "Đổi ảnh" : "Chọn ảnh"}
                    onFile={setSignatureFile}
                  />
                </Field>
                {signaturePreview ? (
                  <div style={{ display: "grid", gap: 4 }}>
                    <img
                      src={signaturePreview}
                      alt="Chữ ký đang lưu"
                      style={{
                        maxWidth: 240,
                        maxHeight: 96,
                        objectFit: "contain",
                        background: "#fff",
                        border: "1px solid var(--colorNeutralStroke2)",
                        borderRadius: 4,
                        padding: 4,
                      }}
                    />
                    <span style={{ fontSize: 12, opacity: 0.7 }}>
                      {signatureFile ? "Ảnh vừa chọn, chưa lưu." : "Ảnh đang lưu trên hồ sơ."}
                    </span>
                  </div>
                ) : null}
              </div>
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" disabled={saving} onClick={() => onOpenChange(false)}>
              Huỷ
            </Button>
            <Button appearance="primary" disabled={saving} onClick={save}>
              {saving ? "Đang lưu…" : "Lưu thay đổi"}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
