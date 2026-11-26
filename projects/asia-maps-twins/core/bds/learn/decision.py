"""Mô hình quyết định: P(kết quả nằm trong 200 m) cho từng ứng viên phân giải.

Hồi quy logistic trên đặc trưng của ứng viên. Dùng để (1) chọn giữa ứng viên của luật và của tagger,
(2) trả độ tin cậy là xác suất đã hiệu chỉnh, nên ngưỡng 0,7 / 0,5 của hợp đồng độ tin cậy có nghĩa thật.
"""

from __future__ import annotations

import math
from itertools import pairwise
from pathlib import Path

import joblib
import numpy as np
from sklearn.feature_extraction import DictVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, roc_auc_score
from sklearn.pipeline import make_pipeline

THRESHOLD_M = 200.0


def vectorize(f: dict) -> dict:
    """Đặc trưng thô của resolver → dict số/nhãn cho DictVectorizer."""
    level = f.get("level", "NOT_FOUND")
    out = {
        f"level={level}": 1.0,
        f"admin={f.get('admin_source', 'none')}": 1.0,
        f"parser={f.get('parser', 'rule')}": 1.0,
        "agree": float(bool(f.get("agree", True))),
        "widened": float(bool(f.get("widened"))),
        "tagger_conf": max(0.0, float(f.get("tagger_conf", -1.0))),
        "has_tagger": float(f.get("tagger_conf", -1.0) >= 0),
        "street_sim": float(f.get("street_sim", 0.0)),
        "place_sim": float(f.get("place_sim", 0.0)),
        "hamlet_match": float(bool(f.get("hamlet_match"))),
        "log_street_len": math.log1p(float(f.get("street_len_m", 0.0)) / 100),
        "log_interp_gap": math.log1p(float(f.get("interp_gap_m", 0.0)) / 50),
        "log_num_gap": math.log1p(float(f.get("num_gap", 0.0))),
        "log_ward_area": math.log1p(float(f.get("ward_area_km2", 0.0))),
        "heuristic_conf": float(f.get("heuristic_conf", 0.0)),
    }
    for k in ("has_house", "has_alley", "has_street", "has_hamlet", "has_place"):
        out[k] = float(bool(f.get(k)))
    return out


class DecisionModel:
    def __init__(self, pipeline):
        self.pipeline = pipeline

    @classmethod
    def load(cls, path: Path) -> DecisionModel:
        return cls(joblib.load(path))

    def probability(self, features: dict) -> float:
        if features.get("level") == "NOT_FOUND":
            return 0.0
        return float(self.pipeline.predict_proba([vectorize(features)])[0, 1])


def train(rows: list[tuple[dict, bool]], path: Path) -> DecisionModel:
    pipe = make_pipeline(DictVectorizer(sparse=False), LogisticRegression(C=1.0, max_iter=2000))
    pipe.fit([vectorize(f) for f, _ in rows], [int(y) for _, y in rows])
    joblib.dump(pipe, path)
    return DecisionModel(pipe)


def calibration(probs: list[float], labels: list[bool], bins: int = 5) -> dict:
    """Brier, AUC, ECE và bảng độ tin cậy: trong mỗi khoảng xác suất, tỉ lệ đúng thật là bao nhiêu."""
    p, y = np.array(probs), np.array(labels, dtype=float)
    table, ece = [], 0.0
    edges = np.linspace(0, 1, bins + 1)
    for lo, hi in pairwise(edges):
        mask = (p >= lo) & (p < hi if hi < 1 else p <= hi)
        if mask.sum():
            gap = abs(p[mask].mean() - y[mask].mean())
            ece += gap * mask.sum() / len(p)
            table.append({"bin": f"{lo:.1f}-{hi:.1f}", "n": int(mask.sum()), "predicted": round(float(p[mask].mean()), 3),
                          "actual": round(float(y[mask].mean()), 3)})
    return {"n": len(p), "brier": round(float(brier_score_loss(y, p)), 4),
            "auc": round(float(roc_auc_score(y, p)), 4) if 0 < y.sum() < len(y) else None,
            "ece": round(float(ece), 4), "table": table}
