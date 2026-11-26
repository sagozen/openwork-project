// Khung hình trực tiếp, giữ ngoài React state: mỗi khung JPEG (sự kiện "live:frame") được giải mã rồi vẽ thẳng lên các
// canvas đang gắn với máy đó. React chỉ vẽ lại khi phần chữ của ô (chế độ, lỗi, kích thước) đổi, không phải mỗi khung.
import { useSyncExternalStore } from 'react';
import type { LiveFrame } from './bridge';

export interface FrameMeta {
  mode?: LiveFrame['mode'];
  error?: string;
  width?: number;
  height?: number;
}

/** Ảnh đã giải mã, vẽ được lên canvas (ImageBitmap trong app; ảnh giả trong test). */
export interface Decoded {
  width: number;
  height: number;
  close?: () => void;
}

export type Decoder = (b64: string, mime: string) => Promise<Decoded>;
/** Góc xoay hiển thị (theo chiều kim đồng hồ). */
export type Rotation = 0 | 90 | 180 | 270;

type Painter = (canvas: HTMLCanvasElement, img: Decoded, rot: Rotation) => void;

const sameMeta = (a: FrameMeta | undefined, b: FrameMeta) =>
  !!a && a.mode === b.mode && a.error === b.error && a.width === b.width && a.height === b.height;

export function createFrameStore(decode: Decoder = decodeImage, paint: Painter = paintCanvas) {
  const canvases = new Map<string, Set<HTMLCanvasElement>>();
  const last = new Map<string, Decoded>();
  const seqs = new Map<string, number>();
  const metas = new Map<string, FrameMeta>();
  const rots = new Map<string, Rotation>();
  const subs = new Set<() => void>();

  const setMeta = (id: string, m: FrameMeta) => {
    if (sameMeta(metas.get(id), m)) return;
    metas.set(id, m);
    subs.forEach((f) => f());
  };

  const show = (id: string, img: Decoded) => {
    const prev = last.get(id);
    if (prev && prev !== img) prev.close?.();
    last.set(id, img);
    canvases.get(id)?.forEach((c) => paint(c, img, rots.get(id) ?? 0));
  };

  return {
    /** Nhận một khung từ Go. Khung cũ hơn khung đã nhận (giải mã xong muộn) bị bỏ. */
    async push(f: LiveFrame): Promise<void> {
      const id = f.deviceId;
      if (f.seq <= (seqs.get(id) ?? 0)) return;
      seqs.set(id, f.seq);
      if (f.error) {
        setMeta(id, { ...metas.get(id), error: f.error });
        return;
      }
      if (f.mode === 'cold') {
        setMeta(id, { mode: 'cold' }); // chưa có driver ấm: không có ảnh để vẽ
        return;
      }
      const img = await decode(f.jpeg, 'image/jpeg');
      if (seqs.get(id) !== f.seq) {
        img.close?.(); // đã có khung mới hơn trong lúc giải mã
        return;
      }
      show(id, img);
      setMeta(id, { mode: f.mode, width: f.width, height: f.height });
    },
    /** Ảnh PNG trả về ngay sau khi chạm/vuốt (device_tap, device_swipe): hiện luôn, không chờ khung kế tiếp. */
    async pushPng(id: string, b64: string): Promise<void> {
      const seq = seqs.get(id) ?? 0;
      const img = await decode(b64, 'image/png');
      if ((seqs.get(id) ?? 0) !== seq) {
        img.close?.();
        return;
      }
      show(id, img);
    },
    /** Gắn canvas của một ô; vẽ ngay khung gần nhất. Trả hàm gỡ. */
    attach(id: string, canvas: HTMLCanvasElement): () => void {
      let set = canvases.get(id);
      if (!set) canvases.set(id, (set = new Set()));
      set.add(canvas);
      const img = last.get(id);
      if (img) paint(canvas, img, rots.get(id) ?? 0);
      return () => {
        set.delete(canvas);
      };
    },
    /** Đổi góc xoay của một máy và vẽ lại khung gần nhất trên mọi canvas của máy đó. */
    setRotation(id: string, rot: Rotation): void {
      if ((rots.get(id) ?? 0) === rot) return;
      rots.set(id, rot);
      const img = last.get(id);
      if (img) canvases.get(id)?.forEach((c) => paint(c, img, rot));
    },
    meta: (id: string): FrameMeta | undefined => metas.get(id),
    subscribe(fn: () => void): () => void {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export type FrameStore = ReturnType<typeof createFrameStore>;

function paintCanvas(canvas: HTMLCanvasElement, img: Decoded, rot: Rotation) {
  const sideways = rot === 90 || rot === 270;
  const w = sideways ? img.height : img.width;
  const h = sideways ? img.width : img.height;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.translate(w / 2, h / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(img as unknown as CanvasImageSource, -img.width / 2, -img.height / 2, img.width, img.height);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

async function decodeImage(b64: string, mime: string): Promise<Decoded> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (typeof createImageBitmap === 'function') return createImageBitmap(new Blob([bytes], { type: mime }));
  const el = new Image(); // WebView cũ không có createImageBitmap
  el.src = `data:${mime};base64,${b64}`;
  await el.decode();
  return Object.assign(el, { width: el.naturalWidth, height: el.naturalHeight });
}

/** Kho khung hình của app. */
export const frames = createFrameStore();

/** Phần chữ của một ô (chế độ, lỗi); chỉ đổi khi Go báo trạng thái khác. */
export function useFrameMeta(id: string, store: FrameStore = frames): FrameMeta | undefined {
  const snap = () => store.meta(id);
  return useSyncExternalStore(store.subscribe, snap, snap);
}
