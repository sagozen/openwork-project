"""Dựng bảng gợi ý geo.suggest_entry từ đơn vị hành chính, đường, địa danh và địa chỉ có số nhà.

Đường/địa danh/địa chỉ được gán xã gần nhất theo tâm xã (xấp xỉ, vì chưa có ranh giới xã 2 cấp dạng polygon).
Bảng là dẫn xuất: chạy lại sẽ dựng lại toàn bộ.
"""

import time

import psycopg

from bds.config import settings

SQL = r"""
DROP TABLE IF EXISTS geo.suggest_entry;
CREATE TABLE geo.suggest_entry (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,          -- province | ward | street | place | address
  ref text NOT NULL,           -- place_id ổn định qua các lần dựng lại (dùng cho API tương thích Google)
  label text NOT NULL,         -- hiển thị, có dấu
  norm text NOT NULL,          -- đã fold, dùng để so khớp
  ward_code text,
  province_code text,
  weight real NOT NULL,
  geom geometry(Point, 4326) NOT NULL
);

-- Hàm fold trong SQL, khớp với bds.text.normalize.fold cho chữ tiếng Việt.
CREATE OR REPLACE FUNCTION geo.vn_fold(t text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT regexp_replace(lower(translate(t,
    'àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐ',
    'aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyydAAAAAAAAAAAAAAAAAEEEEEEEEEEEIIIIIOOOOOOOOOOOOOOOOOUUUUUUUUUUUYYYYYD')),
    '\s+', ' ', 'g')
$$;

INSERT INTO geo.suggest_entry (kind, ref, label, norm, province_code, weight, geom)
SELECT 'province', 'au_' || code, name, name_norm, code, 5, geom FROM geo.admin_unit WHERE level = 1;

INSERT INTO geo.suggest_entry (kind, ref, label, norm, ward_code, province_code, weight, geom)
SELECT 'ward', 'au_' || w.code, w.name || ', ' || p.name, w.name_norm || ' ' || p.name_norm, w.code, p.code, 4, w.geom
FROM geo.admin_unit w JOIN geo.admin_unit p ON p.code = w.parent_code WHERE w.level = 2;

-- Xã gần nhất của một điểm.
CREATE TEMP TABLE ward_pt AS SELECT code, parent_code, name, geom FROM geo.admin_unit WHERE level = 2;
CREATE INDEX ON ward_pt USING gist (geom);

INSERT INTO geo.suggest_entry (kind, ref, label, norm, ward_code, province_code, weight, geom)
SELECT 'street', 'st_' || left(md5(w.code || '|' || s.name), 16), s.name || ', ' || w.name || ', ' || p.name,
       geo.vn_fold(s.name || ' ' || w.name || ' ' || p.name), w.code, p.code,
       1 + least(2, ln(1 + sum(ST_Length(s.geom::geography)) / 200)),
       ST_ClosestPoint(ST_Collect(s.geom), ST_Centroid(ST_Collect(s.geom)))
FROM geo.street s
CROSS JOIN LATERAL (SELECT code, parent_code, name FROM ward_pt
                    ORDER BY ward_pt.geom <-> ST_LineInterpolatePoint(s.geom, 0.5) LIMIT 1) w
JOIN geo.admin_unit p ON p.code = w.parent_code
GROUP BY s.name, w.code, w.name, p.code, p.name;

INSERT INTO geo.suggest_entry (kind, ref, label, norm, ward_code, province_code, weight, geom)
SELECT 'place', 'pl_' || pl.osm_type || pl.osm_id, pl.name || ', ' || w.name || ', ' || p.name,
       pl.name_norm || ' ' || geo.vn_fold(w.name || ' ' || p.name), w.code, p.code,
       CASE WHEN pl.kind LIKE 'place:%' OR pl.kind LIKE 'landuse:industrial' THEN 2 ELSE 1 END, pl.geom
FROM geo.place pl
CROSS JOIN LATERAL (SELECT code, parent_code, name FROM ward_pt ORDER BY ward_pt.geom <-> pl.geom LIMIT 1) w
JOIN geo.admin_unit p ON p.code = w.parent_code;

INSERT INTO geo.suggest_entry (kind, ref, label, norm, ward_code, province_code, weight, geom)
SELECT 'address', 'ad_' || a.osm_type || a.osm_id, a.housenumber || ' ' || a.street || ', ' || w.name || ', ' || p.name,
       geo.vn_fold(a.housenumber || ' ' || a.street || ' ' || w.name || ' ' || p.name), w.code, p.code, 1, a.geom
FROM geo.address_point a
CROSS JOIN LATERAL (SELECT code, parent_code, name FROM ward_pt ORDER BY ward_pt.geom <-> a.geom LIMIT 1) w
JOIN geo.admin_unit p ON p.code = w.parent_code
WHERE a.street IS NOT NULL AND NOT a.holdout;

-- Full-text (mọi từ có mặt, từ cuối khớp tiền tố) là đường chính; trigram KNN bù cho gõ sai.
ALTER TABLE geo.suggest_entry ADD COLUMN tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', norm)) STORED;
CREATE INDEX suggest_tsv ON geo.suggest_entry USING gin (tsv);
CREATE INDEX suggest_norm_trgm ON geo.suggest_entry USING gist (norm gist_trgm_ops);
CREATE INDEX suggest_norm_prefix ON geo.suggest_entry (norm text_pattern_ops);
CREATE INDEX suggest_geom ON geo.suggest_entry USING gist (geom);
CREATE INDEX suggest_ref ON geo.suggest_entry (ref);
CREATE INDEX suggest_rank ON geo.suggest_entry (weight DESC, length(norm));
ANALYZE geo.suggest_entry;
"""


def main() -> None:
    t0 = time.time()
    with psycopg.connect(settings().pg_dsn) as conn:
        conn.execute(SQL)
        rows = conn.execute("SELECT kind, count(*) FROM geo.suggest_entry GROUP BY kind ORDER BY kind").fetchall()
    print("suggest_entry:", dict(rows), f"({time.time() - t0:.0f}s)")


if __name__ == "__main__":
    main()
