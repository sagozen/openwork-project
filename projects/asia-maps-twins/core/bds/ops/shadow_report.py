"""Báo cáo vận hành từ log (schema ops): lưu lượng, phân bố mức/độ tin cậy, độ trễ, so sánh shadow,
tỉ lệ chọn gợi ý trong top-3, tỉ lệ khoảng cách phải dự phòng.

Chạy: uv run python -m bds.ops.shadow_report [số_ngày=7]
"""

from __future__ import annotations

import sys

import psycopg
from psycopg.rows import dict_row

from bds.config import settings

QUERIES = {
    "Lưu lượng theo hệ thống gọi": """
        SELECT client, api, count(*) n,
               round(percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)::numeric, 1) p50_ms,
               round(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::numeric, 1) p95_ms
        FROM ops.geocode_log WHERE ts > now() - make_interval(days => %(d)s)
        GROUP BY 1, 2 ORDER BY n DESC""",
    "Phân giải theo mức": """
        SELECT level, count(*) n, round(100.0 * count(*) / sum(count(*)) OVER (), 1) pct,
               round(avg(confidence)::numeric, 2) avg_conf
        FROM ops.geocode_log WHERE ts > now() - make_interval(days => %(d)s)
        GROUP BY 1 ORDER BY n DESC""",
    "Theo hợp đồng độ tin cậy": """
        SELECT CASE WHEN confidence >= 0.7 THEN '>= 0,7 tự gán'
                    WHEN confidence >= 0.5 THEN '0,5–0,69 gán + xác nhận'
                    ELSE '< 0,5 hỏi lại' END nhom,
               count(*) n, round(100.0 * count(*) / sum(count(*)) OVER (), 1) pct
        FROM ops.geocode_log WHERE ts > now() - make_interval(days => %(d)s)
        GROUP BY 1 ORDER BY 1 DESC""",
    "So sánh shadow với nguồn tham chiếu": """
        SELECT reference, count(*) n,
               round(percentile_cont(0.5) WITHIN GROUP (ORDER BY distance_m)::numeric, 0) median_m,
               round(100.0 * avg((distance_m <= 50)::int), 1) pct_50m,
               round(100.0 * avg((distance_m <= 200)::int), 1) pct_200m,
               round(100.0 * avg((distance_m > 1000)::int), 1) pct_over_1km
        FROM ops.shadow_compare WHERE ts > now() - make_interval(days => %(d)s)
        GROUP BY 1""",
    "Gợi ý: vị trí mục được chọn": """
        WITH sel AS (
          SELECT p.session_token, p.place_id,
                 (SELECT s.place_ids FROM ops.suggest_log s
                  WHERE s.session_token = p.session_token AND s.ts <= p.ts ORDER BY s.ts DESC LIMIT 1) ids
          FROM ops.place_select_log p
          WHERE p.session_token IS NOT NULL AND p.ts > now() - make_interval(days => %(d)s))
        SELECT count(*) sessions,
               round(100.0 * avg((array_position(ids, place_id) <= 3)::int), 1) pct_top3,
               round(100.0 * avg((array_position(ids, place_id) = 1)::int), 1) pct_top1
        FROM sel WHERE ids IS NOT NULL""",
    "Khoảng cách: tỉ lệ dự phòng": """
        SELECT kind, vehicle, count(*) n, sum(fallback_cells) fallback_cells,
               round(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::numeric, 1) p95_ms
        FROM ops.route_log WHERE ts > now() - make_interval(days => %(d)s)
        GROUP BY 1, 2 ORDER BY n DESC""",
}


def report(days: int = 7) -> dict[str, list[dict]]:
    with psycopg.connect(settings().pg_dsn, row_factory=dict_row) as conn:
        return {title: conn.execute(sql, {"d": days}).fetchall() for title, sql in QUERIES.items()}


def main() -> None:
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 7
    print(f"# Báo cáo vận hành {days} ngày gần nhất\n")
    for title, rows in report(days).items():
        print(f"## {title}")
        if not rows:
            print("(chưa có dữ liệu)\n")
            continue
        cols = list(rows[0])
        print(" | ".join(cols))
        for r in rows:
            print(" | ".join("" if r[c] is None else str(r[c]) for c in cols))
        print()


if __name__ == "__main__":
    main()
