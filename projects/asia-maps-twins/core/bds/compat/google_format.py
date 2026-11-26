"""Định dạng kết quả theo đúng cấu trúc JSON của Google Maps Platform (Web Service API bản legacy)."""

from __future__ import annotations

import math
import unicodedata

from psycopg import Connection

COUNTRY = {"long_name": "Việt Nam", "short_name": "VN", "types": ["country", "political"]}
# Sau sáp nhập 2025 chỉ còn 2 cấp. Xã/phường mang cả hai kiểu Google hay dùng cho cấp này ở Việt Nam,
# để client đọc theo kiểu nào cũng thấy; không còn administrative_area_level_2 (quận/huyện).
WARD_TYPES = ["administrative_area_level_3", "sublocality_level_1", "sublocality", "political"]
PROVINCE_TYPES = ["administrative_area_level_1", "political"]

LOCATION_TYPE = {
    "ROOFTOP": "ROOFTOP", "RANGE_INTERPOLATED": "RANGE_INTERPOLATED", "STREET": "GEOMETRIC_CENTER",
    "PLACE": "GEOMETRIC_CENTER", "WARD_CENTROID": "APPROXIMATE", "PROVINCE_CENTROID": "APPROXIMATE",
}
LEVEL_TYPES = {
    "ROOFTOP": ["street_address"], "RANGE_INTERPOLATED": ["street_address"], "STREET": ["route"],
    "PLACE": ["establishment", "point_of_interest"], "WARD_CENTROID": WARD_TYPES,
    "PROVINCE_CENTROID": PROVINCE_TYPES,
}
KIND_TYPES = {
    "province": PROVINCE_TYPES, "ward": WARD_TYPES, "street": ["route", "geocode"],
    "address": ["street_address", "geocode"], "place": ["establishment", "point_of_interest"],
}
# Bộ lọc `types` của Autocomplete → loại mục của base.
AUTOCOMPLETE_TYPES = {
    "geocode": {"province", "ward", "street", "address"},
    "address": {"street", "address"},
    "establishment": {"place"},
    "(regions)": {"province", "ward"},
    "(cities)": {"province", "ward"},
}
VIEWPORT_DELTA = {"ROOFTOP": 0.0014, "RANGE_INTERPOLATED": 0.002, "STREET": 0.005, "PLACE": 0.003,
                  "address": 0.0014, "street": 0.005, "place": 0.003, "province": 0.5}
ALLEY_LABEL = {"ngo": "Ngõ", "ngach": "Ngách", "hem": "Hẻm", "kiet": "Kiệt", "hxh": "Hẻm"}


def latlng(lat: float, lon: float) -> dict:
    return {"lat": round(lat, 7), "lng": round(lon, 7)}


def viewport(lat: float, lon: float, delta: float) -> dict:
    return {"northeast": latlng(lat + delta, lon + delta), "southwest": latlng(lat - delta, lon - delta)}


def ward_delta(area_km2: float | None) -> float:
    return max(0.005, math.sqrt(area_km2 or 4) / 111 / 2)


def bounds(points: list[tuple[float, float]]) -> dict:
    lats, lons = [p[0] for p in points], [p[1] for p in points]
    return {"northeast": latlng(max(lats), max(lons)), "southwest": latlng(min(lats), min(lons))}


def parse_latlng(text: str) -> tuple[float, float] | None:
    try:
        a, b = (float(x) for x in text.split(","))
    except ValueError:
        return None
    return (a, b) if -90 <= a <= 90 and -180 <= b <= 180 else None


def fmt_distance(meters: float, language: str = "vi") -> dict:
    value = round(meters)
    if value < 1000:
        text = f"{value} m"
    else:
        km = f"{meters / 1000:.1f}"
        text = (km if language.startswith("en") else km.replace(".", ",")) + " km"
    return {"text": text, "value": value}


def fmt_duration(seconds: float, language: str = "vi") -> dict:
    value = round(seconds)
    minutes = max(1, round(value / 60))
    days, rem = divmod(minutes, 1440)
    hours, mins = divmod(rem, 60)
    if language.startswith("en"):
        parts = [f"{days} day{'s' if days > 1 else ''}" if days else "",
                 f"{hours} hour{'s' if hours > 1 else ''}" if hours else "",
                 f"{mins} min{'s' if mins > 1 else ''}" if mins and not days else ""]
    else:
        parts = [f"{days} ngày" if days else "", f"{hours} giờ" if hours else "",
                 f"{mins} phút" if mins and not days else ""]
    return {"text": " ".join(p for p in parts if p), "value": value}


def _fold_char(c: str) -> str:
    if c in "đĐ":
        return "d"
    return unicodedata.normalize("NFKD", c)[0].lower()


def fold_same_length(text: str) -> str:
    """Bỏ dấu từng ký tự, giữ nguyên độ dài, để tính vị trí khớp trên chuỗi gốc."""
    return "".join(_fold_char(c) for c in text)


def matched_substrings(text: str, query: str) -> list[dict]:
    folded = fold_same_length(text)
    out, used = [], set()
    for token in fold_same_length(query).split():
        start = 0
        while (i := folded.find(token, start)) != -1:
            if (i == 0 or not folded[i - 1].isalnum()) and i not in used:
                out.append({"offset": i, "length": len(token)})
                used.add(i)
                break
            start = i + 1
    return sorted(out, key=lambda m: m["offset"])


def terms(label: str) -> list[dict]:
    out, offset = [], 0
    for part in label.split(", "):
        out.append({"offset": offset, "value": part})
        offset += len(part) + 2
    return out


def admin_names(conn: Connection, ward_code: str | None, province_code: str | None) -> dict:
    codes = [c for c in (ward_code, province_code) if c]
    rows = conn.execute("SELECT code, name, name_short, area_km2 FROM geo.admin_unit WHERE code = ANY(%s)",
                        (codes,)).fetchall() if codes else []
    return {r["code"]: r for r in rows}


def address_components(conn: Connection, *, house_no: str | None, route: str | None,
                       ward_code: str | None, province_code: str | None) -> list[dict]:
    names = admin_names(conn, ward_code, province_code)
    comps = []
    if house_no:
        comps.append({"long_name": house_no, "short_name": house_no, "types": ["street_number"]})
    if route:
        comps.append({"long_name": route, "short_name": route, "types": ["route"]})
    if ward_code in names:
        w = names[ward_code]
        comps.append({"long_name": w["name"], "short_name": w["name_short"], "types": WARD_TYPES})
    if province_code in names:
        p = names[province_code]
        comps.append({"long_name": p["name"], "short_name": p["name_short"], "types": PROVINCE_TYPES})
    comps.append(COUNTRY)
    return comps


def house_text(house_no: str | None, alleys: list) -> str | None:
    parts = [house_no.upper() if house_no and not house_no.isdigit() else house_no] if house_no else []
    parts += [f"{ALLEY_LABEL.get(kind, kind.title())} {num}" for kind, num in alleys]
    return " ".join(p for p in parts if p) or None


def formatted_address(*parts: str | None) -> str:
    return ", ".join([p for p in parts if p] + ["Việt Nam"])
