import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerHeaderTitle,
  InteractionTag,
  InteractionTagPrimary,
  ProgressBar,
} from "@fluentui/react-components";
import { Dismiss20Regular } from "@fluentui/react-icons";
import { useNavigate } from "@tanstack/react-router";
import { NOTIF_ITEMS, NOTIF_TABS, type NotifCat, type NotifItem } from "@/lib/admin/notif-data";
import {
  useMarkNotificationRead,
  useNotifications,
  type AppNotification,
} from "@/features/notification";
import { formatDateTime } from "@/lib/format";
import { apiErrorMessage } from "@/lib/api";
import { toneToColor } from "@/lib/admin/tone";
import { useAuth } from "@/lib/auth/AuthProvider";

/** Quy thông báo của máy chủ về đúng hình dạng mà ngăn kéo này vốn vẽ, để hai chế độ dùng chung
 *  một khối hiển thị.
 *
 *  Máy chủ không có `pct` (chưa có tác vụ nền nào báo tiến độ) và không có nút hành động dựng
 *  sẵn -- chỗ để đi tới suy từ `targetType`/`targetId`, và chỉ suy khi biết chắc. */
function toDrawerItem(notification: AppNotification): NotifItem {
  const to =
    notification.targetType === "test_request" && notification.targetId
      ? "/ho-so"
      : notification.targetType === "sampling_assignment"
        ? "/lay-mau"
        : undefined;
  return {
    id: notification.id,
    cat: (notification.category ?? "system") as NotifCat,
    unread: notification.unread,
    tone: notification.category === "alert" ? "warning" : "info",
    state: notification.unread ? "Mới" : "Đã đọc",
    time: formatDateTime(notification.occurredAt),
    title: notification.title,
    sub: notification.body ?? "",
    actions: to ? [{ label: "Mở", to }] : [],
  };
}

/* Trung tâm thông báo - Drawer phải 420px theo mockup. */
export function NotificationDrawer({
  open,
  onClose,
  readIds,
}: {
  open: boolean;
  onClose: () => void;
  readIds: string[];
}) {
  const [tab, setTab] = useState<(typeof NOTIF_TABS)[number]["key"]>("all");
  const navigate = useNavigate();
  const { usesClerk } = useAuth();

  // Máy chủ lọc theo nhóm; "chưa đọc" và "tất cả" thì không phải nhóm nên không gửi lên.
  const serverCategory = tab === "job" || tab === "alert" || tab === "system" ? tab : undefined;
  const remote = useNotifications(serverCategory, open);
  const markRead = useMarkNotificationRead();

  const items = useMemo(
    () =>
      usesClerk
        ? (remote.data?.pages.flatMap((page) => page.items) ?? []).map(toDrawerItem)
        : NOTIF_ITEMS.map((n) => ({ ...n, unread: n.unread && !readIds.includes(n.id) })),
    [readIds, usesClerk, remote.data],
  );

  const shown = items.filter((n) =>
    tab === "all" ? true : tab === "unread" ? n.unread : n.cat === tab,
  );

  const go = (to?: string) => {
    onClose();
    if (to) void navigate({ to });
  };

  return (
    <Drawer type="overlay" position="end" open={open} onOpenChange={onClose} size="medium">
      <DrawerHeader>
        <DrawerHeaderTitle
          action={
            <Button
              appearance="subtle"
              icon={<Dismiss20Regular />}
              aria-label="Đóng"
              onClick={onClose}
            />
          }
        >
          Trung tâm thông báo
        </DrawerHeaderTitle>
      </DrawerHeader>

      <DrawerBody>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="dlp-chiprow">
            {NOTIF_TABS.map((t) => (
              <InteractionTag
                key={t.key}
                size="small"
                appearance="outline"
                className={tab === t.key ? "dlp-chip--picked" : "dlp-chip--unpicked"}
              >
                <InteractionTagPrimary aria-pressed={tab === t.key} onClick={() => setTab(t.key)}>
                  {tab === t.key ? "✓ " : ""}
                  {t.label}
                </InteractionTagPrimary>
              </InteractionTag>
            ))}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {usesClerk && remote.isLoading ? (
              <div className="dlp-notif__sub">Đang tải thông báo...</div>
            ) : null}
            {usesClerk && remote.error ? (
              <div className="dlp-notif__sub">
                {apiErrorMessage(remote.error, "Không đọc được thông báo.")}
              </div>
            ) : null}
            {shown.map((n) => (
              <div
                key={n.id}
                className="dlp-notif"
                data-unread={n.unread}
                onClick={() => {
                  if (usesClerk && n.unread) markRead.mutate(n.id);
                }}
              >
                <div className="dlp-notif__top">
                  <Badge appearance="tint" size="small" color={toneToColor(n.tone)}>
                    {n.state}
                  </Badge>
                  <span style={{ flex: 1 }} />
                  <span className="dlp-notif__time">{n.time}</span>
                </div>
                <div className="dlp-notif__title">{n.title}</div>
                <div className="dlp-notif__sub">{n.sub}</div>
                {typeof n.pct === "number" ? (
                  <ProgressBar value={n.pct} thickness="medium" />
                ) : null}
                {n.actions.length ? (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {n.actions.map((a) => (
                      <Button
                        key={a.label}
                        size="small"
                        appearance={a.appearance === "primary" ? "primary" : "secondary"}
                        onClick={() => go(a.to)}
                      >
                        {a.label}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
            {!shown.length ? (
              <div className="dlp-notif__sub">Không có thông báo trong mục này.</div>
            ) : null}
          </div>
        </div>
      </DrawerBody>

      <DrawerFooter>
        {usesClerk ? (
          <>
            <Button
              appearance="secondary"
              disabled={markRead.isPending}
              onClick={() => markRead.mutate(undefined)}
            >
              Đánh dấu đã đọc hết
            </Button>
            {remote.hasNextPage ? (
              <Button
                disabled={remote.isFetchingNextPage}
                onClick={() => void remote.fetchNextPage()}
              >
                {remote.isFetchingNextPage ? "Đang tải..." : "Tải thêm"}
              </Button>
            ) : null}
          </>
        ) : null}
        <Button onClick={() => go("/ho-so")}>Mở trang Tác vụ của tôi</Button>
      </DrawerFooter>
    </Drawer>
  );
}
