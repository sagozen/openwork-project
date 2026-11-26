import { useMemo, useRef, useState } from "react";
import { SearchBox, Badge } from "@fluentui/react-components";
import { useNavigate } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth/AuthProvider";
import { PERM } from "@/lib/admin/rbac";
import { toneToColor } from "@/lib/admin/tone";
import {
  RECENT_SEARCHES,
  groupHits,
  resolveSub,
  resolveTitle,
  searchIndex,
  type SearchGroupKey,
  type SearchItem,
} from "@/lib/admin/search-data";
import { useGlobalSearch, type SearchHit as ApiSearchHit } from "@/features/search";
import { apiErrorMessage } from "@/lib/api";

const GROUP_NAMES: Record<SearchGroupKey, string> = {
  hoso: "Hồ sơ kiểm nghiệm",
  mau: "Mẫu và mã con",
  kh: "Khách hàng",
  phieu: "Phiếu kết quả",
};

/** Màn đích của từng nhóm. Khách hàng chưa có màn chi tiết riêng nên dẫn về danh sách hồ sơ -
 *  thà đưa người dùng tới chỗ tra được còn hơn một đường dẫn chết. */
function targetPath(hit: ApiSearchHit): string {
  switch (hit.group) {
    case "hoso":
      return `/ho-so-chi-tiet/${hit.targetId}`;
    case "mau":
      return "/tiep-nhan";
    case "phieu":
      return "/tra-ket-qua";
    default:
      return "/ho-so";
  }
}

function toSearchItem(hit: ApiSearchHit): SearchItem {
  return {
    g: hit.group,
    gn: GROUP_NAMES[hit.group],
    title: hit.title,
    sub: hit.subtitle ?? "",
    keys: "",
    tone: "info",
    tts: hit.status ?? "",
    to: targetPath(hit),
  };
}

/* Ô tìm kiếm toàn cục + popover gợi ý (mockup: 340px / popover 480px). */
export function GlobalSearch() {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { can, usesClerk } = useAuth();
  const canPii = can(PERM.REQUEST_CUSTOMER_VIEW);
  /* D19: chặn ở mọi đường vào, không chỉ ở menu. Toàn bộ chỉ mục tìm kiếm là dữ liệu hồ sơ,
     nên tài khoản không có `request.read` (quản trị hệ thống) không được thấy cả gợi ý -
     bấm vào cũng chỉ rơi vào màn "Không có quyền truy cập". */
  const canSearchRecords = can(PERM.REQUEST_READ);
  const boxRef = useRef<HTMLDivElement>(null);

  const remote = useGlobalSearch(q, canSearchRecords);

  // Kết quả của máy chủ được quy về đúng hình dạng mà popover vốn vẽ, để một khối hiển thị phục
  // vụ cả hai chế độ. Máy chủ đã bỏ nhóm khách hàng khi thiếu quyền PII, nên ở đây không cần che
  // thêm lần nữa - nhưng `resolveTitle`/`resolveSub` vẫn chạy để bản minh hoạ giữ nguyên hành vi.
  const hits = useMemo(() => {
    if (!canSearchRecords) return [];
    if (!usesClerk) return searchIndex(q, canPii);
    return (remote.data?.hits ?? []).map(toSearchItem);
  }, [q, canPii, canSearchRecords, usesClerk, remote.data]);
  const groups = useMemo(() => groupHits(hits, 3), [hits]);
  const nq = q.trim();

  const go = (to: string) => {
    setOpen(false);
    void navigate({ to });
  };

  return (
    <>
      {open ? (
        <div className="dlp-search__scrim" onClick={() => setOpen(false)} aria-hidden="true" />
      ) : null}
      <div
        className="dlp-search"
        ref={boxRef}
        onFocus={() => setOpen(true)}
        onKeyDownCapture={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
      >
        <SearchBox
          value={q}
          onChange={(_, d) => {
            setQ(d.value);
            setOpen(true);
          }}
          placeholder="Tìm mã lượt, container, khách hàng…"
          aria-label="Tìm kiếm toàn hệ thống"
          style={{ width: "100%" }}
        />

        {open ? (
          <div className="dlp-searchpop" role="dialog" aria-label="Gợi ý tìm kiếm">
            {!canSearchRecords ? (
              <div style={{ padding: "18px 14px" }}>
                <div className="dlp-searchpop__title">Không có quyền tra cứu hồ sơ</div>
                <div className="dlp-searchpop__sub" style={{ marginTop: 4 }}>
                  Tài khoản này chỉ có quyền quản trị hệ thống. Tìm kiếm toàn cục chỉ trả về dữ liệu
                  hồ sơ kiểm nghiệm nên không hiển thị kết quả nào.
                </div>
              </div>
            ) : usesClerk && remote.isFetching && nq ? (
              <div style={{ padding: "18px 14px" }}>
                <div className="dlp-searchpop__sub">Đang tìm…</div>
              </div>
            ) : usesClerk && remote.error ? (
              <div style={{ padding: "18px 14px" }}>
                <div className="dlp-searchpop__title">Không tìm được</div>
                <div className="dlp-searchpop__sub" style={{ marginTop: 4 }}>
                  {apiErrorMessage(remote.error, "Máy chủ không trả lời truy vấn tìm kiếm.")}
                </div>
              </div>
            ) : !nq ? (
              <div style={{ padding: "10px 0" }}>
                {/* "Tìm gần đây" là dữ liệu dựng sẵn: máy chủ chưa lưu lịch sử tìm kiếm của ai
                    cả. Ở chế độ thật thì không bày ra, thay vì bày một danh sách của người khác. */}
                {!usesClerk ? (
                  <>
                    <div className="dlp-searchpop__group">Tìm gần đây</div>
                    {RECENT_SEARCHES.map((r) => (
                      <button
                        key={r.text}
                        type="button"
                        className="dlp-searchpop__recent"
                        onClick={() => setQ(r.text)}
                      >
                        <span className="dlp-searchpop__kind">{r.kind}</span>
                        <span className="dlp-num">{r.text}</span>
                      </button>
                    ))}
                  </>
                ) : null}
                <div className="dlp-searchpop__foot">
                  Tìm theo mã lượt, mã mẫu con, mã task, số container, biển số, số phiếu hoặc tên
                  khách hàng.
                </div>
              </div>
            ) : hits.length ? (
              <>
                <div className="dlp-searchpop__list">
                  {groups.map((g) => (
                    <div key={g.key}>
                      <div className="dlp-searchpop__grouprow">
                        <span className="dlp-searchpop__group">{g.name}</span>
                        <span className="dlp-searchpop__count dlp-num">{g.count}</span>
                      </div>
                      {g.items.map((it) => (
                        <button
                          key={`${g.key}-${it.title}`}
                          type="button"
                          className="dlp-searchpop__item"
                          onClick={() => go(it.to)}
                        >
                          <span className="dlp-searchpop__body">
                            <span className="dlp-searchpop__title dlp-num">
                              {resolveTitle(it, canPii)}
                            </span>
                            <span className="dlp-searchpop__sub">{resolveSub(it, canPii)}</span>
                          </span>
                          <Badge appearance="tint" size="small" color={toneToColor(it.tone)}>
                            {it.tts}
                          </Badge>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
                <button type="button" className="dlp-searchpop__all" onClick={() => go("/ho-so")}>
                  {`Xem tất cả ${hits.length} kết quả cho «${q}»`}
                </button>
              </>
            ) : (
              <div style={{ padding: "18px 14px" }}>
                <div className="dlp-searchpop__title">{`Không tìm thấy kết quả cho «${q}».`}</div>
                <div className="dlp-searchpop__sub" style={{ marginTop: 4 }}>
                  Kiểm tra lại mã hoặc bỏ bớt ký tự. Nhân viên chỉ tìm được hồ sơ thuộc chi nhánh và
                  phạm vi phân quyền của mình.
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </>
  );
}
