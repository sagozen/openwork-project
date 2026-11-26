import { useSyncExternalStore } from 'react';

/** Dưới 768px: bố cục điện thoại; từ 768px: bố cục desktop co giãn (nội dung tối đa 1204). */
export const PHONE_QUERY = '(max-width: 767.98px)';

const subscribe = (cb: () => void) => {
  const m = window.matchMedia(PHONE_QUERY);
  m.addEventListener('change', cb);
  return () => m.removeEventListener('change', cb);
};

export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(PHONE_QUERY).matches, () => false);
}
