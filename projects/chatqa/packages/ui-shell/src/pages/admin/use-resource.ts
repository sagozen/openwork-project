import { useCallback, useEffect, useRef, useState } from 'react';
import { toAdminError } from './admin-error';

export interface Resource<T> {
  data: T | null;
  /** Lỗi đã đưa về dạng admin (mất mạng => need_network, E-020). */
  error: unknown;
  loading: boolean;
  reload: () => Promise<void>;
  set: (v: T | ((cur: T | null) => T | null)) => void;
}

/** Tải dữ liệu 1 lần khi mở màn (và khi `deps` đổi); `reload` tải lại. Màn quản trị luôn cần mạng, không dùng cache cũ khi lỗi. */
export function useResource<T>(load: () => Promise<T>, deps: unknown[] = []): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const loader = useRef(load);
  loader.current = load;

  const run = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const v = await loader.current();
      if (mine === seq.current) {
        setData(v);
        setError(null);
      }
    } catch (e) {
      if (mine === seq.current) {
        setData(null);
        setError(toAdminError(e));
      }
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void run(), deps);
  return { data, error, loading, reload: run, set: (v) => setData(typeof v === 'function' ? (v as (c: T | null) => T | null)(data) : v) };
}
