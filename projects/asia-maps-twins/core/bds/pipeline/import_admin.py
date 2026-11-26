"""Nạp đơn vị hành chính 2 cấp (34 tỉnh/thành, 3.321 xã/phường) từ vietnamadminunits vào geo.admin_unit.

Bảng là dẫn xuất: chạy lại sẽ xoá và nạp lại toàn bộ.
"""

import os
import sqlite3

import psycopg
import vietnamadminunits

from bds.config import settings
from bds.text.normalize import fold


def main() -> None:
    db = os.path.join(os.path.dirname(vietnamadminunits.__file__), "data", "dataset.db")
    with sqlite3.connect(db) as src:
        rows = src.execute(
            "SELECT province, provinceShort, provinceCode, provinceLat, provinceLon, "
            "ward, wardShort, wardType, wardCode, wardLat, wardLon, wardAreaKm2 FROM admin_units"
        ).fetchall()

    provinces: dict[str, tuple] = {}
    wards = []
    for p, ps, pc, plat, plon, w, ws, wt, wc, wlat, wlon, area in rows:
        provinces[pc] = (pc, 1, p, ps, p.split(" ")[0] if p.startswith("Tỉnh") else "Thành phố", fold(p), None,
                         None, plon, plat)
        wards.append((wc, 2, w, ws, wt, fold(w), pc, area, wlon, wlat))

    with psycopg.connect(settings().pg_dsn) as conn, conn.cursor() as cur:
        cur.execute("TRUNCATE geo.admin_unit CASCADE")
        insert = ("INSERT INTO geo.admin_unit (code, level, name, name_short, unit_type, name_norm, parent_code, "
                  "area_km2, geom) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, ST_SetSRID(ST_MakePoint(%s, %s), 4326))")
        cur.executemany(insert, list(provinces.values()))
        cur.executemany(insert, wards)
        cur.execute("SELECT level, count(*) FROM geo.admin_unit GROUP BY level ORDER BY level")
        print("admin_unit:", dict(cur.fetchall()))


if __name__ == "__main__":
    main()
