import { Link, useRouterState } from "@tanstack/react-router";
import {
  Avatar,
  Badge,
  Button,
  CounterBadge,
  InteractionTag,
  InteractionTagPrimary,
  Switch,
} from "@fluentui/react-components";
import {
  Alert20Regular,
  ArrowSwap20Regular,
  BeakerEdit20Regular,
  Beaker20Filled,
  Beaker20Regular,
  Glasses20Regular,
  ClipboardTextEdit20Regular,
  ClipboardArrowRight20Regular,
  MailArrowUp20Regular,
  DocumentEdit20Regular,
  BoxCheckmark20Filled,
  BoxCheckmark20Regular,
  BuildingPeople20Regular,
  FolderOpenVertical20Filled,
  FolderOpenVertical20Regular,
  Phone20Regular,
  Navigation20Regular,
  Person20Regular,
  Pin20Filled,
  Pin20Regular,
  QuestionCircle20Filled,
  QuestionCircle20Regular,
  Rocket20Filled,
  Rocket20Regular,
  Settings20Filled,
  Settings20Regular,
  SignOut20Regular,
  TaskListSquareLtr20Regular,
} from "@fluentui/react-icons";
import { useState, type ReactNode } from "react";
import { useAuth } from "@/lib/auth/AuthProvider";
import { resolveNavAccess } from "@/lib/auth/nav-access";
import { AppLogo, PopoverMenu } from "@/components/lims/common";
import { ProfileDialog } from "@/components/lims/ProfileDialog";
import { GlobalSearch } from "@/components/lims/GlobalSearch";
import { NotificationDrawer } from "@/components/lims/NotificationDrawer";
import { SupportFab } from "@/components/lims/support/SupportFab";
import { NOTIF_ITEMS } from "@/lib/admin/notif-data";
import { useUnreadNotificationCount } from "@/features/notification";
import { useUserPrefs } from "@/lib/auth/user-prefs";
import { useSupportStore } from "@/lib/support/support-store";

/* Thanh tab dưới cho điện thoại - nhóm việc hay dùng nhất (theo mockup).
   `badge` là số của bản demo và CHỈ hiện ở chế độ demo: không endpoint nào đếm việc tồn theo
   màn, và AppShell nằm trên mọi trang nên thêm query đếm ở đây là chi phí toàn cục. Ở chế độ dữ
   liệu thật thà không hiện còn hơn hiện một con số bịa. */
const BOTTOM_NAV = [
  { to: "/ho-so", label: "Hồ sơ", icon: <FolderOpenVertical20Regular />, badge: 24 },
  { to: "/tiep-nhan", label: "Tiếp nhận", icon: <BoxCheckmark20Regular />, badge: 0 },
  { to: "/nhap-ket-qua", label: "Kết quả", icon: <ClipboardTextEdit20Regular />, badge: 3 },
  { to: "/phe-duyet", label: "Phê duyệt", icon: <ClipboardArrowRight20Regular />, badge: 0 },
  { to: "/lay-mau", label: "Hiện trường", icon: <Phone20Regular />, badge: 0 },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const { user, signOut, can, usesClerk } = useAuth();
  // Mỗi mục menu nghiệp vụ hiện theo ĐÚNG permission màn hình đó đòi (D19/FR-IAM-023) -
  // không còn một cổng "record.read" chung cho cả khối như trước. Điều kiện lấy từ
  // `nav-access` để menu và trang mặc định sau đăng nhập không lệch nhau.
  const access = resolveNavAccess(can, usesClerk);
  const canSeeRequest = access.request;
  const canSeeRequestEdit = access.requestEdit;
  const canSeeReception = access.reception;
  const canSeeHandover = access.handover;
  const canSeeLab = access.lab;
  const canSeeLabResultEntry = access.labResultEntry;
  const canSeeTechnicalReview = access.technicalReview;
  const canSeeApproval = access.approval;
  const canSeeReport = access.report;
  const canSeeSupplementaryDocuments = access.supplementaryDocuments;
  const canSeeSampling = access.sampling;
  const canSeeCustomer = access.customer;
  const canSeeAnyBusinessNav =
    canSeeRequest ||
    access.sampleManagement ||
    canSeeReception ||
    canSeeHandover ||
    canSeeLab ||
    canSeeTechnicalReview ||
    canSeeApproval ||
    canSeeReport ||
    canSeeSupplementaryDocuments ||
    canSeeSampling ||
    canSeeCustomer;
  const bottomNavVisible: Record<string, boolean> = {
    "/ho-so": canSeeRequest,
    "/tiep-nhan": canSeeReception,
    "/nhap-ket-qua": canSeeLabResultEntry,
    "/phe-duyet": canSeeApproval,
    "/lay-mau": canSeeSampling,
  };
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [pinned, setPinned] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [readIds, setReadIds] = useState<string[]>([]);
  const [userMenu, setUserMenu] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const { prefs, update } = useUserPrefs();
  /* Tên hiển thị lấy từ danh tính thật (`GET /me` → `app_user.full_name`), không lấy từ tuỳ chọn
     lưu trên máy. `dlp.user-prefs` là MỘT khoá localStorage dùng chung cho cả trình duyệt, không
     tách theo tài khoản - để nó thắng thì hai vai đăng nhập lần lượt trên cùng máy đều hiện tên
     của người đăng nhập trước, và người vận hành không biết mình đang ở vai nào. Bản minh hoạ
     không có `/me` nên vẫn dùng tuỳ chọn. */
  const displayName = (usesClerk ? user?.name : prefs.name || user?.name) ?? "";
  const togglePin = () => setPinned((v) => !v);
  // Chế độ thật hỏi máy chủ; bản minh hoạ vẫn đếm trên dữ liệu dựng sẵn của nó.
  const remoteUnread = useUnreadNotificationCount();
  const unread = usesClerk
    ? (remoteUnread.data?.unread ?? 0)
    : NOTIF_ITEMS.filter((n) => n.unread && !readIds.includes(n.id)).length;

  const { unreadCount: supportUnread } = useSupportStore();
  const onSupport = pathname.startsWith("/ho-tro");
  const onRelease = pathname.startsWith("/phien-ban");
  const onSettings = pathname.startsWith("/admin");

  return (
    <div className="open-lims">
      <div className={pinned ? "dlp-rail dlp-rail--pinned" : "dlp-rail"}>
        <div className="dlp-scrim" onClick={togglePin} />
        <div className="dlp-rail__inner">
          <nav className="dlp-nav" aria-label="Điều hướng chính">
            <div className="dlp-nav__app">
              <AppLogo size={28} />
              <span className="dlp-appmark--short">DLP</span>
              <span className="dlp-appmark--full">DLP LIMS</span>
            </div>

            {canSeeAnyBusinessNav ? (
              <>
                <div className="dlp-nav__section">Nghiệp vụ</div>
                {canSeeRequest ? (
                  <Link
                    to="/ho-so"
                    className="dlp-nav__item"
                    data-selected={pathname.startsWith("/ho-so")}
                    onClick={() => setPinned(false)}
                  >
                    <span className="dlp-nav__icon">
                      {pathname.startsWith("/ho-so") ? (
                        <FolderOpenVertical20Filled />
                      ) : (
                        <FolderOpenVertical20Regular />
                      )}
                    </span>
                    <span>Hồ sơ kiểm nghiệm</span>
                  </Link>
                ) : null}
                {access.sampleManagement ? (
                  <Link
                    to="/quan-ly-mau"
                    className="dlp-nav__item"
                    data-selected={pathname.startsWith("/quan-ly-mau")}
                    onClick={() => setPinned(false)}
                  >
                    <span className="dlp-nav__icon">
                      {pathname.startsWith("/quan-ly-mau") ? (
                        <Beaker20Filled />
                      ) : (
                        <Beaker20Regular />
                      )}
                    </span>
                    <span>Quản lý mẫu</span>
                  </Link>
                ) : null}
                {canSeeReception ? (
                  <Link
                    to="/tiep-nhan"
                    className="dlp-nav__item"
                    data-selected={pathname.startsWith("/tiep-nhan")}
                    onClick={() => setPinned(false)}
                  >
                    <span className="dlp-nav__icon">
                      {pathname.startsWith("/tiep-nhan") ? (
                        <BoxCheckmark20Filled />
                      ) : (
                        <BoxCheckmark20Regular />
                      )}
                    </span>
                    <span>Tiếp nhận mẫu</span>
                  </Link>
                ) : null}
                {canSeeHandover ? (
                  <Link
                    to="/ban-giao"
                    className="dlp-nav__item"
                    data-selected={pathname.startsWith("/ban-giao")}
                    onClick={() => setPinned(false)}
                  >
                    <span className="dlp-nav__icon">
                      <ArrowSwap20Regular />
                    </span>
                    <span>Bàn giao vào lab</span>
                  </Link>
                ) : null}
                {canSeeLab ? (
                  <Link
                    to="/cong-viec"
                    className="dlp-nav__item"
                    data-selected={pathname.startsWith("/cong-viec")}
                    onClick={() => setPinned(false)}
                  >
                    <span className="dlp-nav__icon">
                      <BeakerEdit20Regular />
                    </span>
                    <span>Bảng công việc lab</span>
                  </Link>
                ) : null}
                {canSeeLabResultEntry ? (
                  <Link
                    to="/nhap-ket-qua"
                    search={{ code: undefined }}
                    className="dlp-nav__item"
                    data-selected={pathname.startsWith("/nhap-ket-qua")}
                    onClick={() => setPinned(false)}
                  >
                    <span className="dlp-nav__icon">
                      <ClipboardTextEdit20Regular />
                    </span>
                    <span>Nhập kết quả</span>
                  </Link>
                ) : null}

                {canSeeTechnicalReview ? (
                  <Link
                    to="/kiem-tra-ky-thuat"
                    className="dlp-nav__item"
                    data-selected={pathname.startsWith("/kiem-tra-ky-thuat")}
                    onClick={() => setPinned(false)}
                  >
                    <span className="dlp-nav__icon">
                      <Glasses20Regular />
                    </span>
                    <span>Kiểm tra kỹ thuật</span>
                  </Link>
                ) : null}

                {canSeeApproval ? (
                  <Link
                    to="/phe-duyet"
                    className="dlp-nav__item"
                    data-selected={pathname.startsWith("/phe-duyet")}
                    onClick={() => setPinned(false)}
                  >
                    <span className="dlp-nav__icon">
                      <ClipboardArrowRight20Regular />
                    </span>
                    <span>Phê duyệt phiếu</span>
                  </Link>
                ) : null}

                {canSeeReport ? (
                  <Link
                    to="/tra-ket-qua"
                    className="dlp-nav__item"
                    data-selected={pathname.startsWith("/tra-ket-qua")}
                    onClick={() => setPinned(false)}
                  >
                    <span className="dlp-nav__icon">
                      <MailArrowUp20Regular />
                    </span>
                    <span>Trả kết quả</span>
                  </Link>
                ) : null}

                {canSeeSupplementaryDocuments ? (
                  <Link
                    to="/tai-lieu-bo-sung"
                    className="dlp-nav__item"
                    data-selected={pathname.startsWith("/tai-lieu-bo-sung")}
                    onClick={() => setPinned(false)}
                  >
                    <span className="dlp-nav__icon">
                      <DocumentEdit20Regular />
                    </span>
                    <span>Tài liệu bổ sung</span>
                  </Link>
                ) : null}

                {canSeeRequestEdit ? (
                  <Link
                    to="/sua-ho-so"
                    className="dlp-nav__item"
                    data-selected={pathname.startsWith("/sua-ho-so")}
                    onClick={() => setPinned(false)}
                  >
                    <span className="dlp-nav__icon">
                      <DocumentEdit20Regular />
                    </span>
                    <span>Sửa hồ sơ</span>
                  </Link>
                ) : null}

                {canSeeSampling ? (
                  <Link
                    to="/lay-mau"
                    className="dlp-nav__item"
                    data-selected={pathname.startsWith("/lay-mau")}
                    onClick={() => setPinned(false)}
                  >
                    <span className="dlp-nav__icon">
                      <Phone20Regular />
                    </span>
                    <span>Lấy mẫu hiện trường</span>
                  </Link>
                ) : null}

                {canSeeCustomer ? (
                  <Link
                    to="/khach-hang"
                    className="dlp-nav__item"
                    data-selected={pathname.startsWith("/khach-hang")}
                    onClick={() => setPinned(false)}
                  >
                    <span className="dlp-nav__icon">
                      <BuildingPeople20Regular />
                    </span>
                    <span>Khách hàng & công nợ</span>
                  </Link>
                ) : null}
              </>
            ) : null}

            <div style={{ flex: 1 }} />

            <Link
              to="/ho-tro"
              className="dlp-nav__item dlp-nav__item--small"
              data-selected={onSupport}
              onClick={() => setPinned(false)}
            >
              <span className="dlp-nav__icon">
                {onSupport ? <QuestionCircle20Filled /> : <QuestionCircle20Regular />}
              </span>
              <span>Hỗ trợ người dùng</span>
              {supportUnread > 0 ? <span className="dlp-nav__badge">{supportUnread}</span> : null}
            </Link>

            <Link
              to="/phien-ban"
              className="dlp-nav__item dlp-nav__item--small"
              data-selected={onRelease}
              onClick={() => setPinned(false)}
              title="Ghi chú phiên bản"
            >
              <span className="dlp-nav__icon">
                {onRelease ? <Rocket20Filled /> : <Rocket20Regular />}
              </span>
              <span>Ghi chú phiên bản</span>
            </Link>

            {can("admin.view") ? (
              <Link
                to="/admin"
                className="dlp-nav__item dlp-nav__item--small"
                data-selected={onSettings}
                onClick={() => setPinned(false)}
              >
                <span className="dlp-nav__icon">
                  {onSettings ? <Settings20Filled /> : <Settings20Regular />}
                </span>
                <span>Cài đặt hệ thống</span>
              </Link>
            ) : null}

            <button
              type="button"
              className="dlp-nav__item dlp-nav__item--small"
              onClick={togglePin}
              style={{ background: "transparent", border: 0, width: "100%" }}
            >
              <span className="dlp-nav__icon">{pinned ? <Pin20Filled /> : <Pin20Regular />}</span>
              <span>{pinned ? "Thu gọn menu" : "Ghim menu mở rộng"}</span>
            </button>
          </nav>
        </div>
      </div>

      <div className="dlp-body">
        <header className="dlp-head">
          <span className="dlp-burger">
            <Button
              appearance="subtle"
              icon={<Navigation20Regular />}
              aria-label="Mở menu"
              onClick={togglePin}
            />
          </span>
          <GlobalSearch />
          <div className="dlp-branch">
            <span>Chi nhánh</span>
            <Badge appearance="tint" color="subtle" size="small">
              {user?.branch ?? "-"}
            </Badge>
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ position: "relative" }}>
            <Button
              appearance="subtle"
              icon={<Alert20Regular />}
              aria-label="Thông báo"
              className="dlp-notif-trigger"
              onClick={() => {
                setNotifOpen(true);
                // Bản minh hoạ coi việc mở chuông là đã đọc hết. Chế độ thật KHÔNG làm vậy: mở
                // ra để nhìn không phải là đã xử lý, và người dùng tự đánh dấu trong ngăn kéo.
                if (!usesClerk) setReadIds(NOTIF_ITEMS.map((n) => n.id));
              }}
            />
            {unread > 0 ? (
              <span className="dlp-notif-badge">
                <CounterBadge count={unread} size="small" color="danger" />
              </span>
            ) : null}
          </div>
          <NotificationDrawer
            open={notifOpen}
            onClose={() => setNotifOpen(false)}
            readIds={readIds}
          />

          <div style={{ position: "relative" }}>
            <button
              type="button"
              className="dlp-persona"
              onClick={() => setUserMenu((v) => !v)}
              aria-label="Menu người dùng"
            >
              <Avatar
                size={32}
                name={displayName}
                initials={user?.initials ?? ""}
                color="colorful"
                badge={{ status: "available" }}
              />
              <span className="dlp-persona__text">
                <span className="dlp-persona__primary">{displayName}</span>
                <span className="dlp-persona__secondary">{user?.role}</span>
              </span>
            </button>

            <PopoverMenu
              open={userMenu}
              onClose={() => setUserMenu(false)}
              align="right"
              width={270}
              label="Menu người dùng"
            >
              <div className="dlp-usermenu__head">
                <div className="dlp-usermenu__name">{displayName}</div>
                <div className="dlp-usermenu__role">{user?.role}</div>
              </div>

              <button
                type="button"
                className="dlp-usermenu__item"
                onClick={() => {
                  setUserMenu(false);
                  setProfileOpen(true);
                }}
              >
                <Person20Regular />
                <span style={{ flex: 1 }}>Hồ sơ cá nhân</span>
              </button>

              <button type="button" className="dlp-usermenu__item">
                <TaskListSquareLtr20Regular />
                <span style={{ flex: 1 }}>Tác vụ của tôi</span>
                <Badge appearance="tint" color="brand" size="small">
                  2
                </Badge>
              </button>

              <button type="button" className="dlp-usermenu__item" onClick={() => void signOut()}>
                <SignOut20Regular />
                <span style={{ flex: 1 }}>Đăng xuất</span>
              </button>

              <div className="dlp-usermenu__row dlp-usermenu__row--divided">
                <span style={{ flex: 1 }}>Ngôn ngữ</span>
                <div className="dlp-chiprow">
                  {(["vi", "en"] as const).map((lg) => (
                    <InteractionTag
                      key={lg}
                      appearance="outline"
                      className={prefs.lang === lg ? "dlp-chip--picked" : "dlp-chip--unpicked"}
                      size="small"
                    >
                      <InteractionTagPrimary
                        aria-pressed={prefs.lang === lg}
                        onClick={() => update({ lang: lg })}
                      >
                        {prefs.lang === lg ? "✓ " : ""}
                        {lg.toUpperCase()}
                      </InteractionTagPrimary>
                    </InteractionTag>
                  ))}
                </div>
              </div>

              <div className="dlp-usermenu__row">
                <span style={{ flex: 1 }}>Giao diện tối</span>
                <Switch
                  checked={prefs.theme === "dark"}
                  onChange={(_, d) => update({ theme: d.checked ? "dark" : "light" })}
                />
              </div>
            </PopoverMenu>
          </div>

          <ProfileDialog open={profileOpen} onOpenChange={setProfileOpen} />
        </header>

        <main className="dlp-main">{children}</main>

        {canSeeAnyBusinessNav ? (
          <nav className="dlp-bottomnav" aria-label="Điều hướng nhanh">
            {BOTTOM_NAV.filter((item) => bottomNavVisible[item.to]).map((item) => {
              const selected = pathname.startsWith(item.to);
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className="dlp-bottomnav__item"
                  data-selected={selected}
                  aria-label={item.label}
                  onClick={() => setPinned(false)}
                >
                  <span className="dlp-bottomnav__icon">
                    {item.icon}
                    {!usesClerk && item.badge ? (
                      <span className="dlp-bottomnav__badge">
                        <CounterBadge count={item.badge} size="small" color="danger" />
                      </span>
                    ) : null}
                  </span>
                  <span className="dlp-bottomnav__label">{item.label}</span>
                </Link>
              );
            })}
          </nav>
        ) : null}

        {/* Nút nổi trợ giúp: đặt ở AppShell để có mặt trên mọi màn nghiệp vụ (nó tự ẩn trong
            khu /ho-tro). Truyền cờ bottom nav để trên điện thoại nút không nằm đè thanh tab. */}
        <SupportFab aboveBottomNav={canSeeAnyBusinessNav} />
      </div>
    </div>
  );
}
