// Bàn phím khi giành quyền một máy web (thuần, test độc lập): phím trên màn hình đang giữ và có focus thành WebAction kind keys.
// Chữ gõ gộp lại (gửi sau 150 ms hoặc ngay trước một phím đặc biệt) để không gọi Go mỗi ký tự; thứ tự gửi giữ đúng thứ tự gõ.
import type { WebAction } from './bridge';

interface KeyEventLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
}

/** Phím đặc biệt gửi nguyên tên (tên phím của DOM trùng tên phím Playwright). */
export const SPECIAL_KEYS = new Set(['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);

/** Gửi chữ đang gộp sau ngần này ms kể từ ký tự đầu. */
export const TEXT_FLUSH_MS = 150;
/** Gộp tối đa ngần này ký tự một lệnh (sidecar nhận tối đa 5000). */
const MAX_BATCH = 1000;

/**
 * Phím -> thao tác trên trang, hoặc null khi phím không dành cho trang: máy không phải web, chưa giữ máy, đang gõ bộ gõ
 * (IME), hay phím có ⌘/Ctrl (để cho app, vd ⌘K). Ký tự in được thành text; Enter, Tab, Backspace, mũi tên, Esc... thành key.
 */
export function keyAction(e: KeyEventLike, held: boolean, isWeb: boolean): WebAction | null {
  if (!held || !isWeb || e.isComposing || e.metaKey || e.ctrlKey) return null;
  if (SPECIAL_KEYS.has(e.key)) return { kind: 'keys', key: e.shiftKey && e.key === 'Tab' ? 'Shift+Tab' : e.key };
  if ([...e.key].length === 1) return { kind: 'keys', text: e.key };
  return null;
}

export interface KeyBatcher {
  push: (a: WebAction) => void;
  /** Gửi ngay chữ đang gộp (vd khi màn hình mất focus). */
  flush: () => void;
  /** Bỏ chữ đang gộp chưa gửi (rời màn hình, đã trả máy). */
  cancel: () => void;
}

/** Gộp chữ gõ và gửi tuần tự qua send; lỗi của từng lệnh báo qua onError, không chặn các lệnh sau. */
export function createKeyBatcher(send: (a: WebAction) => Promise<unknown>, onError: (e: unknown) => void, delay = TEXT_FLUSH_MS): KeyBatcher {
  let text = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = (a: WebAction) => {
    chain = chain.then(() => send(a)).catch(onError);
  };
  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const flush = () => {
    stop();
    if (!text) return;
    const t = text;
    text = '';
    enqueue({ kind: 'keys', text: t });
  };
  return {
    push(a) {
      if (a.text !== undefined) {
        text += a.text;
        if (text.length >= MAX_BATCH) flush();
        else timer ??= setTimeout(flush, delay);
        return;
      }
      flush();
      enqueue(a);
    },
    flush,
    cancel() {
      stop();
      text = '';
    },
  };
}
