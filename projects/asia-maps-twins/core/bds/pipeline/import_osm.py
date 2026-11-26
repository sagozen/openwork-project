"""Nạp đường có tên, điểm có số nhà và địa danh từ file OSM Việt Nam vào schema geo.

Một lượt đọc file .osm.pbf bằng pyosmium, ghi bằng COPY. Bảng là dẫn xuất: chạy lại sẽ xoá và nạp lại.
"""

from __future__ import annotations

import re
import time

import osmium
import psycopg

from bds.config import settings
from bds.text.normalize import fold, street_key

ROAD_TYPES = {
    "motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "living_street",
    "service", "pedestrian", "track", "road", "motorway_link", "trunk_link", "primary_link", "secondary_link",
    "tertiary_link",
}
PLACE_VALUES = {"city", "town", "village", "hamlet", "isolated_dwelling", "neighbourhood", "quarter", "suburb",
                "locality", "square", "island", "islet"}
POI_KEYS = ("amenity", "shop", "office", "tourism", "healthcare", "leisure", "public_transport", "craft",
            "man_made", "historic", "aeroway", "railway")
LANDUSE_VALUES = {"industrial", "residential", "commercial", "retail"}
ADDR_KEYS = ("addr:street", "addr:place", "addr:hamlet", "addr:subdistrict", "addr:district", "addr:city",
             "addr:province")
WKT = osmium.geom.WKTFactory()
_NUM = re.compile(r"\d+")


def place_kind(tags) -> str | None:
    if tags.get("place") in PLACE_VALUES:
        return "place:" + tags["place"]
    for key in POI_KEYS:
        if key in tags:
            return f"{key}:{tags[key]}"
    if tags.get("landuse") in LANDUSE_VALUES:
        return "landuse:" + tags["landuse"]
    if "building" in tags:
        return "building:" + tags["building"]
    return None


class Handler(osmium.SimpleHandler):
    """Chỉ gom dữ liệu vào bộ nhớ. Không ghi DB trong callback: COPY của psycopg chạy song song với luồng
    của osmium từng gây khoá chết (deadlock)."""

    def __init__(self):
        super().__init__()
        self.counts = {"street": 0, "address_point": 0, "place": 0}
        self.street_rows: list[tuple] = []
        self.address_rows: list[tuple] = []
        self.place_rows: list[tuple] = []

    # --- ghi ---
    def _address(self, osm_type: str, osm_id: int, tags, lon: float, lat: float) -> None:
        hn = tags.get("addr:housenumber")
        if not hn:
            return
        m = _NUM.search(hn)
        num = int(m.group()) if m and len(m.group()) <= 5 else None  # số nhà quá 5 chữ số là dữ liệu rác
        street = tags.get("addr:street")
        addr = {k: tags[k] for k in ADDR_KEYS if k in tags}
        self.address_rows.append((osm_type, osm_id, hn.strip()[:40], num, street,
                                  street_key(fold(street)) if street else None, _json(addr), osm_id % 5 == 0,
                                  f"SRID=4326;POINT({lon} {lat})"))
        self.counts["address_point"] += 1

    def _place(self, osm_type: str, osm_id: int, tags, lon: float, lat: float) -> None:
        name = tags.get("name") or tags.get("name:vi")
        kind = place_kind(tags) if name else None
        if not kind:
            return
        self.place_rows.append((osm_type, osm_id, kind, name, fold(name), f"SRID=4326;POINT({lon} {lat})"))
        self.counts["place"] += 1

    # --- callback pyosmium ---
    def node(self, n):
        if not n.tags:
            return
        loc = n.location
        self._address("n", n.id, n.tags, loc.lon, loc.lat)
        self._place("n", n.id, n.tags, loc.lon, loc.lat)

    def way(self, w):
        tags = w.tags
        hw = tags.get("highway")
        name = tags.get("name")
        try:
            if hw in ROAD_TYPES and name:
                self.street_rows.append((w.id, name, street_key(fold(name)), hw, "SRID=4326;" + WKT.create_linestring(w)))
                self.counts["street"] += 1
            if tags.get("addr:housenumber") or (name and place_kind(tags)):
                lons = [nd.lon for nd in w.nodes]
                lats = [nd.lat for nd in w.nodes]
                lon, lat = sum(lons) / len(lons), sum(lats) / len(lats)
                self._address("w", w.id, tags, lon, lat)
                self._place("w", w.id, tags, lon, lat)
        except (osmium.InvalidLocationError, RuntimeError):
            pass  # way thiếu node trong file cắt vùng


def _json(d: dict) -> str:
    import json
    return json.dumps(d, ensure_ascii=False)


def main() -> None:
    t0 = time.time()
    with psycopg.connect(settings().pg_dsn) as conn:
        conn.execute("TRUNCATE geo.street, geo.address_point, geo.place RESTART IDENTITY")
        h = Handler()
        h.apply_file(settings().osm_pbf, locations=True, idx="flex_mem")
        print("đã đọc file:", h.counts, f"({time.time() - t0:.0f}s)")
        cur = conn.cursor()
        with cur.copy("COPY geo.street (osm_id, name, street_key, highway, geom) FROM STDIN") as cp:
            for row in h.street_rows:
                cp.write_row(row)
        with cur.copy("COPY geo.address_point (osm_type, osm_id, housenumber, house_num, street, street_key, "
                        "addr, holdout, geom) FROM STDIN") as cp:
            for row in h.address_rows:
                cp.write_row(row)
        with cur.copy("COPY geo.place (osm_type, osm_id, kind, name, name_norm, geom) FROM STDIN") as cp:
            for row in h.place_rows:
                cp.write_row(row)
        print("đã nạp:", h.counts, f"({time.time() - t0:.0f}s)")
        print("dựng index...")
        for sql in (
            "CREATE INDEX IF NOT EXISTS street_geom ON geo.street USING gist (geom)",
            "CREATE INDEX IF NOT EXISTS street_key_trgm ON geo.street USING gin (street_key gin_trgm_ops)",
            "CREATE INDEX IF NOT EXISTS street_key_btree ON geo.street (street_key)",
            "CREATE INDEX IF NOT EXISTS address_geom ON geo.address_point USING gist (geom)",
            "CREATE INDEX IF NOT EXISTS address_street ON geo.address_point (street_key, house_num)",
            "CREATE INDEX IF NOT EXISTS place_geom ON geo.place USING gist (geom)",
            "CREATE INDEX IF NOT EXISTS place_name_trgm ON geo.place USING gin (name_norm gin_trgm_ops)",
        ):
            conn.execute(sql)
        conn.execute("ANALYZE geo.street; ANALYZE geo.address_point; ANALYZE geo.place")
    print(f"xong ({time.time() - t0:.0f}s)")


if __name__ == "__main__":
    main()
