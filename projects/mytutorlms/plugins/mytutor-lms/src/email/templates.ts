import type { Locale } from "../model.js";

export type TemplateId =
  | "sign_in_code"
  | "invitation"
  | "access_granted"
  | "access_ending"
  | "access_ended"
  | "email_changed"
  | "test";
type Data = Record<string, string | number>;
interface Rendered {
  subject: string;
  text: string;
}
type Catalog = Record<TemplateId, (data: Data) => Rendered>;

const v = (data: Data, name: string) => String(data[name] ?? "");
// The site name may be unset; build phrases around it so no dangling gap or preposition is left.
const site = (data: Data, before = "") => {
  const name = v(data, "siteName").trim();
  return name ? `${before}${name}` : "";
};

const en: Catalog = {
  sign_in_code: (data) => ({
    subject: `Your sign-in code${site(data, " for ")}`,
    text: `Your sign-in code is ${v(data, "code")}.\n\nOr open this link on the same device:\n${v(data, "link")}\n\nThe code and link expire in 15 minutes. If you did not ask to sign in, you can ignore this email.`,
  }),
  invitation: (data) => ({
    subject: `You're invited to ${v(data, "courseTitle")}`,
    text: `${v(data, "instructor")} invited you to ${v(data, "courseTitle")}${site(data, " on ")}.\n\nOpen your private invitation:\n${v(data, "link")}\n\nThe invitation works once and expires in 7 days.`,
  }),
  access_granted: (data) => ({
    subject: `You now have access to ${v(data, "courseTitle")}`,
    text: `You can now study ${v(data, "courseTitle")}${data.expiresAt ? ` until ${v(data, "expiresAt")}` : ""}.\n\nSign in at ${v(data, "url")} with this email address.`,
  }),
  access_ending: (data) => ({
    subject: `Your access to ${v(data, "courseTitle")} ends soon`,
    text: `Your access to ${v(data, "courseTitle")} ends on ${v(data, "expiresAt")}. Your progress stays saved.`,
  }),
  access_ended: (data) => ({
    subject: `Your access to ${v(data, "courseTitle")} has ended`,
    text: `Your access to ${v(data, "courseTitle")} ended on ${v(data, "expiresAt")}. Your progress stays saved and you can still see it on your dashboard.`,
  }),
  email_changed: (data) => ({
    subject: `Your account email was changed`,
    text: `The site owner changed the email address on your account${site(data, " at ")}. If this is unexpected, reply to this email or contact ${v(data, "supportEmail")}.`,
  }),
  test: (data) => ({
    subject: `Test email${site(data, " from ")}`,
    text: "Email delivery for your course site is working.",
  }),
};

const vi: Catalog = {
  sign_in_code: (data) => ({
    subject: `Mã đăng nhập${site(data, " ")} của bạn`,
    text: `Mã đăng nhập của bạn là ${v(data, "code")}.\n\nHoặc mở liên kết này trên chính thiết bị đang dùng:\n${v(data, "link")}\n\nMã và liên kết hết hạn sau 15 phút. Nếu bạn không yêu cầu đăng nhập, hãy bỏ qua email này.`,
  }),
  invitation: (data) => ({
    subject: `Bạn được mời tham gia ${v(data, "courseTitle")}`,
    text: `${v(data, "instructor")} mời bạn tham gia ${v(data, "courseTitle")}${site(data, " trên ")}.\n\nMở lời mời dành riêng cho bạn:\n${v(data, "link")}\n\nLời mời chỉ dùng được một lần và hết hạn sau 7 ngày.`,
  }),
  access_granted: (data) => ({
    subject: `Bạn đã có thể học ${v(data, "courseTitle")}`,
    text: `Bạn đã có thể học ${v(data, "courseTitle")}${data.expiresAt ? ` đến ${v(data, "expiresAt")}` : ""}.\n\nĐăng nhập tại ${v(data, "url")} bằng địa chỉ email này.`,
  }),
  access_ending: (data) => ({
    subject: `Quyền học ${v(data, "courseTitle")} sắp hết hạn`,
    text: `Quyền học ${v(data, "courseTitle")} của bạn sẽ hết hạn vào ${v(data, "expiresAt")}. Tiến độ học vẫn được lưu lại.`,
  }),
  access_ended: (data) => ({
    subject: `Quyền học ${v(data, "courseTitle")} đã hết hạn`,
    text: `Quyền học ${v(data, "courseTitle")} của bạn đã hết hạn vào ${v(data, "expiresAt")}. Tiến độ học vẫn được lưu lại và bạn có thể xem trong trang học của mình.`,
  }),
  email_changed: (data) => ({
    subject: `Email tài khoản của bạn đã được đổi`,
    text: `Chủ trang đã đổi địa chỉ email của tài khoản bạn${site(data, " tại ")}. Nếu bạn không biết về thay đổi này, hãy trả lời email này hoặc liên hệ ${v(data, "supportEmail")}.`,
  }),
  test: (data) => ({
    subject: `Email thử${site(data, " từ ")}`,
    text: "Trang khóa học của bạn gửi email bình thường.",
  }),
};

// Spanish arrives with the localization release (0.5); it falls back to English until then.
const catalogs: Partial<Record<Locale, Catalog>> = { en, vi };

export function render(
  template: TemplateId,
  locale: Locale,
  data: Data,
): Rendered {
  return (catalogs[locale] ?? en)[template](data);
}
