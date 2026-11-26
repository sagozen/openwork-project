/* Nút nổi "Trợ giúp": tra cứu nhanh FAQ / tài liệu và gửi yêu cầu hỗ trợ ngay tại màn đang
   làm, không phải rời trang sang /ho-tro rồi mất ngữ cảnh nhập liệu. Câu trả lời FAQ mở ngay
   trong bảng - đó là phần "nhanh" của tính năng; các liên kết còn lại dẫn về trung tâm hỗ trợ
   khi người dùng cần xem đầy đủ. */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Button, CounterBadge, Input } from "@fluentui/react-components";
import {
  BookQuestionMark20Regular,
  BugRegular,
  Call20Regular,
  ChevronDown20Regular,
  Dismiss20Regular,
  DocumentPdf20Regular,
  QuestionCircle24Filled,
  Search20Regular,
  TaskListSquareLtr20Regular,
} from "@fluentui/react-icons";
import { BUG_CR_LOG_URL, FAQ_ITEMS, SUPPORT_DOCS } from "@/lib/support/support-data";
import { useSupportStore } from "@/lib/support/support-store";
import { NewTicketDialog } from "@/components/lims/support/NewTicketDialog";
import type { TicketKind } from "@/lib/support/support-data";

/* Số dòng tối đa mỗi nhóm trong bảng nhanh - đủ để chọn, không biến bảng thành trang tìm kiếm. */
const MAX_FAQ = 4;
const MAX_DOC = 3;
const MAX_TICKET = 3;

const HINT_CHIPS = ["in tem mẫu", "thu hồi phiếu", "quên mật khẩu", "nhập kết quả từ Excel"];

export function SupportFab({ aboveBottomNav = false }: { aboveBottomNav?: boolean }) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { tickets, unreadCount } = useSupportStore();
  const wrapRef = useRef<HTMLDivElement>(null);

  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [openFaq, setOpenFaq] = useState<string | null>(null);
  const [dialog, setDialog] = useState<TicketKind | null>(null);

  const key = q.trim().toLowerCase();

  const faqs = useMemo(() => {
    if (!key) return FAQ_ITEMS.slice(0, MAX_FAQ);
    return FAQ_ITEMS.filter(
      (f) => f.q.toLowerCase().includes(key) || f.a.toLowerCase().includes(key),
    ).slice(0, MAX_FAQ);
  }, [key]);

  const docs = useMemo(() => {
    if (!key) return [];
    return SUPPORT_DOCS.filter(
      (d) => d.title.toLowerCase().includes(key) || d.desc.toLowerCase().includes(key),
    ).slice(0, MAX_DOC);
  }, [key]);

  const foundTickets = useMemo(() => {
    if (!key) return [];
    return tickets
      .filter((t) => t.id.toLowerCase().includes(key) || t.title.toLowerCase().includes(key))
      .slice(0, MAX_TICKET);
  }, [key, tickets]);

  // Bấm ra ngoài hoặc Esc thì đóng. Không đóng khi hộp thoại gửi yêu cầu đang mở: hộp thoại
  // render ngoài cây DOM của bảng nên mọi cú bấm trong đó sẽ bị tính là "bấm ra ngoài".
  useEffect(() => {
    if (!open || dialog !== null) return;
    const onDown = (e: MouseEvent) => {
      const el = wrapRef.current;
      if (el && !el.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, dialog]);

  const close = () => {
    setOpen(false);
    setQ("");
    setOpenFaq(null);
  };

  const go = (to: "/ho-tro/faq" | "/ho-tro/tai-lieu" | "/ho-tro/yeu-cau") => {
    close();
    void navigate({ to });
  };

  // Trong trung tâm hỗ trợ đã có sẵn ô tìm kiếm và mọi lối tắt này, thêm nút nổi chỉ che nội dung.
  if (pathname.startsWith("/ho-tro")) return null;

  const noResult = key !== "" && faqs.length + docs.length + foundTickets.length === 0;

  return (
    <div
      ref={wrapRef}
      className={aboveBottomNav ? "dlp-supfab dlp-supfab--abovenav" : "dlp-supfab"}
    >
      {open ? (
        <div className="dlp-supfab__panel" role="dialog" aria-label="Trợ giúp nhanh">
          <div className="dlp-supfab__head">
            <div className="dlp-supfab__heading">
              <span className="dlp-supfab__title">Trợ giúp nhanh</span>
            </div>
            <Button
              appearance="subtle"
              size="small"
              icon={<Dismiss20Regular />}
              aria-label="Đóng bảng trợ giúp"
              onClick={close}
            />
          </div>

          <div className="dlp-supfab__search">
            <Input
              autoFocus
              value={q}
              onChange={(_, d) => {
                setQ(d.value);
                setOpenFaq(null);
              }}
              placeholder="Tìm câu hỏi, tài liệu hoặc mã yêu cầu…"
              contentBefore={<Search20Regular />}
              appearance="filled-lighter"
              style={{ width: "100%" }}
              aria-label="Tìm nhanh trong trợ giúp"
            />
            {!key ? (
              <div className="dlp-supfab__chips">
                {HINT_CHIPS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className="dlp-supfab__chip"
                    onClick={() => setQ(c)}
                  >
                    {c}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="dlp-supfab__body">
            {faqs.length > 0 ? (
              <>
                <div className="dlp-supfab__group">
                  {key ? "Câu hỏi phù hợp" : "Câu hỏi hay xem"}
                </div>
                {faqs.map((f) => {
                  const expanded = openFaq === f.id;
                  return (
                    <div key={f.id} className="dlp-supfab__faq">
                      <button
                        type="button"
                        className="dlp-supfab__row"
                        aria-expanded={expanded}
                        onClick={() => setOpenFaq(expanded ? null : f.id)}
                      >
                        <span className="dlp-supfab__row-text">
                          <span className="dlp-supfab__row-title">{f.q}</span>
                          <span className="dlp-supfab__row-meta">{f.cat}</span>
                        </span>
                        <span
                          className={
                            expanded
                              ? "dlp-supfab__caret dlp-supfab__caret--open"
                              : "dlp-supfab__caret"
                          }
                          aria-hidden="true"
                        >
                          <ChevronDown20Regular />
                        </span>
                      </button>
                      {expanded ? <div className="dlp-supfab__answer">{f.a}</div> : null}
                    </div>
                  );
                })}
              </>
            ) : null}

            {docs.length > 0 ? (
              <>
                <div className="dlp-supfab__group">Tài liệu</div>
                {docs.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    className="dlp-supfab__row"
                    onClick={() => go("/ho-tro/tai-lieu")}
                  >
                    <span className="dlp-supfab__row-text">
                      <span className="dlp-supfab__row-title">{d.title}</span>
                      <span className="dlp-supfab__row-meta">
                        {d.version} · cập nhật {d.updated}
                      </span>
                    </span>
                  </button>
                ))}
              </>
            ) : null}

            {foundTickets.length > 0 ? (
              <>
                <div className="dlp-supfab__group">Yêu cầu của tôi</div>
                {foundTickets.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className="dlp-supfab__row"
                    onClick={() => {
                      close();
                      void navigate({ to: "/ho-tro/yeu-cau/$id", params: { id: t.id } });
                    }}
                  >
                    <span className="dlp-supfab__row-text">
                      <span className="dlp-supfab__row-title">
                        {t.id} · {t.title}
                      </span>
                      <span className="dlp-supfab__row-meta">cập nhật {t.updatedAt}</span>
                    </span>
                  </button>
                ))}
              </>
            ) : null}

            {noResult ? (
              <div className="dlp-supfab__empty">
                Không có kết quả cho “{q}”. Gửi yêu cầu hỗ trợ để đội hỗ trợ xử lý giúp bạn.
              </div>
            ) : null}
          </div>

          <div className="dlp-supfab__foot">
            <a
              href={BUG_CR_LOG_URL}
              className="dlp-supfab__bug-cr-link"
              target="_blank"
              rel="noreferrer"
            >
              <BugRegular fontSize={18} />
              <span>
                <strong>Log BUG/CR</strong>
                <small>Ghi nhận lỗi hoặc yêu cầu thay đổi</small>
              </span>
            </a>

            <div className="dlp-supfab__actions">
              <Button appearance="primary" size="small" onClick={() => setDialog("help")}>
                Gửi yêu cầu hỗ trợ
              </Button>
              <Button
                appearance="secondary"
                size="small"
                icon={<BugRegular fontSize={16} />}
                onClick={() => setDialog("bug")}
              >
                Báo lỗi
              </Button>
            </div>

            <div className="dlp-supfab__links">
              <button type="button" className="dlp-supfab__link" onClick={() => go("/ho-tro/faq")}>
                <BookQuestionMark20Regular />
                <span>Tất cả FAQ</span>
              </button>
              <button
                type="button"
                className="dlp-supfab__link"
                onClick={() => go("/ho-tro/tai-lieu")}
              >
                <DocumentPdf20Regular />
                <span>Tài liệu</span>
              </button>
              <button
                type="button"
                className="dlp-supfab__link"
                onClick={() => go("/ho-tro/yeu-cau")}
              >
                <TaskListSquareLtr20Regular />
                <span>Yêu cầu ({tickets.length})</span>
              </button>
            </div>

            <div className="dlp-supfab__contact">
              <a
                href="tel:+84862652435"
                className="dlp-supfab__hotline"
                aria-label="Gọi nóng gấp 086.265.2435"
              >
                <Call20Regular />
                <span className="dlp-supfab__hotline-copy">
                  <span>Nóng gấp</span>
                  <strong>086.265.2435</strong>
                </span>
                <span className="dlp-supfab__hotline-badge">24/7</span>
              </a>
              <span className="dlp-supfab__contact-dev">Ban Nguyễn (pandev00)</span>
            </div>
          </div>
        </div>
      ) : null}

      <button
        type="button"
        className="dlp-supfab__btn"
        aria-expanded={open}
        aria-label={open ? "Đóng trợ giúp nhanh" : "Mở trợ giúp nhanh"}
        title="Trợ giúp nhanh"
        onClick={() => (open ? close() : setOpen(true))}
      >
        {open ? <Dismiss20Regular /> : <QuestionCircle24Filled />}
        {!open && unreadCount > 0 ? (
          <span className="dlp-supfab__badge">
            <CounterBadge count={unreadCount} size="small" color="danger" />
          </span>
        ) : null}
      </button>

      <NewTicketDialog
        open={dialog !== null}
        defaultKind={dialog ?? "help"}
        onOpenChange={(o) => {
          setDialog(o ? dialog : null);
          if (!o) close();
        }}
        onCreated={(id) => void navigate({ to: "/ho-tro/yeu-cau/$id", params: { id } })}
      />
    </div>
  );
}
