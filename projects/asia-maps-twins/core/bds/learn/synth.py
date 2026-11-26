"""Sinh mẫu huấn luyện có nhãn cho tagger từ dữ liệu thật (OSM + danh mục hành chính), không cần người gán nhãn.

Mỗi mẫu là một địa chỉ ghép từ các đoạn có nhãn (số nhà, ngõ, đường, thôn, địa danh, xã, huyện, tỉnh), thêm nhiễu
giống cách khách gõ: bỏ dấu phẩy, viết tắt, bỏ chữ chỉ loại ("phường", "tỉnh"), địa chỉ cũ 3 cấp, số điện thoại,
lời nhắn, gõ sai một chữ. Mỗi đoạn được chuẩn hoá và tách từ riêng nên nhãn từng từ đúng theo cách dựng.

`split="train"` dùng tên đường có hash chẵn; `split="test"` dùng tên đường còn lại, để đo trên đường chưa thấy.
"""

from __future__ import annotations

import os
import random
import re
import sqlite3
import zlib
from dataclasses import dataclass

import vietnamadminunits
from psycopg import Connection

from bds.learn.tokens import tokenize


@dataclass
class Example:
    tokens: list[str]
    labels: list[str]
    raw: str


def _bucket(name: str) -> int:
    return zlib.crc32(name.encode()) % 10


def _in_split(name: str, split: str) -> bool:
    return (_bucket(name) < 8) == (split == "train")


class Vocab:
    """Kho tên thật để ghép mẫu."""

    def __init__(self, conn: Connection, split: str, limit: int = 40000):
        rows = conn.execute(
            """
            SELECT a.housenumber, a.street, w.name ward, w.name_short ward_short, p.name province,
                   p.name_short province_short
            FROM geo.address_point a
            CROSS JOIN LATERAL (SELECT name, name_short, parent_code FROM geo.admin_unit WHERE level = 2
                                ORDER BY geom <-> a.geom LIMIT 1) w
            JOIN geo.admin_unit p ON p.code = w.parent_code
            WHERE NOT a.holdout AND a.street IS NOT NULL AND a.housenumber ~ '^[0-9]'
            ORDER BY md5(a.osm_id::text) LIMIT %s
            """, (limit,)).fetchall()
        self.addresses = [r for r in rows if _in_split(r["street"], split)]
        self.streets = sorted({r["street"] for r in self.addresses} | {
            r["name"] for r in conn.execute(
                "SELECT DISTINCT name FROM geo.street WHERE highway IN ('primary','secondary','tertiary','residential') "
                "ORDER BY name LIMIT 20000").fetchall() if _in_split(r["name"], split)})
        # Chỉ giữ tên có chữ chỉ loại (Thôn/Xóm/Ấp/Tổ...): tên khu dân cư không có chữ chỉ loại (vd. "Chợ X")
        # dễ dạy sai rằng "chợ", "khu" là thôn.
        self.hamlets = [r["name"] for r in conn.execute(
            "SELECT name FROM geo.place WHERE kind IN ('place:hamlet','place:village','place:neighbourhood') "
            "AND name ~* '^(thôn|xóm|ấp|tổ|khu phố|bản|buôn|bon|làng|khóm|tổ dân phố) ' "
            "ORDER BY md5(name) LIMIT 8000").fetchall() if _in_split(r["name"], split)]
        self.places = [r["name"] for r in conn.execute(
            "SELECT name FROM geo.place WHERE kind ~ '^(amenity|shop|landuse:industrial|tourism|healthcare)' "
            "AND length(name) BETWEEN 4 AND 40 ORDER BY md5(name) LIMIT 12000").fetchall() if _in_split(r["name"], split)]
        self.wards = conn.execute(
            "SELECT w.name ward, w.name_short ward_short, p.name province, p.name_short province_short "
            "FROM geo.admin_unit w JOIN geo.admin_unit p ON p.code = w.parent_code WHERE w.level = 2").fetchall()
        db = os.path.join(os.path.dirname(vietnamadminunits.__file__), "data", "dataset.db")
        with sqlite3.connect(db) as c:
            self.legacy = c.execute(
                "SELECT ward, wardShort, district, districtShort, districtType, province, provinceShort "
                "FROM admin_units_legacy WHERE ward IS NOT NULL AND district IS NOT NULL").fetchall()


# ---------- cách viết từng đoạn ----------
def _house(rng: random.Random, hn: str | None) -> str:
    n = hn or str(rng.randint(1, 400))
    return rng.choice([n, n, f"số {n}", f"Số {n}", f"sn {n}", f"nhà {n}", f"{n}/{rng.randint(1, 80)}",
                       f"LK{rng.randint(1, 30)}-{rng.randint(1, 40)}", f"{n}{rng.choice('ABC')}"])


def _alley(rng: random.Random) -> str:
    return " ".join(f"{rng.choice(['ngõ', 'Ngõ', 'ngách', 'hẻm', 'Hẻm', 'kiệt', 'ng.'])} {rng.randint(1, 300)}"
                    for _ in range(rng.choice([1, 1, 2])))


_ALLEY_IN_NAME = re.compile(r"^((?:ngõ|ngách|hẻm|kiệt)\s+\S+(?:\s+(?:ngõ|ngách|hẻm|kiệt)\s+\S+)*)\s+(.+)$", re.IGNORECASE)


def split_alley(name: str) -> tuple[str | None, str]:
    """OSM hay ghi "Ngõ 32 Phố Huế" là một tên đường: tách thành phần ngõ và phần đường."""
    m = _ALLEY_IN_NAME.match(name)
    return (m.group(1), m.group(2)) if m else (None, name)


def _street(rng: random.Random, name: str) -> str:
    if rng.random() < 0.06:  # đường số hiệu: quốc lộ, tỉnh lộ, đường số
        n = rng.randint(1, 80)
        return rng.choice([f"Quốc lộ {n}{rng.choice(['', 'A', 'B'])}", f"QL{n}", f"QL {n}A", f"Tỉnh lộ {n * 10}",
                           f"ĐT{n * 10}", f"đường số {n}", f"đường {n}/{rng.randint(1, 12)}"])
    if name.lower().startswith(("đường", "phố", "quốc lộ", "tỉnh lộ", "đại lộ")):
        return name
    return rng.choice([name, name, name, f"đường {name}", f"Đường {name}", f"phố {name}", f"Đ. {name}"])


PLACE_TYPES = ["Khu công nghiệp", "KCN", "KCN", "KĐT", "KĐT", "Khu đô thị", "Cụm công nghiệp", "Chung cư", "CC", "Toà nhà", "Tòa", "Chợ", "Trường THPT",
               "Trường tiểu học", "Trường Đại học", "Bệnh viện", "Siêu thị", "Bến xe", "Cảng", "Công ty", "Nhà máy"]


def _place(rng: random.Random, vocab: Vocab) -> str:
    """Địa danh thật từ OSM, hoặc loại địa danh + một tên (lấy từ tên đường/xã) cho các loại OSM ít có."""
    if vocab.places and rng.random() < 0.5:
        return rng.choice(vocab.places)
    name = split_alley(rng.choice(vocab.streets))[1] if rng.random() < 0.6 else rng.choice(vocab.wards)["ward_short"]
    return f"{rng.choice(PLACE_TYPES)} {name}"


def _hamlet(rng: random.Random, names: list[str]) -> str:
    if names and rng.random() < 0.6:
        return rng.choice(names)
    return f"{rng.choice(['thôn', 'Thôn', 'xóm', 'ấp', 'tổ', 'tổ dân phố', 'TDP', 'khu phố', 'KP'])} {rng.randint(1, 20)}"


def _ward(rng: random.Random, full: str, short: str) -> str:
    kind = full.split(" ")[0]
    abbr = {"Phường": "P.", "Xã": "X.", "Thị": "TT."}.get(kind, "")
    options = [full, full, short, short, f"{abbr} {short}" if abbr else full, full.lower(),
               f"{abbr}{short}" if abbr else short]
    if kind == "Phường":
        options += [f"p {short.lower()}", f"p.{short}"]
    if short.isdigit():
        options += [f"P{short}", f"P.{short}", f"phường {short}"]
    return rng.choice(options)


def _district(rng: random.Random, full: str, short: str, kind: str) -> str:
    abbr = {"Quận": "Q.", "Huyện": "H.", "Thị xã": "TX.", "Thành phố": "TP."}.get(kind, "")
    options = [full, short, short, f"{abbr} {short}" if abbr else full, f"{abbr}{short}" if abbr else short]
    if kind == "Quận":
        options += [f"q {short.lower()}", f"q.{short}"]
    if short.isdigit():
        options += [f"Q{short}", f"Q.{short}", f"quận {short}", f"q{short}"]
    return rng.choice(options)


def _province(rng: random.Random, full: str, short: str) -> str:
    options = [full, short, short, full.lower()]
    if short == "Hồ Chí Minh":
        options += ["TP.HCM", "TPHCM", "tp hcm", "HCM", "Sài Gòn"]
    if short == "Hà Nội":
        options += ["HN", "TP Hà Nội", "ha noi"]
    if full.startswith("Thành phố"):
        options.append(f"TP {short}")
    return rng.choice(options)


FILLERS = ["gọi trước khi giao", "giao giờ hành chính", "gần chợ", "đối diện trường học", "cạnh cây xăng",
           "nhà màu xanh", "(giao buổi sáng)", "liên hệ chị Lan"]


def _phone(rng: random.Random) -> str:
    return "0" + rng.choice(["9", "8", "3", "7"]) + "".join(str(rng.randint(0, 9)) for _ in range(8))


def _typo(rng: random.Random, text: str) -> str:
    if len(text) < 5:
        return text
    i = rng.randrange(1, len(text) - 1)
    return rng.choice([text[:i] + text[i + 1:], text[:i] + text[i + 1] + text[i] + text[i + 2:]])


# ---------- ghép mẫu ----------
def _render(rng: random.Random, segments: list[tuple[str, str]]) -> Example:
    tokens, labels, raws = [], [], []
    comma = rng.random() < 0.55
    for k, (raw, label) in enumerate(segments):
        seg_tokens = [t for t in tokenize(raw) if t != ","]
        if not seg_tokens:
            continue
        if k and comma and label != "ALLEY" and not (label == "STREET" and segments[k - 1][1] in ("HOUSE", "ALLEY")):
            tokens.append(",")
            labels.append("O")
        tokens += seg_tokens
        labels += [label] * len(seg_tokens)
        raws.append(raw)
    return Example(tokens, labels, (", " if comma else " ").join(raws))


def generate(vocab: Vocab, n: int, seed: int = 7) -> list[Example]:
    rng = random.Random(seed)
    out = []
    for _ in range(n):
        r = rng.random()
        segs: list[tuple[str, str]] = []
        legacy = rng.random() < 0.3
        if legacy:
            lw, lws, ld, lds, ldt, lp, lps = rng.choice(vocab.legacy)
            ward_seg = (_ward(rng, lw, lws), "WARD")
            tail = [(_district(rng, ld, lds, ldt), "DISTRICT"), (_province(rng, lp, lps), "PROVINCE")]
        else:
            w = rng.choice(vocab.wards)
            ward_seg = (_ward(rng, w["ward"], w["ward_short"]), "WARD")
            tail = [(_province(rng, w["province"], w["province_short"]), "PROVINCE")]
        if r < 0.55 and vocab.addresses:  # số nhà + đường
            a = rng.choice(vocab.addresses)
            segs.append((_house(rng, a["housenumber"]), "HOUSE"))
            if rng.random() < 0.3:
                segs.append((_alley(rng), "ALLEY"))
            alley_part, street = split_alley(a["street"] if rng.random() < 0.5 else rng.choice(vocab.streets))
            if alley_part:
                segs.append((alley_part, "ALLEY"))
            segs.append((_typo(rng, _street(rng, street)) if rng.random() < 0.08 else _street(rng, street), "STREET"))
            if rng.random() < 0.15:
                segs.append((_hamlet(rng, vocab.hamlets), "HAMLET"))
        elif r < 0.62:  # ngõ + đường, không số nhà
            segs += [(_alley(rng), "ALLEY"), (_street(rng, split_alley(rng.choice(vocab.streets))[1]), "STREET")]
        elif r < 0.7:  # chỉ có tên đường (vd. "Quốc lộ 1A, xã ...")
            segs.append((_street(rng, split_alley(rng.choice(vocab.streets))[1]), "STREET"))
        elif r < 0.85:  # địa danh, một nửa số mẫu kèm tên đường ngay sau (hay không có dấu phẩy)
            if rng.random() < 0.2:
                segs.append((_house(rng, None), "HOUSE"))
            segs.append((_place(rng, vocab), "PLACE"))
            if rng.random() < 0.5:
                segs.append((_street(rng, split_alley(rng.choice(vocab.streets))[1]), "STREET"))
        else:  # nông thôn: thôn/xóm
            segs.append((_hamlet(rng, vocab.hamlets), "HAMLET"))
        if not (rng.random() < 0.2 and segs):  # khách hay bỏ xã, chỉ ghi quận/tỉnh
            segs.append(ward_seg)
        segs += tail
        if rng.random() < 0.1:
            segs.append((rng.choice(FILLERS), "O"))
        if rng.random() < 0.08:
            segs.append((_phone(rng), "O"))
        out.append(_render(rng, segs))
    return out
