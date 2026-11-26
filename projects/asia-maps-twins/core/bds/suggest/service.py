"""Gợi ý địa chỉ khi đang gõ (interface SuggestIndex, bản PostgreSQL pg_trgm).

Hai bước:
1. Lấy ứng viên trong DB: khớp tiền tố (index btree) + gần nhất theo word-similarity (KNN trên index GiST),
   nên ứng viên luôn là các mục khớp tốt nhất chứ không phải một tập bất kỳ.
2. Xếp hạng lại trong Python: tỉ lệ từ khoá của câu gõ có mặt trong mục (từ cuối được khớp tiền tố vì
   người dùng đang gõ dở), độ khớp trigram, khớp tiền tố, trọng số loại mục, khoảng cách tới điểm tham chiếu.
"""

from __future__ import annotations

import math
import re
from dataclasses import asdict, dataclass
from typing import Protocol

from psycopg import Connection

from bds.text.normalize import normalize_address

CANDIDATES = 80
_COLUMNS = ("e.id, e.ref, e.label, e.norm, e.kind, e.weight, ST_Y(e.geom) lat, ST_X(e.geom) lon, e.ward_code, "
            "e.province_code, word_similarity(%(q)s, e.norm) ws")
_TOKEN_CHARS = re.compile(r"[^a-z0-9]+")


def _tsquery(tokens: list[str]) -> str:
    """Mọi từ phải có; từ cuối (đang gõ dở) khớp tiền tố. Chỉ giữ chữ và số để tsquery luôn hợp lệ."""
    clean = [t for t in (_TOKEN_CHARS.sub("", tok) for tok in tokens) if t]
    if not clean:
        return ""
    *full, last = clean
    return " & ".join(full + [f"{last}:*"])


@dataclass
class Suggestion:
    ref: str
    label: str
    kind: str
    lat: float
    lon: float
    ward_code: str | None
    province_code: str | None
    score: float

    def to_dict(self) -> dict:
        return asdict(self)


class SuggestIndex(Protocol):
    def suggest(self, q: str, limit: int = 10, near: tuple[float, float] | None = None,
                province_code: str | None = None) -> list[Suggestion]: ...


def coverage(tokens: list[str], norm: str) -> float:
    """Tỉ lệ từ khoá có mặt trong mục; từ cuối chỉ cần là tiền tố của một từ trong mục."""
    if not tokens:
        return 0.0
    words = norm.split()
    word_set = set(words)
    hit = sum(1 for t in tokens[:-1] if t in word_set)
    last = tokens[-1]
    hit += 1 if any(w.startswith(last) for w in words) else 0
    return hit / len(tokens)


def leading_match(tokens: list[str], norm: str) -> float:
    """Tỉ lệ từ đầu câu gõ trùng liên tiếp với từ đầu của mục (tên mục đứng đầu nhãn)."""
    words = norm.split()
    n = 0
    for i, t in enumerate(tokens):
        if i >= len(words):
            break
        last = i == len(tokens) - 1
        if words[i] == t or (last and words[i].startswith(t)):
            n += 1
        else:
            break
    return n / len(tokens) if tokens else 0.0


def _distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    dx = (lon2 - lon1) * 111.32 * math.cos(math.radians((lat1 + lat2) / 2))
    dy = (lat2 - lat1) * 110.57
    return math.hypot(dx, dy)


class PgSuggestIndex:
    def __init__(self, conn: Connection):
        self.conn = conn

    def suggest(self, q: str, limit: int = 10, near: tuple[float, float] | None = None,
                province_code: str | None = None) -> list[Suggestion]:
        qn = " ".join(normalize_address(q).replace(",", " ").split())
        if len(qn) < 2:
            return []
        tokens = qn.split()
        params = {"q": qn, "prov": province_code, "n": CANDIDATES, "tsq": _tsquery(tokens)}
        rows = []
        if params["tsq"]:
            if len(tokens) >= 3:
                # Nhiều từ thì tập khớp nhỏ: buộc lọc bằng GIN trước rồi mới sắp xếp.
                sql = f"""
                WITH m AS MATERIALIZED (
                  SELECT * FROM geo.suggest_entry
                  WHERE tsv @@ to_tsquery('simple', %(tsq)s)
                    AND (%(prov)s::text IS NULL OR province_code = %(prov)s)
                  LIMIT 5000)
                SELECT {_COLUMNS} FROM m e ORDER BY e.weight DESC, length(e.norm) LIMIT %(n)s
                """
            else:
                # Ít từ thì tập khớp rất lớn: quét theo index xếp hạng và dừng sớm khi đủ.
                sql = f"""
                SELECT {_COLUMNS} FROM geo.suggest_entry e
                WHERE e.tsv @@ to_tsquery('simple', %(tsq)s)
                  AND (%(prov)s::text IS NULL OR e.province_code = %(prov)s)
                ORDER BY e.weight DESC, length(e.norm)
                LIMIT %(n)s
                """
            rows = self.conn.execute(sql, params).fetchall()
        if not rows:  # không mục nào chứa đủ các từ: nhiều khả năng gõ sai, bù bằng trigram (chậm hơn)
            seen = {r["id"] for r in rows}
            rows += [r for r in self.conn.execute(
                f"""
                SELECT {_COLUMNS} FROM geo.suggest_entry e
                WHERE (%(prov)s::text IS NULL OR e.province_code = %(prov)s)
                ORDER BY %(q)s <<-> e.norm
                LIMIT %(n)s
                """, params).fetchall() if r["id"] not in seen]

        scored = []
        for r in rows:
            score = (0.5 * coverage(tokens, r["norm"]) + 0.3 * r["ws"] + 0.2 * leading_match(tokens, r["norm"])
                     + (0.15 if r["norm"].startswith(qn) else 0.0) + 0.02 * r["weight"])
            if near:
                score -= min(0.25, _distance_km(near[0], near[1], r["lat"], r["lon"]) / 400.0)
            scored.append((score, -len(r["norm"]), r))
        scored.sort(key=lambda x: (x[0], x[1]), reverse=True)
        return [Suggestion(r["ref"], r["label"], r["kind"], r["lat"], r["lon"], r["ward_code"], r["province_code"],
                           round(s, 3)) for s, _, r in scored[:limit]]

    def get(self, ref: str) -> Suggestion | None:
        """Tra một mục theo place_id (ref) đã trả trong gợi ý."""
        r = self.conn.execute(
            "SELECT ref, label, kind, ST_Y(geom) lat, ST_X(geom) lon, ward_code, province_code "
            "FROM geo.suggest_entry WHERE ref = %s LIMIT 1", (ref,)).fetchone()
        return Suggestion(r["ref"], r["label"], r["kind"], r["lat"], r["lon"], r["ward_code"], r["province_code"],
                          1.0) if r else None
