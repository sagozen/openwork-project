/* Kho trạng thái yêu cầu hỗ trợ (mock, lưu localStorage để không mất khi tải lại).
   Không có route backend nào cho hỗ trợ/ticket (rà toàn bộ dlp-system/services, không có
   @Path nào khớp support/ticket/faq) - "Cần backend bổ sung". Vì vậy dữ liệu mẫu SEED_TICKETS
   chỉ dùng ở chế độ demo (PERSONAS); chế độ Clerk khởi động rỗng để không hiện yêu cầu hỗ trợ
   giả là của một tài khoản thật (khớp cách NotificationDrawer/GlobalSearch đã làm cho
   notif-data.ts / search-data.ts). */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "@/lib/auth/AuthProvider";
import {
  SEED_TICKETS,
  nextTicketId,
  type SupportTicket,
  type TicketKind,
  type TicketPriority,
} from "./support-data";

const STORAGE_KEY = "dlp.support.tickets.v1";

export interface NewTicketInput {
  kind: TicketKind;
  title: string;
  screen: string;
  priority: TicketPriority;
  body: string;
  steps?: string;
  benefit?: string;
  attachments: string[];
  context: string;
}

interface SupportStoreValue {
  tickets: SupportTicket[];
  unreadCount: number;
  createTicket: (input: NewTicketInput) => SupportTicket;
  replyTicket: (id: string, body: string) => void;
  setState: (id: string, state: SupportTicket["state"]) => void;
  markRead: (id: string) => void;
}

const SupportStoreContext = createContext<SupportStoreValue | null>(null);

function nowLabel() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function SupportStoreProvider({ children }: { children: ReactNode }) {
  const { usesClerk } = useAuth();
  // Khoá lưu trữ tách theo chế độ để yêu cầu tạo ở Clerk không lẫn với dữ liệu mẫu demo
  // (và ngược lại) khi cùng một trình duyệt đổi qua lại giữa hai chế độ.
  const storageKey = usesClerk ? "dlp.support.tickets.clerk.v1" : STORAGE_KEY;
  const [tickets, setTickets] = useState<SupportTicket[]>(usesClerk ? [] : SEED_TICKETS);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) setTickets(JSON.parse(raw) as SupportTicket[]);
      else setTickets(usesClerk ? [] : SEED_TICKETS);
    } catch {
      /* bỏ qua dữ liệu hỏng */
    }
  }, [storageKey, usesClerk]);

  const persist = useCallback(
    (next: SupportTicket[]) => {
      setTickets(next);
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* bộ nhớ đầy hoặc bị chặn */
      }
    },
    [storageKey],
  );

  const createTicket = useCallback(
    (input: NewTicketInput) => {
      const time = nowLabel();
      const detail = [
        input.body,
        input.steps ? `\n\nCác bước tái hiện:\n${input.steps}` : "",
        input.benefit ? `\n\nLợi ích mong đợi:\n${input.benefit}` : "",
        input.attachments.length ? `\n\nĐính kèm: ${input.attachments.join(", ")}` : "",
        `\n\nNgữ cảnh tự đính kèm: ${input.context}`,
      ].join("");

      const ticket: SupportTicket = {
        id: nextTicketId(tickets),
        kind: input.kind,
        title: input.title,
        summary: input.body.slice(0, 120),
        state: "new",
        priority: input.priority,
        screen: input.screen,
        createdAt: time,
        updatedAt: time,
        sla: "Phản hồi trong 4 giờ làm việc",
        unread: false,
        messages: [
          {
            id: `m-${Date.now()}`,
            author: "Bạn",
            role: "Người gửi",
            side: "user",
            time,
            body: detail,
          },
        ],
      };
      persist([ticket, ...tickets]);
      return ticket;
    },
    [persist, tickets],
  );

  const replyTicket = useCallback(
    (id: string, body: string) => {
      const time = nowLabel();
      persist(
        tickets.map((t) =>
          t.id === id
            ? {
                ...t,
                updatedAt: time,
                state: t.state === "waiting" ? "processing" : t.state,
                messages: [
                  ...t.messages,
                  {
                    id: `m-${Date.now()}`,
                    author: "Bạn",
                    role: "Người gửi",
                    side: "user" as const,
                    time,
                    body,
                  },
                ],
              }
            : t,
        ),
      );
    },
    [persist, tickets],
  );

  const setState = useCallback(
    (id: string, state: SupportTicket["state"]) => {
      persist(tickets.map((t) => (t.id === id ? { ...t, state, updatedAt: nowLabel() } : t)));
    },
    [persist, tickets],
  );

  const markRead = useCallback(
    (id: string) => {
      if (!tickets.some((t) => t.id === id && t.unread)) return;
      persist(tickets.map((t) => (t.id === id ? { ...t, unread: false } : t)));
    },
    [persist, tickets],
  );

  const value = useMemo<SupportStoreValue>(
    () => ({
      tickets,
      unreadCount: tickets.filter((t) => t.unread).length,
      createTicket,
      replyTicket,
      setState,
      markRead,
    }),
    [tickets, createTicket, replyTicket, setState, markRead],
  );

  return <SupportStoreContext.Provider value={value}>{children}</SupportStoreContext.Provider>;
}

export function useSupportStore(): SupportStoreValue {
  const ctx = useContext(SupportStoreContext);
  if (!ctx) {
    throw new Error("useSupportStore phải nằm trong SupportStoreProvider");
  }
  return ctx;
}
