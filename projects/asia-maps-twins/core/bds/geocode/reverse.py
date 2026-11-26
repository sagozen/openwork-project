"""Phân giải ngược: toạ độ → địa chỉ, theo thứ tự chính xác giảm dần (giống Google trả nhiều kết quả).

Điểm có số nhà trong 40 m → đoạn đường có tên trong 150 m → xã gần nhất → tỉnh của xã đó.
Chưa có ranh giới xã dạng polygon nên xã được chọn theo tâm gần nhất; vùng giáp ranh có thể sai xã.
"""

from __future__ import annotations

from dataclasses import dataclass

from psycopg import Connection


@dataclass
class ReverseHit:
    kind: str                 # address | street | ward | province
    lat: float
    lon: float
    house_no: str | None
    street: str | None
    ward: str
    ward_code: str
    province: str
    province_code: str
    distance_m: float


def reverse_geocode(conn: Connection, lat: float, lon: float) -> list[ReverseHit]:
    p = {"x": lon, "y": lat}
    ward = conn.execute(
        """
        SELECT w.code, w.name, ST_Y(w.geom) lat, ST_X(w.geom) lon, p.code pcode, p.name pname,
               ST_Y(p.geom) plat, ST_X(p.geom) plon
        FROM geo.admin_unit w JOIN geo.admin_unit p ON p.code = w.parent_code
        WHERE w.level = 2
        ORDER BY w.geom <-> ST_SetSRID(ST_MakePoint(%(x)s, %(y)s), 4326) LIMIT 1
        """, p).fetchone()
    if not ward:
        return []
    admin = {"ward": ward["name"], "ward_code": ward["code"], "province": ward["pname"],
             "province_code": ward["pcode"]}
    hits: list[ReverseHit] = []

    addr = conn.execute(
        """
        SELECT housenumber, street, ST_Y(geom) lat, ST_X(geom) lon,
               ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint(%(x)s, %(y)s), 4326)::geography) d
        FROM geo.address_point
        WHERE street IS NOT NULL AND ST_DWithin(geom, ST_SetSRID(ST_MakePoint(%(x)s, %(y)s), 4326), 0.0005)
        ORDER BY geom <-> ST_SetSRID(ST_MakePoint(%(x)s, %(y)s), 4326) LIMIT 1
        """, p).fetchone()
    if addr and addr["d"] <= 40:
        hits.append(ReverseHit("address", addr["lat"], addr["lon"], addr["housenumber"], addr["street"],
                               distance_m=addr["d"], **admin))

    street = conn.execute(
        """
        SELECT name, ST_Y(cp) lat, ST_X(cp) lon,
               ST_Distance(cp::geography, ST_SetSRID(ST_MakePoint(%(x)s, %(y)s), 4326)::geography) d
        FROM (SELECT name, ST_ClosestPoint(geom, ST_SetSRID(ST_MakePoint(%(x)s, %(y)s), 4326)) cp
              FROM geo.street
              WHERE ST_DWithin(geom, ST_SetSRID(ST_MakePoint(%(x)s, %(y)s), 4326), 0.002)
              ORDER BY geom <-> ST_SetSRID(ST_MakePoint(%(x)s, %(y)s), 4326) LIMIT 1) s
        """, p).fetchone()
    if street and street["d"] <= 150:
        hits.append(ReverseHit("street", street["lat"], street["lon"], None, street["name"],
                               distance_m=street["d"], **admin))

    hits.append(ReverseHit("ward", ward["lat"], ward["lon"], None, None, distance_m=0, **admin))
    hits.append(ReverseHit("province", ward["plat"], ward["plon"], None, None, distance_m=0, **admin))
    return hits
