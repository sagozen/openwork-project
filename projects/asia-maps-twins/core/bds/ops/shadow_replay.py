"""Phát lại danh sách địa chỉ (CSV) qua bộ phân giải, ghi log như yêu cầu thật (client = "replay").

Dùng khi OMS chưa bật được shadow traffic, hoặc để chạy golden set khi có dữ liệu công ty.
CSV (UTF-8, có dòng tiêu đề). Cột bắt buộc: `address`. Cột tuỳ chọn:
  order_id               mã đơn
  ref_lat, ref_lng       kết quả của nguồn tham chiếu (vd. Google) → chỉ lưu khoảng cách
  truth_lat, truth_lng   toạ độ đúng (GPS phát thành công) → tính độ chính xác @50m/@200m/@500m

Chạy: uv run python -m bds.ops.shadow_replay duong/dan.csv [--out ket-qua.csv]
"""

from __future__ import annotations

import argparse
import csv
import statistics
import time
from collections import Counter

import psycopg
from psycopg.rows import dict_row

from bds.config import settings
from bds.geocode.resolver import Geocoder
from bds.ops import recording
from bds.ops.request_log import writer
from bds.routing.engine import Point, haversine_m


def _float(v: str | None) -> float | None:
    try:
        return float(v) if v not in (None, "") else None
    except ValueError:
        return None


def replay(path: str, out: str | None = None) -> dict:
    with open(path, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    if not rows or "address" not in rows[0]:
        raise SystemExit("CSV cần cột 'address'")
    levels, took, truth_err, ref_err, out_rows = Counter(), [], [], [], []
    with psycopg.connect(settings().pg_dsn, row_factory=dict_row, autocommit=True) as conn:
        g = Geocoder(conn)
        for row in rows:
            ctx = recording.new_ctx(None, row.get("order_id") or None)
            ctx["client"] = "replay"
            t0 = time.perf_counter()
            r = g.geocode(row["address"])
            ms = (time.perf_counter() - t0) * 1000
            ref_lat, ref_lng = _float(row.get("ref_lat")), _float(row.get("ref_lng"))
            reference = {"source": "reference", "lat": ref_lat, "lng": ref_lng} if ref_lat and ref_lng else None
            recording.record_geocode("replay", row["address"], r, ms, row.get("order_id") or None, reference)
            levels[r.level] += 1
            took.append(ms)
            out_row = {**row, "bds_lat": r.lat, "bds_lng": r.lon, "bds_level": r.level,
                       "bds_confidence": r.confidence, "request_id": ctx["request_id"]}
            t_lat, t_lng = _float(row.get("truth_lat")), _float(row.get("truth_lng"))
            if t_lat and t_lng:
                e = haversine_m(Point(r.lat, r.lon), Point(t_lat, t_lng)) if r.lat is not None else float("inf")
                truth_err.append(e)
                out_row["error_m"] = round(e, 1)
            if reference and r.lat is not None:
                ref_err.append(haversine_m(Point(r.lat, r.lon), Point(ref_lat, ref_lng)))
            out_rows.append(out_row)
    writer().flush()
    if out:
        with open(out, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(out_rows[0]))
            w.writeheader()
            w.writerows(out_rows)

    summary = {"n": len(rows), "levels": dict(levels.most_common()),
               "latency_p50_ms": round(statistics.median(took), 1),
               "latency_p95_ms": round(statistics.quantiles(took, n=20)[18], 1) if len(took) >= 20 else None}
    if truth_err:
        k = len(truth_err)
        summary["truth"] = {"n": k, **{f"acc{d}": round(sum(e <= d for e in truth_err) / k, 3) for d in (50, 200, 500)},
                            "median_error_m": round(statistics.median(truth_err), 1)}
    if ref_err:
        summary["reference_median_distance_m"] = round(statistics.median(ref_err), 1)
    return summary


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("csv")
    ap.add_argument("--out")
    args = ap.parse_args()
    for k, v in replay(args.csv, args.out).items():
        print(f"{k}: {v}")


if __name__ == "__main__":
    main()
