"""Tagger CRF: gán nhãn từng từ của địa chỉ (số nhà, ngõ, đường, thôn, địa danh, xã, huyện, tỉnh).

Chạy sau tầng luật. Kết quả chuyển thành StreetParts như parser luật, kèm độ chắc (xác suất biên thấp nhất
của các từ thuộc thành phần đường/số nhà/địa danh).
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import sklearn_crfsuite
import vietnamadminunits

from bds.geocode.street_parser import StreetParts
from bds.learn.tokens import tokenize
from bds.text.normalize import fold

TYPE_WORDS = {
    "so", "nha", "ngo", "ngach", "hem", "kiet", "duong", "pho", "dai", "lo", "quoc", "tinh", "thon", "xom", "ap",
    "to", "khu", "dan", "cu", "phuong", "xa", "quan", "huyen", "thi", "tran", "thanh", "cho", "truong", "benh",
    "vien", "cong", "nghiep", "do", "chung", "toa", "ban", "bon", "buon", "dac",
}
_NUM = re.compile(r"\d")
ALLEY_START = re.compile(r"^(?:ngo|ngach|hem|kiet|hxh)\s+\S+")


@lru_cache
def gazetteer() -> dict[str, set[tuple[str, ...]]]:
    """Cụm từ (đã bỏ dấu) của tên tỉnh, huyện, xã — cả đơn vị mới và cũ — để đánh dấu từ trong địa chỉ."""
    db = os.path.join(os.path.dirname(vietnamadminunits.__file__), "data", "dataset.db")
    gz: dict[str, set[tuple[str, ...]]] = {"prov": set(), "dist": set(), "ward": set()}
    with sqlite3.connect(db) as c:
        for p, ps, w, ws in c.execute("SELECT province, provinceShort, ward, wardShort FROM admin_units"):
            gz["prov"] |= {tuple(fold(p).split()), tuple(fold(ps).split())}
            gz["ward"] |= {tuple(fold(w).split()), tuple(fold(ws).split())}
        for p, ps, d, ds, w, ws in c.execute("SELECT province, provinceShort, district, districtShort, ward, wardShort "
                                             "FROM admin_units_legacy WHERE ward IS NOT NULL"):
            gz["prov"] |= {tuple(fold(p).split()), tuple(fold(ps).split())}
            gz["dist"] |= {tuple(fold(d).split()), tuple(fold(ds).split())}
            gz["ward"] |= {tuple(fold(w).split()), tuple(fold(ws).split())}
    return gz


def street_gazetteer(conn) -> set[tuple[str, ...]]:
    """Tên đường thật (đã bỏ dấu, bỏ tiền tố đường/phố), từ 2 từ trở lên để tránh đánh dấu nhầm từ đơn."""
    from bds.text.normalize import street_key
    names = {street_key(fold(r["name"])) for r in conn.execute("SELECT DISTINCT name FROM geo.street").fetchall()}
    # OSM hay ghi cả ngõ vào tên đường ("Ngõ 32 Phố Huế"): bỏ các tên đó để từ điển không dạy "ngõ 32" là đường.
    return {tuple(n.split()) for n in names if len(n.split()) >= 2 and not ALLEY_START.match(n)}


def _gazetteer_marks(tokens: list[str], streets: set[tuple[str, ...]] | None = None) -> list[set[str]]:
    gz, marks = dict(gazetteer()), [set() for _ in tokens]
    if streets:
        gz["street"] = streets
    for kind, entries in gz.items():
        for i in range(len(tokens)):
            for n in (5, 4, 3, 2, 1):
                if i + n <= len(tokens) and tuple(tokens[i:i + n]) in entries:
                    for j in range(i, i + n):
                        marks[j].add(kind)
                    break
    return marks


def _shape(t: str) -> str:
    if t == ",":
        return ","
    if t.isdigit():
        return "D"
    if _NUM.search(t):
        return "AD" if "/" not in t else "D/"
    return "A"


def features(tokens: list[str], streets: set[tuple[str, ...]] | None = None) -> list[dict]:
    marks = _gazetteer_marks(tokens, streets)
    commas_before, since_comma = [], []
    c = s = 0
    for t in tokens:
        commas_before.append(c)
        since_comma.append(s)
        if t == ",":
            c, s = c + 1, 0
        else:
            s += 1
    total_commas = c
    feats = []
    for i, t in enumerate(tokens):
        f = {
            "bias": 1.0, "w": t, "shape": _shape(t), "type": t in TYPE_WORDS, "len": min(len(t), 8),
            "p3": t[:3], "s3": t[-3:], "seg": min(commas_before[i], 6), "seg_rev": min(total_commas - commas_before[i], 6),
            "since_comma": min(since_comma[i], 6), "pos": round(i / max(1, len(tokens) - 1), 1),
            "gz_prov": "prov" in marks[i], "gz_dist": "dist" in marks[i], "gz_ward": "ward" in marks[i],
            "gz_street": "street" in marks[i],
        }
        for off in (-2, -1, 1, 2):
            j = i + off
            if 0 <= j < len(tokens):
                f[f"{off}:w"] = tokens[j]
                f[f"{off}:shape"] = _shape(tokens[j])
                f[f"{off}:type"] = tokens[j] in TYPE_WORDS
                f[f"{off}:gz"] = ",".join(sorted(marks[j]))
            else:
                f[f"{off}:edge"] = True
        feats.append(f)
    return feats


def train(examples: list[tuple[list[str], list[str]]], path: Path, streets: set[tuple[str, ...]],
          c1: float = 0.05, c2: float = 0.01, max_iterations: int = 120) -> Path:
    """Huấn luyện và lưu mô hình; từ điển tên đường được lưu cạnh file mô hình để luôn đi cùng phiên bản."""
    crf = sklearn_crfsuite.CRF(algorithm="lbfgs", c1=c1, c2=c2, max_iterations=max_iterations,
                               all_possible_transitions=True, model_filename=str(path))
    crf.fit([features(t, streets) for t, _ in examples], [labels for _, labels in examples])
    _streets_path(path).write_text(json.dumps(sorted(" ".join(s) for s in streets), ensure_ascii=False))
    return path


def _streets_path(model: Path) -> Path:
    return model.with_suffix(".streets.json")


@dataclass
class TaggedAddress:
    tokens: list[str]
    labels: list[str]
    probs: list[float]

    def spans(self) -> list[tuple[str, str, float]]:
        """Gộp các từ liên tiếp cùng nhãn: [(nhãn, chuỗi, xác suất thấp nhất)]."""
        out: list[tuple[str, str, float]] = []
        for tok, lab, p in zip(self.tokens, self.labels, self.probs, strict=True):
            if tok == ",":
                out.append(("SEP", ",", 1.0))
            elif out and out[-1][0] == lab:
                out[-1] = (lab, f"{out[-1][1]} {tok}", min(out[-1][2], p))
            else:
                out.append((lab, tok, p))
        return [s for s in out if s[0] != "SEP"]

    def to_parts(self) -> StreetParts:
        parts = StreetParts()
        for label, text, _ in self.spans():
            if label == "HOUSE" and parts.house_no is None:
                parts.house_no = re.sub(r"^(?:so nha|so|sn|nha)\s+", "", text)
            elif label == "ALLEY":
                parts.alleys += re.findall(r"(ngo|ngach|hem|kiet|hxh)\s+(\S+)", text)
            elif label == "STREET" and parts.street is None:
                parts.street = re.sub(r"^(?:duong|pho|dai lo)\s+", "", text)
            elif label == "HAMLET" and parts.hamlet is None:
                parts.hamlet = text
            elif label == "PLACE" and parts.place is None:
                m = re.match(r"^(khu cong nghiep|khu che xuat|khu do thi|chung cu|toa nha|cho|truong|benh vien)\s+(.+)$",
                             text)
                parts.place_type, parts.place = (m.group(1), m.group(2)) if m else (None, text)
        return parts

    @property
    def confidence(self) -> float:
        """Độ chắc của phần dưới cấp xã (thành phần dùng để tìm vị trí)."""
        core = [p for lab, p in zip(self.labels, self.probs, strict=True)
                if lab in ("HOUSE", "ALLEY", "STREET", "HAMLET", "PLACE")]
        return round(min(core), 3) if core else 0.0


class Tagger:
    def __init__(self, path: Path):
        self.path = path
        self.crf = sklearn_crfsuite.CRF(model_filename=str(path))
        sp = _streets_path(path)
        self.streets = {tuple(x.split()) for x in json.loads(sp.read_text())} if sp.exists() else set()

    def features(self, tokens: list[str]) -> list[dict]:
        return features(tokens, self.streets)

    def tag(self, raw: str) -> TaggedAddress:
        tokens = tokenize(raw)
        if not tokens:
            return TaggedAddress([], [], [])
        feats = self.features(tokens)
        labels = self.crf.predict_single(feats)
        marginals = self.crf.predict_marginals_single(feats)
        return TaggedAddress(tokens, labels, [round(m[lab], 4) for m, lab in zip(marginals, labels, strict=True)])


ADMIN_LABELS = {"WARD": "ADMIN", "DISTRICT": "ADMIN", "PROVINCE": "ADMIN"}


def _core(labels: list[str]) -> list[str]:
    return [ADMIN_LABELS.get(lab, lab) for lab in labels]


def evaluate(tagger: Tagger, examples: list[tuple[list[str], list[str]]]) -> dict:
    """Độ chính xác theo từ; `exact`: mọi từ đúng nhãn; `core_exact`: đúng phần dưới cấp xã (số nhà, ngõ, đường,
    thôn, địa danh), coi xã/huyện/tỉnh là một nhóm vì phần hành chính do tầng luật xử lý."""
    tok_ok = tok_n = exact = core_exact = 0
    per_label: dict[str, list[int]] = {}
    for tokens, gold in examples:
        pred = tagger.crf.predict_single(tagger.features(tokens))
        tok_ok += sum(p == g for p, g in zip(pred, gold, strict=True))
        tok_n += len(gold)
        exact += pred == gold
        core_exact += _core(pred) == _core(gold)
        for p, g in zip(pred, gold, strict=True):
            stat = per_label.setdefault(g, [0, 0])
            stat[0] += p == g
            stat[1] += 1
    return {"n": len(examples), "token_acc": round(tok_ok / tok_n, 4), "exact": round(exact / len(examples), 4),
            "core_exact": round(core_exact / len(examples), 4),
            "per_label": {k: round(v[0] / v[1], 3) for k, v in sorted(per_label.items())}}


def load_gold(path: Path) -> list[tuple[list[str], list[str]]]:
    """Tập kiểm tra do người gán nhãn: mỗi dòng JSON là danh sách [đoạn, nhãn]; dấu phẩy là đoạn [",", "O"]."""
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        tokens, labels = [], []
        for raw, label in json.loads(line):
            seg = tokenize(raw)  # đoạn "," cho ra đúng một từ ","
            tokens += seg
            labels += [label] * len(seg)
        out.append((tokens, labels))
    return out
