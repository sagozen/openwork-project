import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Avatar, Button, Textarea } from "@fluentui/react-components";
import { NoAccess } from "@/components/lims/NoAccess";
import { PageHead, PermissionButton, useDlpToast } from "@/components/lims/common";
import { useAuth } from "@/lib/auth/AuthProvider";
import { useSupportStore } from "@/lib/support/support-store";
import {
  TICKET_KIND_TEXT,
  TICKET_PRIORITY_TEXT,
  TICKET_STATE_TEXT,
} from "@/lib/support/support-data";
import { StatusPill, SupportShell } from "@/components/lims/support/SupportUI";

export const Route = createFileRoute("/_app/ho-tro/yeu-cau/$id")({
  head: () => ({
    meta: [
      { title: "Chi tiết yêu cầu hỗ trợ - DLP LIMS" },
      {
        name: "description",
        content:
          "Luồng trao đổi giữa người dùng và đội hỗ trợ DLP LIMS, kèm trạng thái, mức ưu tiên và SLA dự kiến.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: TicketDetailScreen,
});

function TicketDetailScreen() {
  const { can } = useAuth();
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const toast = useDlpToast();
  const { tickets, replyTicket, setState, markRead } = useSupportStore();
  const [reply, setReply] = useState("");

  const ticket = tickets.find((t) => t.id === id);

  useEffect(() => {
    if (ticket?.unread) markRead(ticket.id);
  }, [ticket, markRead]);

  if (!can("support.view")) return <NoAccess screen="Chi tiết yêu cầu hỗ trợ" />;

  if (!ticket) {
    return (
      <SupportShell>
        <div className="dlp-sup__panel dlp-sup__panel-body--pad">
          Không tìm thấy yêu cầu {id}.{" "}
          <Button appearance="transparent" onClick={() => void navigate({ to: "/ho-tro/yeu-cau" })}>
            Về danh sách yêu cầu
          </Button>
        </div>
      </SupportShell>
    );
  }

  const stateText = TICKET_STATE_TEXT[ticket.state];
  const closed = ticket.state === "closed";

  const send = () => {
    if (!reply.trim()) return;
    replyTicket(ticket.id, reply.trim());
    setReply("");
    toast("Đã gửi phản hồi", `${ticket.id} · đội hỗ trợ sẽ nhận được ngay.`);
  };

  return (
    <SupportShell>
      <PageHead
        crumbs={[
          { label: "Hỗ trợ người dùng", to: "/ho-tro" },
          { label: "Yêu cầu của tôi", to: "/ho-tro/yeu-cau" },
          { label: ticket.id },
        ]}
        title={ticket.title}
        description={`${ticket.id} · ${TICKET_KIND_TEXT[ticket.kind]} · gửi ngày ${ticket.createdAt}`}
        actions={<StatusPill tone={stateText.tone} label={stateText.label} />}
      />

      <div className="dlp-sup__detail">
        <div className="dlp-sup__panel">
          <div className="dlp-sup__thread">
            {ticket.messages.map((m) => (
              <div
                key={m.id}
                className={m.side === "user" ? "dlp-sup__msg dlp-sup__msg--user" : "dlp-sup__msg"}
              >
                <Avatar name={m.author} size={32} color="colorful" />
                <div style={{ minWidth: 0 }}>
                  <div className="dlp-sup__msg-meta">
                    {m.author} · {m.role} · {m.time}
                  </div>
                  <div className="dlp-sup__bubble">{m.body}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="dlp-sup__reply">
            <Textarea
              value={reply}
              onChange={(_, d) => setReply(d.value)}
              rows={3}
              resize="vertical"
              placeholder={
                closed ? "Yêu cầu đã đóng - mở lại để tiếp tục trao đổi." : "Nhập phản hồi của bạn…"
              }
              disabled={closed}
            />
            <div className="dlp-sup__reply-actions">
              <div style={{ display: "flex", gap: 8 }}>
                {closed ? (
                  <Button
                    appearance="secondary"
                    onClick={() => {
                      setState(ticket.id, "processing");
                      toast("Đã mở lại yêu cầu", ticket.id, "info");
                    }}
                  >
                    Mở lại yêu cầu
                  </Button>
                ) : (
                  <Button
                    appearance="secondary"
                    onClick={() => {
                      setState(ticket.id, "closed");
                      toast("Đã đóng yêu cầu", ticket.id, "info");
                    }}
                  >
                    Đóng yêu cầu
                  </Button>
                )}
                <PermissionButton
                  allowed={can("support.manage")}
                  appearance="secondary"
                  deniedReason="Chỉ quản trị hỗ trợ mới đánh dấu đã giải quyết."
                  onClick={() => {
                    setState(ticket.id, "resolved");
                    toast("Đã đánh dấu đã giải quyết", ticket.id);
                  }}
                >
                  Đánh dấu đã giải quyết
                </PermissionButton>
              </div>
              <Button appearance="primary" onClick={send} disabled={closed || !reply.trim()}>
                Gửi phản hồi
              </Button>
            </div>
          </div>
        </div>

        <aside className="dlp-sup__panel">
          <div className="dlp-sup__panel-head">
            <span className="dlp-sup__panel-title">Thuộc tính</span>
          </div>
          <div className="dlp-sup__props">
            <div>
              <div className="dlp-sup__prop-label">Mã yêu cầu</div>
              <div className="dlp-sup__prop-value">{ticket.id}</div>
            </div>
            <div>
              <div className="dlp-sup__prop-label">Loại</div>
              <div className="dlp-sup__prop-value">{TICKET_KIND_TEXT[ticket.kind]}</div>
            </div>
            <div>
              <div className="dlp-sup__prop-label">Trạng thái</div>
              <div style={{ marginTop: 4 }}>
                <StatusPill tone={stateText.tone} label={stateText.label} />
              </div>
            </div>
            <div>
              <div className="dlp-sup__prop-label">Mức ưu tiên</div>
              <div className="dlp-sup__prop-value">{TICKET_PRIORITY_TEXT[ticket.priority]}</div>
            </div>
            <div>
              <div className="dlp-sup__prop-label">Màn hình liên quan</div>
              <div className="dlp-sup__prop-value">{ticket.screen}</div>
            </div>
            <div>
              <div className="dlp-sup__prop-label">Cập nhật lần cuối</div>
              <div className="dlp-sup__prop-value">{ticket.updatedAt}</div>
            </div>
            <div>
              <div className="dlp-sup__prop-label">SLA dự kiến</div>
              <div className="dlp-sup__prop-value">{ticket.sla}</div>
            </div>
          </div>
        </aside>
      </div>
    </SupportShell>
  );
}
