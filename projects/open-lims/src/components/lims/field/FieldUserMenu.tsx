import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Avatar } from "@fluentui/react-components";
import { SignOut20Regular } from "@fluentui/react-icons";
import { PopoverMenu } from "@/components/lims/common";
import { useAuth } from "@/lib/auth/AuthProvider";
import { resolveAllowedNavLinks } from "@/lib/auth/nav-access";

/* Màn S-05 chạy ngoài `_app` nên không có rail điều hướng lẫn menu người dùng của AppShell:
   vào đây rồi thì không còn đường sang màn khác cũng không đăng xuất được. Menu này mang theo
   đúng hai thứ đó, danh sách màn lấy từ `nav-access` để khớp với rail bên trong AppShell. */
export function FieldUserMenu({ onSurface = "accent" }: { onSurface?: "accent" | "surface" }) {
  const { user, can, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  // Bỏ chính màn đang đứng để menu chỉ còn lối đi tiếp.
  const links = resolveAllowedNavLinks(can).filter((link) => link.to !== "/lay-mau");

  return (
    <div style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        className={onSurface === "accent" ? "dlp-field__back" : "dlp-field__usermenu"}
        aria-label="Menu người dùng"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Avatar
          size={28}
          name={user?.name ?? ""}
          initials={user?.initials ?? ""}
          color="colorful"
        />
      </button>

      <PopoverMenu
        open={open}
        onClose={() => setOpen(false)}
        align="right"
        width={250}
        label="Menu người dùng"
      >
        <div className="dlp-usermenu__head">
          <div className="dlp-usermenu__name">{user?.name}</div>
          <div className="dlp-usermenu__role">{user?.role}</div>
        </div>

        {/* Tài khoản đủ quyền có tới 10 màn: cho phần liên kết tự cuộn để nút Đăng xuất bên
            dưới luôn nằm trong tầm nhìn, không bị đẩy khỏi popover. */}
        <div style={{ maxHeight: 216, overflowY: "auto" }}>
          {links.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              className="dlp-usermenu__item"
              onClick={() => setOpen(false)}
            >
              <span style={{ flex: 1 }}>{link.label}</span>
            </Link>
          ))}
        </div>

        <button
          type="button"
          className="dlp-usermenu__item dlp-usermenu__item--divided"
          onClick={() => void signOut()}
        >
          <SignOut20Regular />
          <span style={{ flex: 1 }}>Đăng xuất</span>
        </button>
      </PopoverMenu>
    </div>
  );
}
