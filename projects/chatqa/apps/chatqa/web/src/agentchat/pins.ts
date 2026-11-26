// Tin ghim của từng phiên chat agent: lưu trên máy này (localStorage) theo mã phiên. Một tin được nhận ra bằng loại,
// tác giả và nội dung (không theo vị trí, vì dòng tiến độ biến mất làm lệch thứ tự khi lượt xong).
import { useCallback, useEffect, useState } from 'react';
import type { Msg } from './state';

export interface Pin {
  key: string;
  author: string;
  preview: string;
}

const STORE = 'chatqa.agent.pins.';
const MAX_PINS = 20;

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Khoá ghim của một tin; chỉ câu người dùng và câu trả lời đã xong của agent ghim được. */
export function pinKey(m: Msg): string | null {
  if (m.type === 'user') return `u:${hash(m.text)}`;
  if (m.type === 'text' && !m.streaming && m.text.trim()) return `t:${m.author}:${hash(m.text)}`;
  return null;
}

/** Dòng xem trước của tin ghim: bỏ cú pháp định dạng, một dòng, tối đa 140 ký tự. */
export function pinPreview(text: string): string {
  const flat = text
    .replace(/<[^>]+>/g, '')
    .replace(/```[\s\S]*?```/g, ' [mã] ')
    .replace(/[*_`~|#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
}

export function readPins(sessionId: string): Pin[] {
  if (!sessionId || typeof localStorage === 'undefined') return [];
  try {
    const v = JSON.parse(localStorage.getItem(STORE + sessionId) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((p): p is Pin => !!p && typeof (p as Pin).key === 'string' && typeof (p as Pin).preview === 'string') : [];
  } catch {
    return [];
  }
}

function writePins(sessionId: string, pins: Pin[]) {
  try {
    if (pins.length) localStorage.setItem(STORE + sessionId, JSON.stringify(pins));
    else localStorage.removeItem(STORE + sessionId);
  } catch {
    // hết chỗ hoặc bị chặn: ghim chỉ còn trong phiên làm việc này
  }
}

/** Bật/tắt ghim một tin; tin ghim mới nhất nằm cuối. Thuần. */
export function togglePin(pins: Pin[], m: Msg): Pin[] {
  const key = pinKey(m);
  if (!key || (m.type !== 'user' && m.type !== 'text')) return pins;
  if (pins.some((p) => p.key === key)) return pins.filter((p) => p.key !== key);
  return [...pins, { key, author: m.type === 'user' ? 'user' : m.author, preview: pinPreview(m.text) }].slice(-MAX_PINS);
}

export function usePins(sessionId: string) {
  const [pins, setPins] = useState<Pin[]>(() => readPins(sessionId));
  useEffect(() => setPins(readPins(sessionId)), [sessionId]);
  const toggle = useCallback(
    (m: Msg) => {
      if (!sessionId) return;
      setPins((cur) => {
        const next = togglePin(cur, m);
        writePins(sessionId, next);
        return next;
      });
    },
    [sessionId],
  );
  const unpin = useCallback(
    (key: string) =>
      setPins((cur) => {
        const next = cur.filter((p) => p.key !== key);
        writePins(sessionId, next);
        return next;
      }),
    [sessionId],
  );
  return { pins, toggle, unpin, enabled: !!sessionId };
}
