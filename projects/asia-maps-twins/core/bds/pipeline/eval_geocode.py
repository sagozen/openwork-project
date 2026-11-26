"""Đo độ chính xác phân giải trên tập địa chỉ OSM để dành (holdout, resolver không được dùng).

Mỗi mẫu: "<số nhà> <đường>, <xã>, <tỉnh>", với xã/tỉnh lấy theo tâm xã gần nhất (xấp xỉ cách khách ghi).
Chạy ba biến thể: có dấu, không dấu, viết tắt kiểu cũ; với "chỉ luật" và (nếu đã huấn luyện) "luật + ML".
Dùng nửa holdout có osm_id % 10 = 5; nửa còn lại (% 10 = 0) dành cho huấn luyện mô hình quyết định.
Kết quả ghi vào data/eval/geocode-<thời điểm>.json để so sánh trước/sau mỗi lần sửa.
"""

from __future__ import annotations

import json
import statistics
import sys
import time
from collections import Counter
from datetime import datetime
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

from bds.config import settings
from bds.geocode.resolver import Geocoder
from bds.learn import registry
from bds.routing.engine import Point, haversine_m
from bds.text.normalize import fold

SAMPLE_SQL = """
SELECT a.housenumber, a.street, ST_Y(a.geom) lat, ST_X(a.geom) lon, w.name ward, p.name province
FROM geo.address_point a
CROSS JOIN LATERAL (SELECT name, parent_code FROM geo.admin_unit WHERE level = 2
                    ORDER BY geom <-> a.geom LIMIT 1) w
JOIN geo.admin_unit p ON p.code = w.parent_code
WHERE a.holdout AND a.osm_id %% 10 = 5 AND a.street IS NOT NULL AND a.house_num IS NOT NULL
ORDER BY md5(a.osm_id::text) LIMIT %s
"""


def variants(row: dict) -> dict[str, str]:
    full = f"{row['housenumber']} {row['street']}, {row['ward']}, {row['province']}"
    short_prov = row["province"].replace("Thành phố ", "TP ").replace("Tỉnh ", "")
    short_ward = row["ward"].replace("Phường ", "P. ").replace("Xã ", "X. ")
    return {
        "co_dau": full,
        "khong_dau": fold(full),
        "viet_tat": f"{row['housenumber']} {row['street']}, {short_ward}, {short_prov}",
    }


def main(n: int = 1000) -> None:
    with psycopg.connect(settings().pg_dsn, row_factory=dict_row, autocommit=True) as conn:
        rows = conn.execute(SAMPLE_SQL, (n,)).fetchall()
        g = Geocoder(conn)
        tagger, decision = registry.current("tagger"), registry.current("decision")
        modes = {"luat": (None, None)}
        if tagger is not None and decision is not None:
            modes["luat+ML"] = (tagger, decision)
        report: dict[str, dict] = {}
        for (mode, (tg, dc)), vname in [(m, v) for m in modes.items() for v in ("co_dau", "khong_dau", "viet_tat")]:
            errors, levels, took = [], Counter(), []
            for row in rows:
                q = variants(row)[vname]
                t0 = time.perf_counter()
                r = g.geocode(q, tagger=tg, decision=dc)
                took.append((time.perf_counter() - t0) * 1000)
                levels[r.level] += 1
                errors.append(haversine_m(Point(r.lat, r.lon), Point(row["lat"], row["lon"]))
                              if r.lat is not None else float("inf"))
            k = len(errors)
            report[f"{mode}/{vname}"] = {
                "n": k,
                "acc50": round(sum(e <= 50 for e in errors) / k, 3),
                "acc200": round(sum(e <= 200 for e in errors) / k, 3),
                "acc500": round(sum(e <= 500 for e in errors) / k, 3),
                "median_error_m": round(statistics.median(errors), 1),
                "levels": dict(levels.most_common()),
                "latency_p50_ms": round(statistics.median(took), 1),
                "latency_p95_ms": round(statistics.quantiles(took, n=20)[18], 1),
            }
    print(f"{'chế độ/biến thể':<20} {'n':>5} {'@50m':>6} {'@200m':>6} {'@500m':>6} {'trung vị':>9} {'p95 ms':>7}  mức")
    for v, m in report.items():
        print(f"{v:<20} {m['n']:>5} {m['acc50']:>6} {m['acc200']:>6} {m['acc500']:>6} "
              f"{m['median_error_m']:>8}m {m['latency_p95_ms']:>7}  {m['levels']}")
    out = Path("data/eval")
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"geocode-{datetime.now():%Y%m%d-%H%M%S}.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print("đã ghi", path)


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 1000)
