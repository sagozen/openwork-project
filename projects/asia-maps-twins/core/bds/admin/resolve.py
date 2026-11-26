"""Nhận diện đơn vị hành chính (2 cấp mới) trong chuỗi địa chỉ, kể cả địa chỉ cũ 3 cấp.

Dùng lại thư viện `vietnamadminunits` (MIT) cho phần so khớp tên và bảng chuyển đổi 2025.
Quy tắc chọn nhánh: chuỗi có dấu hiệu cấp huyện (quận/huyện/thị xã/q.1...) → parse kiểu cũ rồi chuyển
sang đơn vị mới; ngược lại → parse kiểu mới. Nếu nhánh được chọn không ra xã thì thử nhánh còn lại.
"""

from __future__ import annotations

import os
import re
import sqlite3
from dataclasses import dataclass
from functools import lru_cache

import vietnamadminunits
from vietnamadminunits import ParseMode, convert_address, parse_address

from bds.text.normalize import fold

_DISTRICT_MARKER = re.compile(r"\b(?:quan|huyen|thi xa|q\s*\.?\s*\d+|h\s*\.)\b")


@dataclass
class AdminMatch:
    province: str | None
    province_code: str | None
    ward: str | None
    ward_code: str | None
    lat: float | None
    lon: float | None
    ward_area_km2: float | None
    source: str              # new | legacy_converted | province_only | none
    street_text: str | None  # phần còn lại dưới cấp xã (có dấu, như người dùng gõ)
    confidence: float        # độ tin cậy của phần hành chính


@lru_cache
def _ward_meta() -> dict[str, tuple[float, float, float]]:
    """ward_code -> (lat, lon, diện tích km²) của đơn vị mới."""
    db = os.path.join(os.path.dirname(vietnamadminunits.__file__), "data", "dataset.db")
    with sqlite3.connect(db) as c:
        return {code: (lat, lon, area) for code, lat, lon, area in
                c.execute("SELECT wardCode, wardLat, wardLon, wardAreaKm2 FROM admin_units")}


@lru_cache
def _province_meta() -> dict[str, tuple[str, float, float]]:
    db = os.path.join(os.path.dirname(vietnamadminunits.__file__), "data", "dataset.db")
    with sqlite3.connect(db) as c:
        return {code: (name, lat, lon) for code, name, lat, lon in
                c.execute("SELECT DISTINCT provinceCode, province, provinceLat, provinceLon FROM admin_units")}


def _from_unit(unit, source: str, street: str | None, confidence: float) -> AdminMatch:
    if unit.ward_code:
        lat, lon, area = _ward_meta().get(unit.ward_code, (unit.latitude, unit.longitude, None))
    else:
        lat, lon, area = None, None, None
        if unit.province_code and unit.province_code in _province_meta():
            _, lat, lon = _province_meta()[unit.province_code]
        source = "province_only" if unit.province else "none"
    return AdminMatch(unit.province, unit.province_code, unit.ward, unit.ward_code, lat, lon, area,
                      source, street, confidence if unit.ward_code else (0.3 if unit.province else 0.0))


def resolve_admin(address: str) -> AdminMatch:
    folded = fold(address)
    legacy_first = bool(_DISTRICT_MARKER.search(folded))

    new = parse_address(address, mode=ParseMode.FROM_2025, keep_street=True)
    legacy = parse_address(address, mode=ParseMode.LEGACY, keep_street=True)

    def converted() -> AdminMatch | None:
        if not legacy.ward:
            return None
        try:
            unit = convert_address(address)
        except Exception:  # noqa: BLE001 — thư viện ném nhiều loại lỗi khi không chuyển được
            return None
        if not unit or not unit.ward_code:
            return None
        # Xã cũ có thể bị chia cho nhiều xã mới; thư viện chọn một, nên độ tin cậy thấp hơn nhánh mới.
        return _from_unit(unit, "legacy_converted", legacy.street, 0.75)

    if legacy_first:
        match = converted()
        if match:
            return match
        if new.ward:
            return _from_unit(new, "new", new.street, 0.7)
    else:
        if new.ward:
            return _from_unit(new, "new", new.street, 0.9)
        match = converted()
        if match:
            return match
    base = new if new.province else legacy
    return _from_unit(base, "province_only", base.street, 0.3)
