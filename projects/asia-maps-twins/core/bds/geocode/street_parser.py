"""Tách phần dưới cấp xã của địa chỉ: số nhà, ngõ/ngách/hẻm/kiệt, tên đường, thôn/xóm/ấp, toà nhà/khu.

Đầu vào là phần còn lại sau khi đã nhận diện đơn vị hành chính, đã chuẩn hoá bằng `normalize_address`.
Bộ tách bằng luật này là vòng 1; tagger học máy sẽ thay khi có nhãn từ vận hành.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

ALLEY_WORDS = ("ngo", "ngach", "hem", "kiet", "hxh")
HAMLET_WORDS = ("to dan pho", "khu pho", "thon", "xom", "ap", "ban", "bon", "buon", "khom", "to", "khu", "cum")
PLACE_WORDS = (
    "khu cong nghiep", "khu che xuat", "khu do thi", "chung cu cao cap", "chung cu", "toa nha", "toa",
    "cho", "truong", "benh vien", "ben xe", "sieu thi", "trung tam thuong mai", "tttm", "nha may", "cong ty",
    "khach san", "uy ban", "ubnd", "cong vien", "ga",
)
NUMBER = r"\d+[a-z]?(?:[/\-]\d+[a-z]?)*"

_RE_HOUSE = re.compile(rf"^(?:so nha|so|nha so|nha)?\s*({NUMBER})\b\s*(.*)$")
_RE_ALLEY = re.compile(rf"\b({'|'.join(ALLEY_WORDS)})\s+(?:so\s+)?({NUMBER})")
_RE_HAMLET = re.compile(rf"^({'|'.join(HAMLET_WORDS)})\s+(.+)$")
_RE_PLACE = re.compile(rf"^({'|'.join(PLACE_WORDS)})\s+(.+)$")
_RE_STREET = re.compile(r"^(?:duong|pho|dai lo)\s+(.+)$")
_RE_STREET_INSIDE = re.compile(r"^(.*?)\s+(?:duong|pho|dai lo)\s+(.+)$")


@dataclass
class StreetParts:
    house_no: str | None = None
    alleys: list[tuple[str, str]] = field(default_factory=list)  # [(loại, số)]
    street: str | None = None
    hamlet: str | None = None
    place: str | None = None
    place_type: str | None = None
    residual: list[str] = field(default_factory=list)

    @property
    def house_number_value(self) -> int | None:
        """Số nhà dạng số nguyên để nội suy (lấy phần số đầu tiên)."""
        if not self.house_no:
            return None
        m = re.match(r"\d+", self.house_no)
        return int(m.group()) if m else None


def parse_street_part(text: str) -> StreetParts:
    """`text` đã chuẩn hoá (fold + mở viết tắt), có thể gồm nhiều cụm ngăn bằng dấu phẩy."""
    parts = StreetParts()
    chunks = [c.strip() for c in text.split(",") if c.strip()]
    for chunk in chunks:
        _parse_chunk(chunk, parts)
    return parts


def _parse_chunk(chunk: str, parts: StreetParts) -> None:
    rest = chunk

    # Số nhà ở đầu cụm (kể cả dạng hẻm miền Nam 123/45/6).
    if parts.house_no is None:
        m = _RE_HOUSE.match(rest)
        if m and (m.group(2) or "/" in m.group(1) or parts.street is None):
            parts.house_no, rest = m.group(1), m.group(2).strip()

    # Ngõ / ngách / hẻm / kiệt kèm số.
    alleys = _RE_ALLEY.findall(rest)
    if alleys:
        parts.alleys.extend(alleys)
        rest = _RE_ALLEY.sub(" ", rest).strip()
        if parts.house_no is None:
            m = re.match(rf"^({NUMBER})\s+(.*)$", rest)
            if m:
                parts.house_no, rest = m.group(1), m.group(2)
    rest = re.sub(r"\s+", " ", rest).strip()
    if not rest:
        return

    if (m := _RE_PLACE.match(rest)) and parts.place is None:
        parts.place_type, parts.place = m.group(1), m.group(2)
        return
    if _RE_HAMLET.match(rest) and parts.hamlet is None:
        parts.hamlet = rest
        return
    if (m := _RE_STREET.match(rest)) and parts.street is None:
        parts.street = m.group(1)
        return
    # Mã lô/căn đứng trước tên đường: "lkn - 12 duong 2b" -> số nhà "lkn-12", đường "2b".
    if (m := _RE_STREET_INSIDE.search(rest)) and parts.street is None:
        prefix = m.group(1).replace(" ", "")
        if parts.house_no is None and prefix:
            parts.house_no = prefix
        parts.street = m.group(2)
        return
    if parts.street is None and re.search(r"[a-z]", rest):
        parts.street = rest
        return
    parts.residual.append(rest)
