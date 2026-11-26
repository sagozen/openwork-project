/* State cho màn Hồ sơ kiểm nghiệm: chế độ xem, nhãn, điều kiện lọc,
   cấu hình cột, mật độ bảng và lựa chọn dòng. Lưu vào localStorage. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { hasFile, isOverdue, MOCK_RECORDS, type RecordRow } from "./records-data";
import {
  RECORD_COLUMNS,
  RECORD_VIEW_DEFS,
  type Condition,
  type RecordColumn,
  type ViewDef,
} from "./records-view-data";
import type { RequestListFilters } from "@/features/request/types";

export type TagMode = "any" | "all" | "none";
export type Density = "comfortable" | "compact";
export type Variant = "A" | "B" | "C";

export interface RecordsViewState {
  viewId: string;
  tags: string[];
  tagMode: TagMode;
  conds: Condition[];
  order: string[];
  hidden: string[];
  pinned: string[];
  density: Density;
  variant: Variant;
  savedViews: ViewDef[];
  defaultViewId: string | null;
}

const STORAGE_KEY = "dlp.records.view.v1";

const INITIAL: RecordsViewState = {
  viewId: "all",
  tags: [],
  tagMode: "any",
  conds: [],
  order: RECORD_COLUMNS.map((c) => c.key),
  hidden: [],
  pinned: [],
  density: "comfortable",
  variant: "A",
  savedViews: [],
  defaultViewId: null,
};

/** Converts the persisted prototype view into server-owned request filters. */
export function recordsViewToRequestFilters(
  state: Pick<RecordsViewState, "tags" | "tagMode" | "conds">,
  query: string,
  page = 1,
  paging: { size?: number; sort?: string } = {},
): RequestListFilters {
  const paymentStatus: string[] = [];
  for (const condition of state.conds) {
    if (condition.field === "progress" && condition.op === "is") paymentStatus.push("OVERDUE");
  }
  // Cả ba chế độ nhãn đều do máy chủ lọc, kể cả "none" (loại trừ). Trước đây "none" bị giữ lại
  // ở phía client và lọc trên đúng trang đang tải, nên từ trang 2 trở đi kết quả sai: một hồ sơ
  // mang nhãn bị loại vẫn hiện ra chỉ vì nó không nằm trong 50 dòng đã tải về.
  return {
    page,
    size: paging.size ?? 50,
    sort: paging.sort ?? "createdAt:desc",
    ...(query ? { q: query } : {}),
    paymentStatus,
    tag: state.tags,
    tagMode: state.tagMode,
  };
}

export { hasFile, isOverdue };

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

function matchCond(r: RecordRow, c: Condition): boolean {
  if (c.field === "progress") return c.op === "is" ? isOverdue(r) : !isOverdue(r);
  if (c.field === "file") return c.op === "has" ? hasFile(r) : !hasFile(r);
  const val = c.field === "customer" ? r.customer : r.product;
  if (!c.val) return true;
  return c.op === "eq" ? norm(val) === norm(c.val) : norm(val).includes(norm(c.val));
}

export interface RowOverride {
  tags?: string[];
  handler?: string;
}

export interface RecordsViewOptions {
  /** Nguồn dòng hiển thị. Mặc định là dữ liệu mẫu của bản mockup. */
  source?: RecordRow[];
  /** Máy chủ đã lọc theo từ khoá: bỏ lọc lặp phía client để không cắt mất kết quả
   *  máy chủ tìm được bằng những trường mà bảng không hiển thị (số container…). */
  serverQuery?: boolean;
  /** Máy chủ đã lọc theo nhãn (trừ chế độ "không có nhãn"). */
  serverTags?: boolean;
}

/** Phần state của màn: chế độ xem, nhãn, điều kiện, cột, lựa chọn dòng. Tách riêng khỏi phần
 *  dựng dòng để màn chạy dữ liệu thật đọc được bộ lọc trước khi gọi API rồi mới có dòng. */
/**
 * Nguồn chế độ xem đặt trên máy chủ. Vắng mặt = bản minh hoạ, mọi thứ nằm trong localStorage.
 *
 * Có mặt thì danh sách chế độ xem và cờ mặc định đọc TỪ ĐÂY chứ không phải từ state cục bộ -
 * giữ hai bản sao rồi cố cho chúng khớp nhau là cách chắc chắn để chúng lệch.
 */
export interface RecordsViewSync {
  savedViews: ViewDef[];
  defaultViewId: string | null;
  onSave: (input: {
    name: string;
    isDefault: boolean;
    scope: "private" | "branch" | "tenant";
    definition: {
      tags: string[];
      tagMode: TagMode;
      conds: Condition[];
      order: string[];
      hidden: string[];
      pinned: string[];
      density: Density;
    };
  }) => void;
  onDelete?: (id: string) => void;
}

export function useRecordsViewState(canPii: boolean, sync?: RecordsViewSync) {
  const [state, setState] = useState<RecordsViewState>(INITIAL);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, RowOverride>>({});

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setState((prev) => ({ ...prev, ...(JSON.parse(raw) as RecordsViewState) }));
    } catch {
      /* bỏ qua */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* bỏ qua */
    }
  }, [state]);

  const patch = useCallback((p: Partial<RecordsViewState>, markDirty = true) => {
    setState((prev) => ({ ...prev, ...p }));
    if (markDirty) setDirty(true);
  }, []);

  const allViews = useMemo(
    () => [...RECORD_VIEW_DEFS, ...(sync ? sync.savedViews : state.savedViews)],
    [state.savedViews, sync],
  );
  const defaultViewId = sync ? sync.defaultViewId : state.defaultViewId;
  const currentView = allViews.find((v) => v.id === state.viewId) ?? allViews[0];

  const pickView = useCallback((v: ViewDef) => {
    setState((prev) => ({
      ...prev,
      viewId: v.id,
      tags: [...v.tags],
      conds: v.conds.map((c) => ({ ...c })),
      // Chế độ xem lưu trên máy chủ mang theo cả bố cục; chế độ xem dựng sẵn thì không, và giữ
      // nguyên cột người dùng đang dùng là đúng ý họ hơn là xáo lại.
      ...(v.layout ?? {}),
    }));
    setDirty(false);
  }, []);

  const resetView = useCallback(() => {
    setState((prev) => ({ ...INITIAL, savedViews: prev.savedViews, variant: prev.variant }));
    setDirty(false);
  }, []);

  const saveView = useCallback(
    (name: string, makeDefault: boolean, scope: "private" | "branch" | "tenant" = "private") => {
      if (sync) {
        sync.onSave({
          name,
          isDefault: makeDefault,
          scope,
          definition: {
            tags: [...state.tags],
            tagMode: state.tagMode,
            conds: state.conds.map((c) => ({ ...c })),
            order: [...state.order],
            hidden: [...state.hidden],
            pinned: [...state.pinned],
            density: state.density,
          },
        });
        setDirty(false);
        return;
      }
      saveViewLocally(name, makeDefault);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sync, state],
  );

  const saveViewLocally = useCallback((name: string, makeDefault: boolean) => {
    setState((prev) => {
      const id = `my-${Date.now()}`;
      const view: ViewDef = {
        id,
        name,
        group: "Chế độ xem của tôi",
        count: 0,
        tags: [...prev.tags],
        conds: prev.conds.map((c) => ({ ...c })),
      };
      return {
        ...prev,
        savedViews: [...prev.savedViews, view],
        viewId: id,
        defaultViewId: makeDefault ? id : prev.defaultViewId,
      };
    });
    setDirty(false);
  }, []);

  const toggleTag = useCallback(
    (name: string) =>
      patch({
        tags: state.tags.includes(name)
          ? state.tags.filter((t) => t !== name)
          : [...state.tags, name],
      }),
    [patch, state.tags],
  );

  /* ----- cột ----- */
  const columns: RecordColumn[] = useMemo(() => {
    const byKey = new Map(RECORD_COLUMNS.map((c) => [c.key, c]));
    return state.order
      .map((k) => byKey.get(k))
      .filter((c): c is RecordColumn => !!c && (!c.pii || canPii));
  }, [state.order, canPii]);

  const visibleColumns = useMemo(() => {
    const shown = columns.filter((c) => !state.hidden.includes(c.key));
    const pin = shown.filter((c) => state.pinned.includes(c.key));
    const rest = shown.filter((c) => !state.pinned.includes(c.key));
    return [...pin, ...rest];
  }, [columns, state.hidden, state.pinned]);

  const hiddenColumns = useMemo(
    () => columns.filter((c) => state.hidden.includes(c.key)),
    [columns, state.hidden],
  );

  const toggleColumn = useCallback(
    (key: string) =>
      patch({
        hidden: state.hidden.includes(key)
          ? state.hidden.filter((k) => k !== key)
          : [...state.hidden, key],
      }),
    [patch, state.hidden],
  );

  const togglePin = useCallback(
    (key: string) =>
      patch({
        pinned: state.pinned.includes(key)
          ? state.pinned.filter((k) => k !== key)
          : [...state.pinned, key],
      }),
    [patch, state.pinned],
  );

  const moveColumn = useCallback(
    (key: string, dir: -1 | 1) => {
      const order = [...state.order];
      const i = order.indexOf(key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= order.length) return;
      [order[i], order[j]] = [order[j]!, order[i]!];
      patch({ order });
    },
    [patch, state.order],
  );

  const clearAllFilters = useCallback(() => patch({ tags: [], conds: [] }), [patch]);

  const toggleRow = useCallback(
    (id: string) =>
      setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])),
    [],
  );

  return {
    state,
    patch,
    query,
    setQuery,
    allViews,
    currentView,
    defaultViewId,
    pickView,
    resetView,
    saveView,
    deleteView: sync?.onDelete,
    dirty,
    toggleTag,
    columns,
    visibleColumns,
    hiddenColumns,
    toggleColumn,
    togglePin,
    moveColumn,
    clearAllFilters,
    selected,
    setSelected,
    toggleRow,
    overrides,
    setOverrides,
  };
}

export type RecordsViewBase = ReturnType<typeof useRecordsViewState>;

/** Phần dòng của màn: áp bộ lọc còn lại phía client và các thao tác hàng loạt trên dòng đã chọn. */
export function useRecordsRows(
  base: RecordsViewBase,
  source: RecordRow[],
  { serverQuery = false, serverTags = false }: Omit<RecordsViewOptions, "source"> = {},
) {
  const { state, query, selected, overrides, setOverrides, setSelected } = base;

  const baseRows = useMemo(
    () =>
      source.map((r) => {
        const o = overrides[r.id];
        return o
          ? {
              ...r,
              ...(o.tags ? { tags: o.tags } : {}),
              ...(o.handler ? { handler: o.handler } : {}),
            }
          : r;
      }),
    [overrides, source],
  );

  const rows = useMemo(() => {
    const q = serverQuery ? "" : query.trim();
    // Chế độ "không có nhãn nào đã chọn" luôn phải lọc lại ở client vì API chưa hỗ trợ.
    // Máy chủ lọc được cả ba chế độ nhãn, nên khi `serverTags` bật thì client không lọc lại -
    // lọc chồng lên kết quả đã lọc chỉ có thể cắt bớt sai, không thể sửa đúng thêm.
    const filterTags = !serverTags;
    return baseRows.filter((r) => {
      if (q) {
        const hay = norm(`${r.id} ${r.product} ${r.customer} ${r.handler}`);
        if (!hay.includes(norm(q))) return false;
      }
      if (filterTags && state.tags.length) {
        const hits = state.tags.filter((t) => r.tags.includes(t)).length;
        if (state.tagMode === "any" && hits === 0) return false;
        if (state.tagMode === "all" && hits !== state.tags.length) return false;
        if (state.tagMode === "none" && hits > 0) return false;
      }
      return state.conds.every((c) => matchCond(r, c));
    });
  }, [baseRows, query, serverQuery, serverTags, state.tags, state.tagMode, state.conds]);

  const toggleAllRows = useCallback(
    () => setSelected((prev) => (prev.length === rows.length ? [] : rows.map((r) => r.id))),
    [rows, setSelected],
  );

  /* ----- thao tác hàng loạt trên các dòng đang chọn ----- */
  const rowById = useMemo(() => new Map(baseRows.map((r) => [r.id, r])), [baseRows]);

  const addTagToSelected = useCallback(
    (tag: string) => {
      setOverrides((prev) => {
        const next = { ...prev };
        for (const id of selected) {
          const cur = next[id]?.tags ?? rowById.get(id)?.tags ?? [];
          if (!cur.includes(tag)) next[id] = { ...next[id], tags: [...cur, tag] };
        }
        return next;
      });
    },
    [selected, rowById, setOverrides],
  );

  const removeTagFromSelected = useCallback(
    (tag: string) => {
      setOverrides((prev) => {
        const next = { ...prev };
        for (const id of selected) {
          const cur = next[id]?.tags ?? rowById.get(id)?.tags ?? [];
          next[id] = { ...next[id], tags: cur.filter((t) => t !== tag) };
        }
        return next;
      });
    },
    [selected, rowById, setOverrides],
  );

  const assignHandlerToSelected = useCallback(
    (handler: string) => {
      setOverrides((prev) => {
        const next = { ...prev };
        for (const id of selected) next[id] = { ...next[id], handler };
        return next;
      });
    },
    [selected, setOverrides],
  );

  return {
    rows,
    toggleAllRows,
    addTagToSelected,
    removeTagFromSelected,
    assignHandlerToSelected,
  };
}

/** Màn dùng dữ liệu có sẵn ngay (bản mockup): state và dòng dựng trong một lần gọi. */
export function useRecordsView(canPii: boolean, options: RecordsViewOptions = {}) {
  const { source = MOCK_RECORDS, ...rest } = options;
  const base = useRecordsViewState(canPii);
  return { ...base, ...useRecordsRows(base, source, rest) };
}

export type RecordsView = ReturnType<typeof useRecordsView>;
