"""Phân giải địa chỉ thành toạ độ theo cascade, mỗi tầng có mức và độ tin cậy.

Thứ tự: số nhà khớp đúng → nội suy số nhà trên cùng đường → đường trong xã → địa danh (thôn/xóm, toà nhà,
khu công nghiệp...) → tâm xã → tâm tỉnh. Tầng điểm giao thành công (dữ liệu công ty) sẽ đứng đầu khi có.
Tìm kiếm luôn giới hạn quanh tâm xã, bán kính tính từ diện tích xã.
"""

from __future__ import annotations

import math
import re
from dataclasses import asdict, dataclass, field

from psycopg import Connection

from bds.admin.resolve import AdminMatch, resolve_admin
from bds.geocode.street_parser import HAMLET_WORDS, PLACE_WORDS, StreetParts, parse_street_part
from bds.text.normalize import fold, normalize_address, street_key

# Hệ số theo cách nhận diện hành chính: địa chỉ cũ phải chuyển đổi hoặc chỉ biết tỉnh thì kém chắc chắn hơn.
ADMIN_FACTOR = {"new": 1.0, "legacy_converted": 0.9, "province_only": 0.6, "none": 0.3}
FUZZY_STREET = 0.55
FUZZY_PLACE = 0.5
FUZZY_HAMLET = 0.6
WIDEN_FACTOR = 3.0
MAX_INTERPOLATION_GAP_M = 1500.0


@dataclass
class GeocodeResult:
    lat: float | None
    lon: float | None
    level: str
    confidence: float
    source: str
    admin: dict
    components: dict
    query_normalized: str
    notes: list[str] = field(default_factory=list)
    matched_name: str | None = None  # tên gốc (có dấu) của đường/địa danh đã khớp, dùng cho formatted_address
    parser: str = "rule"             # ứng viên được chọn: rule | tagger
    features: dict = field(default_factory=dict, repr=False)  # đặc trưng cho mô hình quyết định
    trace: dict | None = None        # chỉ có khi gọi với trace=True (API giải thích từng tầng)

    def to_dict(self) -> dict:
        d = asdict(self)
        d.pop("features")
        if d["trace"] is None:
            d.pop("trace")
        return d


def search_radius_m(admin: AdminMatch) -> float:
    if admin.ward_area_km2:
        return max(1500.0, math.sqrt(admin.ward_area_km2 / math.pi) * 1000 * 1.6)
    return 60_000.0 if admin.province else 0.0


def _gap_m(a: dict, b: dict) -> float:
    dx = (b["lon"] - a["lon"]) * 111_320 * math.cos(math.radians((a["lat"] + b["lat"]) / 2))
    dy = (b["lat"] - a["lat"]) * 110_570
    return math.hypot(dx, dy)


def _strip_admin_tail(address: str, admin: AdminMatch) -> str:
    """Khi thư viện chỉ nhận ra tỉnh mà không trả phần còn lại: bỏ các cụm cuối là tên tỉnh/xã đã nhận."""
    names = [fold(n) for n in (admin.province, admin.ward) if n]
    chunks = [c.strip() for c in address.split(",") if c.strip()]
    while chunks and any(fold(chunks[-1]) and (fold(chunks[-1]) in n or n.endswith(fold(chunks[-1])))
                         for n in names):
        chunks.pop()
    return ", ".join(chunks)


# Từ chỉ đơn vị hành chính còn sót ở cuối phần đường khi khách gõ không dấu phẩy: "59 nguyen hue p ben nghe q1"
# → phần đường còn "nguyen hue p".
_DANGLING_ADMIN = re.compile(r"(?:\s+(?:p|q|x|h|tp|tx|tt|phuong|quan|huyen|xa|thi tran|thi xa|thanh pho))+$")
_WARD_PREFIX = re.compile(r"^(?:phuong|xa|dac khu|thi tran)\s+")
_HAMLET_PREFIX = re.compile(rf"^(?:{'|'.join(HAMLET_WORDS)})\s+")


def _drop_dangling_admin(text: str) -> str:
    return ", ".join(_DANGLING_ADMIN.sub("", chunk.strip()) for chunk in text.split(","))


def _parts_dict(p: StreetParts) -> dict:
    return {"house_no": p.house_no, "alleys": p.alleys, "street": p.street, "hamlet": p.hamlet,
            "place": p.place, "place_type": p.place_type}


def _same_parts(a: StreetParts, b: StreetParts) -> bool:
    """Hai cách hiểu cho cùng thành phần dùng để tìm vị trí (số nhà, ngõ, đường, thôn, địa danh)."""
    key = lambda p: (p.house_no, [tuple(x) for x in p.alleys], p.street and street_key(p.street), p.hamlet,
                     p.place)
    return key(a) == key(b)


def _deg(meters: float) -> float:
    return meters / 111_000.0


class Geocoder:
    def __init__(self, conn: Connection):
        self.conn = conn

    def geocode(self, address: str, tagger=None, decision=None, trace: bool = False) -> GeocodeResult:
        """Tầng 1 (luật) luôn chạy. Có `tagger` thì thêm ứng viên từ tagger ML; có `decision` thì mô hình quyết
        định chọn ứng viên và độ tin cậy trả về là xác suất đã hiệu chỉnh P(đúng trong 200 m)."""
        admin, tagged, candidates = self.candidates(address, tagger)
        chosen = candidates[0][2]
        scores = None
        if decision is not None and admin.lat is not None:
            scores = [decision.probability(r.features) for _, _, r in candidates]
            chosen = candidates[max(range(len(candidates)), key=scores.__getitem__)][2]
            chosen.confidence = round(max(scores), 3)
        if trace:
            chosen.trace = {
                "normalized": normalize_address(address),
                "admin": {"source": admin.source, "ward": admin.ward, "province": admin.province,
                          "street_text": admin.street_text},
                "tagger": {"tokens": tagged.tokens, "labels": tagged.labels, "probs": tagged.probs,
                           "confidence": tagged.confidence} if tagged else None,
                "candidates": [{"parser": n, "parts": _parts_dict(pp), "level": r.level, "lat": r.lat, "lon": r.lon,
                                "matched_name": r.matched_name,
                                "probability": round(scores[i], 3) if scores else None,
                                "heuristic_confidence": r.features.get("heuristic_conf")}
                               for i, (n, pp, r) in enumerate(candidates)],
                "chosen": chosen.parser,
                "decision_model": decision is not None,
            }
        return chosen

    def candidates(self, address: str, tagger=None):
        """Mọi cách hiểu của địa chỉ (luật, và tagger nếu khác luật), mỗi cách đã chạy cascade, kèm đặc trưng."""
        admin = resolve_admin(address)
        street_text = admin.street_text or (_strip_admin_tail(address, admin) if admin.province else "")
        normalized_street = _drop_dangling_admin(normalize_address(street_text)) if street_text else ""
        rule_parts = parse_street_part(normalized_street) if normalized_street else StreetParts()
        if normalized_street in PLACE_WORDS and admin.ward:
            # "KCN Quế Võ, Bắc Ninh": thư viện hành chính đã dùng "Quế Võ" để nhận ra phường, chỉ còn lại "kcn".
            # Khi phần còn lại chỉ là loại địa danh thì lấy tên xã/phường làm tên địa danh.
            rule_parts.place_type, rule_parts.place = normalized_street, _WARD_PREFIX.sub("", fold(admin.ward))

        candidates = [("rule", rule_parts, self._resolve(address, admin, rule_parts))]
        tagged = tagger.tag(address) if tagger is not None and admin.lat is not None else None
        tagger_parts = tagged.to_parts() if tagged else None
        agree = tagger_parts is None or _same_parts(rule_parts, tagger_parts)
        if tagged and not agree:
            candidates.append(("tagger", tagger_parts, self._resolve(address, admin, tagger_parts)))
        for name, _, result in candidates:
            result.parser = name
            result.features.update({"parser": name, "agree": agree, "admin_source": admin.source,
                                    "tagger_conf": tagged.confidence if tagged else -1.0,
                                    "ward_area_km2": admin.ward_area_km2 or 0.0})

        return admin, tagged, candidates

    def _resolve(self, address: str, admin: AdminMatch, parts: StreetParts) -> GeocodeResult:
        """Cascade cho một cách hiểu (parts) của địa chỉ."""
        base = {
            "admin": {k: getattr(admin, k) for k in ("province", "province_code", "ward", "ward_code", "source")},
            "components": {"house_no": parts.house_no, "alleys": parts.alleys, "street": parts.street,
                           "hamlet": parts.hamlet, "place": parts.place, "place_type": parts.place_type},
            "query_normalized": normalize_address(address),
        }
        if admin.lat is None:
            return GeocodeResult(None, None, "NOT_FOUND", 0.0, "none", notes=["không nhận ra tỉnh/xã"],
                                 features={"level": "NOT_FOUND"}, **base)
        has = {"has_house": bool(parts.house_no), "has_alley": bool(parts.alleys), "has_street": bool(parts.street),
               "has_hamlet": bool(parts.hamlet), "has_place": bool(parts.place)}

        factor = ADMIN_FACTOR.get(admin.source, 0.3)
        radius = search_radius_m(admin)
        center = (admin.lon, admin.lat)

        attempts = [(t, radius, 1.0, None) for t in (self._exact_address, self._interpolate, self._street,
                                                    self._place)]
        # Tâm xã có thể nằm xa khu dân cư (đặc khu, xã rộng): thử lại với bán kính lớn hơn, kém tin cậy hơn.
        wide = min(radius * WIDEN_FACTOR, 60_000.0)
        attempts += [(t, wide, 0.7, "đã mở rộng bán kính tìm") for t in (self._street, self._place)]
        for tier, r, penalty, widen_note in attempts:
            hit = tier(parts, center, r)
            if hit:
                lon, lat, level, conf, source, note, name, feat = hit
                notes = [n for n in (note, widen_note) if n]
                conf = round(conf * factor * penalty, 3)
                return GeocodeResult(lat, lon, level, conf, source, notes=notes, matched_name=name,
                                     features={"level": level, "source": source, "widened": penalty < 1,
                                               "heuristic_conf": conf, **has, **feat}, **base)

        if admin.ward_code:
            conf = round(0.3 * factor, 3)
            return GeocodeResult(admin.lat, admin.lon, "WARD_CENTROID", conf, "admin_unit",
                                 features={"level": "WARD_CENTROID", "heuristic_conf": conf, **has}, **base)
        return GeocodeResult(admin.lat, admin.lon, "PROVINCE_CENTROID", 0.15, "admin_unit",
                             features={"level": "PROVINCE_CENTROID", "heuristic_conf": 0.15, **has}, **base)

    # ---------- các tầng ----------
    def _exact_address(self, parts: StreetParts, center, radius):
        if not (parts.house_no and parts.street):
            return None
        row = self.conn.execute(
            """
            SELECT ST_X(geom) lon, ST_Y(geom) lat, similarity(street_key, %(k)s) sim, street
            FROM geo.address_point
            WHERE NOT holdout AND lower(housenumber) = %(hn)s
              AND (street_key = %(k)s OR similarity(street_key, %(k)s) > %(t)s)
              AND ST_DWithin(geom, ST_SetSRID(ST_MakePoint(%(x)s, %(y)s), 4326), %(r)s)
            ORDER BY (street_key = %(k)s) DESC, sim DESC,
                     geom <-> ST_SetSRID(ST_MakePoint(%(x)s, %(y)s), 4326)
            LIMIT 1
            """,
            {"hn": parts.house_no, "k": street_key(parts.street), "t": FUZZY_STREET, "x": center[0], "y": center[1],
             "r": _deg(radius)},
        ).fetchone()
        if not row:
            return None
        conf = 0.9 if row["sim"] >= 0.99 else 0.8
        # Có ngõ/ngách thì số nhà nằm trong ngõ, không phải mặt đường: hạ mức.
        if parts.alleys:
            return (row["lon"], row["lat"], "RANGE_INTERPOLATED", 0.6, "osm_address", "số nhà khớp nhưng địa chỉ có ngõ",
                    row["street"], {"street_sim": row["sim"]})
        return row["lon"], row["lat"], "ROOFTOP", conf, "osm_address", None, row["street"], {"street_sim": row["sim"]}

    def _interpolate(self, parts: StreetParts, center, radius):
        n = parts.house_number_value
        if n is None or not parts.street or parts.alleys:
            return None
        rows = self.conn.execute(
            """
            SELECT house_num, ST_X(geom) lon, ST_Y(geom) lat, street
            FROM geo.address_point
            WHERE NOT holdout AND house_num IS NOT NULL AND street_key = %(k)s
              AND house_num BETWEEN %(n)s - 60 AND %(n)s + 60
              AND ST_DWithin(geom, ST_SetSRID(ST_MakePoint(%(x)s, %(y)s), 4326), %(r)s)
            """,
            {"k": street_key(parts.street), "n": n, "x": center[0], "y": center[1], "r": _deg(radius)},
        ).fetchall()
        if not rows:
            return None
        same_side = [r for r in rows if r["house_num"] % 2 == n % 2] or rows
        lower = max((r for r in same_side if r["house_num"] <= n), key=lambda r: r["house_num"], default=None)
        upper = min((r for r in same_side if r["house_num"] >= n), key=lambda r: r["house_num"], default=None)
        if (lower and upper and upper["house_num"] != lower["house_num"]
                and _gap_m(lower, upper) <= MAX_INTERPOLATION_GAP_M):
            t = (n - lower["house_num"]) / (upper["house_num"] - lower["house_num"])
            lon = lower["lon"] + t * (upper["lon"] - lower["lon"])
            lat = lower["lat"] + t * (upper["lat"] - lower["lat"])
            return (lon, lat, "RANGE_INTERPOLATED", 0.75, "osm_address_interpolated", None, lower["street"],
                    {"street_sim": 1.0, "interp_gap_m": _gap_m(lower, upper),
                     "num_gap": upper["house_num"] - lower["house_num"]})
        near = lower or upper
        if near and abs(near["house_num"] - n) <= 20:
            return (near["lon"], near["lat"], "RANGE_INTERPOLATED", 0.6, "osm_address_nearest", None, near["street"],
                    {"street_sim": 1.0, "num_gap": abs(near["house_num"] - n)})
        return None

    def _street(self, parts: StreetParts, center, radius):
        # "to hieu" có thể là "tổ Hiệu" hoặc phố "Tô Hiệu" (bỏ dấu thì giống nhau): không có tên đường thì thử
        # phần thôn/tổ như một tên đường, trừ khi sau chữ chỉ loại là số ("tổ 4").
        keys = [(parts.street, FUZZY_STREET)] if parts.street else []
        if not keys and parts.hamlet and not re.match(r"^\S+\s+\d", parts.hamlet):
            keys.append((parts.hamlet, 1.01))  # chỉ nhận tên đường khớp đúng, không khớp gần đúng
        for key, threshold in keys:
            hit = self._street_key(key, center, radius, threshold)
            if hit:
                return hit
        return None

    def _street_key(self, street: str, center, radius, threshold: float = FUZZY_STREET):
        row = self.conn.execute(
            """
            WITH c AS (SELECT ST_SetSRID(ST_MakePoint(%(x)s, %(y)s), 4326) AS g),
            m AS (
              SELECT s.geom, s.name, (s.street_key = %(k)s) exact, similarity(s.street_key, %(k)s) sim
              FROM geo.street s, c
              WHERE (s.street_key = %(k)s OR s.street_key %% %(k)s)
                AND ST_DWithin(s.geom, c.g, %(r)s)
            ),
            best AS (SELECT * FROM m WHERE exact OR sim > %(t)s ORDER BY exact DESC, sim DESC LIMIT 200),
            pick AS (SELECT bool_or(exact) exact, max(sim) sim, ST_Collect(geom) g,
                            mode() WITHIN GROUP (ORDER BY name) AS name FROM best
                     WHERE exact = (SELECT bool_or(exact) FROM best))
            SELECT ST_X(p) lon, ST_Y(p) lat, exact, sim, len_m, name
            FROM (SELECT ST_ClosestPoint(pick.g, c.g) p, exact, sim, ST_Length(pick.g::geography) len_m, name
                  FROM pick, c WHERE pick.g IS NOT NULL) q
            """,
            {"k": street_key(street), "t": threshold, "x": center[0], "y": center[1], "r": _deg(radius)},
        ).fetchone()
        if not row or row["lon"] is None:
            return None
        # Đường càng dài thì điểm chọn (gần tâm xã nhất) càng có thể xa địa chỉ thật.
        conf = 0.5 if row["len_m"] < 1500 else 0.4 if row["len_m"] < 4000 else 0.3
        if not row["exact"]:
            conf -= 0.1
        return (row["lon"], row["lat"], "STREET", conf, "osm_street", f"đường khớp dài {row['len_m']:.0f} m",
                row["name"], {"street_sim": row["sim"] if not row["exact"] else 1.0, "street_len_m": row["len_m"]})

    def _place(self, parts: StreetParts, center, radius):
        if parts.hamlet:
            hit = self._hamlet(parts.hamlet, center, radius)
            if hit:
                return hit
        names = [parts.place] if parts.place else []
        if parts.place and parts.place_type:
            names.insert(0, f"{parts.place_type} {parts.place}")
        for name in names:
            row = self.conn.execute(
                """
                SELECT ST_X(geom) lon, ST_Y(geom) lat, similarity(name_norm, %(n)s) sim, name
                FROM geo.place
                WHERE name_norm %% %(n)s
                  AND ST_DWithin(geom, ST_SetSRID(ST_MakePoint(%(x)s, %(y)s), 4326), %(r)s)
                ORDER BY sim DESC, geom <-> ST_SetSRID(ST_MakePoint(%(x)s, %(y)s), 4326)
                LIMIT 1
                """,
                {"n": name, "x": center[0], "y": center[1], "r": _deg(radius)},
            ).fetchone()
            if row and row["sim"] >= FUZZY_PLACE:
                return (row["lon"], row["lat"], "PLACE", 0.55 if row["sim"] > 0.8 else 0.45, "osm_place", name,
                        row["name"], {"place_sim": row["sim"]})
        return None

    def _hamlet(self, hamlet: str, center, radius):
        """Thôn/xóm/ấp: ưu tiên tên khớp đúng (có hoặc không có chữ chỉ loại). Khớp gần đúng phải đạt ngưỡng
        chặt hơn địa danh thường, vì "thôn Đông" so với "Đồng Tháp" đã giống nhau 0,54."""
        bare = _HAMLET_PREFIX.sub("", hamlet)
        row = self.conn.execute(
            """
            SELECT ST_X(geom) lon, ST_Y(geom) lat, name FROM geo.place
            WHERE (name_norm IN (%(full)s, %(bare)s) OR name_norm %% %(full)s)
              AND ST_DWithin(geom, ST_SetSRID(ST_MakePoint(%(x)s, %(y)s), 4326), %(r)s)
            ORDER BY (name_norm IN (%(full)s, %(bare)s)) DESC, similarity(name_norm, %(full)s) DESC,
                     geom <-> ST_SetSRID(ST_MakePoint(%(x)s, %(y)s), 4326)
            LIMIT 1
            """,
            {"full": hamlet, "bare": bare, "x": center[0], "y": center[1], "r": _deg(radius)},
        ).fetchone()
        if not row:
            return None
        exact = fold(row["name"]) in (hamlet, bare)
        sim = self.conn.execute("SELECT similarity(%s, %s) s", (fold(row["name"]), hamlet)).fetchone()["s"]
        if not exact and sim < FUZZY_HAMLET:
            return None
        return (row["lon"], row["lat"], "PLACE", 0.55 if exact else 0.45, "osm_place", hamlet, row["name"],
                {"place_sim": 1.0 if exact else sim, "hamlet_match": True})
