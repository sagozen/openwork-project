// Trạng thái minh hoạ cho bộ so ảnh (?demo=dialog-add, ?demo=phone,wrong-password...): CHỈ có ở bản dev, import.meta.env.DEV là hằng false khi build nên nhánh này bị loại.
export function demoState(): string | null {
  if (!import.meta.env.DEV) return null;
  const q = location.hash.includes('?') ? location.hash.slice(location.hash.indexOf('?') + 1) : location.search.slice(1);
  return new URLSearchParams(q).get('demo');
}

/** Cờ minh hoạ (nhiều cờ cách nhau dấu phẩy). */
export const demoFlag = (flag: string): boolean => !!demoState()?.split(',').includes(flag);

/** Khung điện thoại trong bộ so ảnh: `?demo=phone` vẽ thanh trạng thái giả 40px của khung máy pen. Không bao giờ có trong bản build. */
export const demoPhone = () => demoFlag('phone');
