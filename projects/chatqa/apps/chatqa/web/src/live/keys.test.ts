import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebAction } from './bridge';
import { shortcutFor, WEB_KEYS_ATTR, wheelGesture } from './input';
import { createKeyBatcher, keyAction, TEXT_FLUSH_MS } from './keys';

afterEach(() => {
  vi.useRealTimers();
});

describe('bàn phím trên máy web đang giữ', () => {
  it('ký tự in được thành text, kể cả dấu cách và chữ có dấu', () => {
    for (const key of ['a', 'Z', '1', ' ', 'ế', '@']) expect(keyAction({ key }, true, true)).toEqual({ kind: 'keys', text: key });
  });

  it('Enter, Tab, Backspace, mũi tên, Esc thành key; Shift+Tab giữ Shift', () => {
    for (const key of ['Enter', 'Tab', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Escape', 'Home', 'End']) {
      expect(keyAction({ key }, true, true)).toEqual({ kind: 'keys', key });
    }
    expect(keyAction({ key: 'Tab', shiftKey: true }, true, true)).toEqual({ kind: 'keys', key: 'Shift+Tab' });
  });

  it('Esc khi đang giữ máy web đi vào trang; chưa giữ, hoặc máy điện thoại, thì không gửi gì', () => {
    expect(keyAction({ key: 'Escape' }, true, true)).toEqual({ kind: 'keys', key: 'Escape' });
    expect(keyAction({ key: 'Escape' }, false, true)).toBeNull();
    expect(keyAction({ key: 'a' }, false, true)).toBeNull();
    expect(keyAction({ key: 'a' }, true, false)).toBeNull();
    expect(keyAction({ key: 'Enter' }, true, false)).toBeNull();
  });

  it('phím có ⌘/Ctrl ở lại app (⌘K), phím bộ gõ đang soạn và phím không tên in được thì bỏ qua', () => {
    expect(keyAction({ key: 'k', metaKey: true }, true, true)).toBeNull();
    expect(keyAction({ key: 'a', ctrlKey: true }, true, true)).toBeNull();
    expect(keyAction({ key: 'a', isComposing: true }, true, true)).toBeNull();
    for (const key of ['Shift', 'Control', 'Meta', 'F5', 'CapsLock']) expect(keyAction({ key }, true, true)).toBeNull();
  });

  it('màn hình máy web đang nhận phím: Esc, T, Enter không còn là phím tắt của màn làm việc', () => {
    const webScreen = { tagName: 'CANVAS', closest: (sel: string) => (sel === `[${WEB_KEYS_ATTR}]` ? {} : null) };
    const plain = { tagName: 'CANVAS', closest: () => null };
    for (const key of ['Escape', 't', 'T', 'Enter']) expect(shortcutFor({ key }, webScreen)).toBeNull();
    expect(shortcutFor({ key: 'Escape' }, plain)).toBe('stop');
    expect(shortcutFor({ key: 't' }, plain)).toBe('takeover');
  });
});

describe('gộp chữ gõ', () => {
  const setup = () => {
    vi.useFakeTimers();
    const sent: WebAction[] = [];
    const errors: unknown[] = [];
    const b = createKeyBatcher(
      async (a) => {
        sent.push(a);
      },
      (e) => errors.push(e),
    );
    return { b, sent, errors };
  };

  it('chữ gõ liền nhau thành một lệnh sau 150 ms', async () => {
    const { b, sent } = setup();
    for (const ch of 'abc') b.push({ kind: 'keys', text: ch });
    await vi.advanceTimersByTimeAsync(TEXT_FLUSH_MS - 1);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual([{ kind: 'keys', text: 'abc' }]);
  });

  it('phím đặc biệt gửi chữ đang gộp trước, giữ đúng thứ tự gõ', async () => {
    const { b, sent } = setup();
    b.push({ kind: 'keys', text: 'h' });
    b.push({ kind: 'keys', text: 'i' });
    b.push({ kind: 'keys', key: 'Enter' });
    b.push({ kind: 'keys', text: 'x' });
    await vi.runAllTimersAsync();
    expect(sent).toEqual([
      { kind: 'keys', text: 'hi' },
      { kind: 'keys', key: 'Enter' },
      { kind: 'keys', text: 'x' },
    ]);
  });

  it('flush gửi ngay; cancel bỏ chữ chưa gửi; lỗi một lệnh không chặn lệnh sau', async () => {
    vi.useFakeTimers();
    const sent: WebAction[] = [];
    const errors: unknown[] = [];
    let fail = true;
    const b = createKeyBatcher(
      async (a) => {
        if (fail) {
          fail = false;
          throw new Error('device_not_ready: đã trả máy');
        }
        sent.push(a);
      },
      (e) => errors.push(e),
    );
    b.push({ kind: 'keys', text: 'a' });
    b.flush();
    b.push({ kind: 'keys', key: 'Tab' });
    b.push({ kind: 'keys', text: 'bỏ' });
    b.cancel();
    await vi.runAllTimersAsync();
    expect(errors).toHaveLength(1);
    expect(sent).toEqual([{ kind: 'keys', key: 'Tab' }]);
  });
});

describe('lăn chuột thành cuộn trang', () => {
  it('lăn xuống nửa khung là vuốt lên nửa màn hình quanh tâm', () => {
    const g = wheelGesture(0, 200, { width: 800, height: 400 });
    expect(g).toEqual({ kind: 'swipe', x1: 0.5, y1: 0.75, x2: 0.5, y2: 0.25, durationMs: 100 });
  });

  it('tối đa một màn hình mỗi lệnh, cuộn ngang theo deltaX', () => {
    expect(wheelGesture(0, -5000, { width: 800, height: 400 })).toMatchObject({ y1: 0, y2: 1 });
    expect(wheelGesture(400, 0, { width: 800, height: 400 })).toMatchObject({ x1: 0.75, x2: 0.25, y1: 0.5, y2: 0.5 });
  });
});
