"""Vòng tự học (chạy mỗi đêm: `make learn`).

1. LLM gán nhãn các ca khó trong log (nếu đã cấu hình LLM).
2. Huấn luyện tagger trên nhãn tổng hợp + nhãn LLM/người đã nhận; so với tagger đang dùng trên cùng tập đánh giá
   cố định; chỉ đưa vào dùng nếu không kém hơn (cổng chất lượng).
3. Huấn luyện mô hình quyết định trên kết quả đã biết đúng/sai (hôm nay: địa chỉ OSM để dành, nửa có osm_id % 10 = 0;
   đánh giá trên nửa osm_id % 10 = 5). Khi có GPS phát thành công, thay bằng nhãn thật.
4. Ghi báo cáo vào data/models/report-<thời điểm>.json và bảng ml.model.
"""

from __future__ import annotations

import json
import random
import statistics
import sys
import time
from datetime import datetime
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

from bds.config import settings
from bds.geocode.resolver import Geocoder
from bds.learn import decision as dm
from bds.learn import llm
from bds.learn.registry import current_row
from bds.learn.synth import Vocab, generate
from bds.learn.tagger import Tagger, evaluate, load_gold, street_gazetteer, train
from bds.pipeline.eval_geocode import variants
from bds.routing.engine import Point, haversine_m

GOLD = Path(__file__).resolve().parents[3] / "tests" / "data" / "tagger_gold.jsonl"
LABEL_WEIGHT = 5  # mỗi nhãn LLM/người được lặp lại để nặng hơn nhãn tổng hợp

DECISION_SQL = """
SELECT a.housenumber, a.street, ST_Y(a.geom) lat, ST_X(a.geom) lon, w.name ward, p.name province
FROM geo.address_point a
CROSS JOIN LATERAL (SELECT name, parent_code FROM geo.admin_unit WHERE level = 2
                    ORDER BY geom <-> a.geom LIMIT 1) w
JOIN geo.admin_unit p ON p.code = w.parent_code
WHERE a.holdout AND a.osm_id %% 10 = %(mod)s AND a.street IS NOT NULL AND a.house_num IS NOT NULL
ORDER BY md5(a.osm_id::text) LIMIT %(n)s
"""


def log(msg: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


# ---------- 1. LLM ----------
def label_hard_cases(conn, tagger: Tagger | None, limit: int = 200) -> dict:
    rows = conn.execute(
        """
        SELECT DISTINCT query FROM ops.geocode_log g
        WHERE ts > now() - interval '7 days' AND (confidence < 0.5 OR level IN ('WARD_CENTROID', 'PROVINCE_CENTROID'))
          AND NOT EXISTS (SELECT 1 FROM ml.label l WHERE l.raw = g.query AND l.source = 'llm')
        LIMIT %s
        """, (limit,)).fetchall()
    stats = {"candidates": len(rows), "accepted": 0, "review": 0, "rejected": 0}
    for r in rows:
        fields = llm.extract(r["query"])
        aligned = llm.align(r["query"], fields) if fields else None
        if not aligned:
            status, tokens, labels = "rejected", [], []
        else:
            tokens, labels = aligned
            tagged = tagger.tag(r["query"]) if tagger else None
            status = llm.judge(labels, tagged.labels if tagged else labels, tagged.confidence if tagged else 0.0)
        conn.execute("INSERT INTO ml.label (raw, tokens, labels, source, status) VALUES (%s, %s, %s, 'llm', %s) "
                     "ON CONFLICT (raw, source) DO NOTHING", (r["query"], tokens, labels, status))
        stats[status] += 1
    return stats


# ---------- 2. tagger ----------
def tagger_step(conn, ts: str, models: Path, n_synth: int) -> tuple[Tagger, dict]:
    streets = street_gazetteer(conn)
    labels = [(r["tokens"], r["labels"]) for r in conn.execute(
        "SELECT tokens, labels FROM ml.label WHERE status = 'accepted' AND cardinality(tokens) > 0").fetchall()]
    synth = [(e.tokens, e.labels) for e in generate(Vocab(conn, "train"), n_synth, seed=1)]
    test = [(e.tokens, e.labels) for e in generate(Vocab(conn, "test"), 4000, seed=2)]
    gold = load_gold(GOLD)
    log(f"tagger: {len(synth)} mẫu tổng hợp + {len(labels)} nhãn LLM/người (×{LABEL_WEIGHT})")
    path = models / f"tagger-{ts}.crfsuite"
    t0 = time.time()
    train(synth + labels * LABEL_WEIGHT, path, streets)
    new = Tagger(path)
    metrics = {"synth_test": evaluate(new, test), "gold": evaluate(new, gold), "train_s": round(time.time() - t0),
               "n_synth": len(synth), "n_labels": len(labels)}
    cur = current_row(conn, "tagger")
    if cur and Path(cur["path"]).exists():
        old = Tagger(Path(cur["path"]))
        old_m = {"synth_test": evaluate(old, test), "gold": evaluate(old, gold)}
        better = (metrics["gold"]["core_exact"] >= old_m["gold"]["core_exact"]
                  and metrics["synth_test"]["core_exact"] >= old_m["synth_test"]["core_exact"] - 0.005)
        reason = (f"gold {old_m['gold']['core_exact']}→{metrics['gold']['core_exact']}, "
                  f"tổng hợp {old_m['synth_test']['core_exact']}→{metrics['synth_test']['core_exact']}")
        metrics["previous"] = {"version": cur["version"], **old_m}
    else:
        better, reason, old = True, "chưa có tagger nào", None
    conn.execute("INSERT INTO ml.model (kind, version, path, metrics, promoted, reason) VALUES "
                 "('tagger', %s, %s, %s, %s, %s)", (path.stem, str(path), json.dumps(metrics), better, reason))
    log(f"tagger {path.stem}: {'ĐƯA VÀO DÙNG' if better else 'giữ bản cũ'} ({reason})")
    return (new if better or old is None else old), {**metrics, "promoted": better, "reason": reason}


# ---------- 3. mô hình quyết định ----------
def decision_dataset(conn, tagger: Tagger, mod: int, n: int, seed: int):
    """Mỗi địa chỉ: danh sách (đặc trưng ứng viên, đúng trong 200 m?, sai số)."""
    rng = random.Random(seed)
    g = Geocoder(conn)
    out = []
    for row in conn.execute(DECISION_SQL, {"mod": mod, "n": n}).fetchall():
        q = variants(row)[rng.choice(["co_dau", "khong_dau", "viet_tat"])]
        _, _, cands = g.candidates(q, tagger)
        truth = Point(row["lat"], row["lon"])
        out.append([(r.features, *_score(r, truth)) for _, _, r in cands])
    return out


def _score(r, truth: Point) -> tuple[bool, float]:
    if r.lat is None:
        return False, float("inf")
    err = haversine_m(Point(r.lat, r.lon), truth)
    return err <= dm.THRESHOLD_M, err


def decision_step(conn, tagger: Tagger, ts: str, models: Path, n_train: int, n_test: int) -> dict:
    log(f"mô hình quyết định: dựng dữ liệu ({n_train} địa chỉ học, {n_test} địa chỉ đánh giá)")
    train_set = decision_dataset(conn, tagger, 0, n_train, seed=11)
    test_set = decision_dataset(conn, tagger, 5, n_test, seed=12)
    path = models / f"decision-{ts}.joblib"
    model = dm.train([(f, ok) for cands in train_set for f, ok, _ in cands], path)

    def judge(m):
        chosen = [max(c, key=lambda x: m.probability(x[0])) for c in test_set]
        probs = [m.probability(f) for f, _, _ in chosen]
        return chosen, dm.calibration(probs, [ok for _, ok, _ in chosen])

    chosen, cal = judge(model)
    rule_only = [c[0] for c in test_set]
    metrics = {
        "n_train_candidates": sum(len(c) for c in train_set), "n_test": len(test_set),
        "acc200_rule_only": round(sum(ok for _, ok, _ in rule_only) / len(rule_only), 4),
        "acc200_chosen": round(sum(ok for _, ok, _ in chosen) / len(chosen), 4),
        "median_err_rule_only": round(statistics.median(e for _, _, e in rule_only), 1),
        "median_err_chosen": round(statistics.median(e for _, _, e in chosen), 1),
        "calibration_model": cal,
        "calibration_heuristic": dm.calibration([f.get("heuristic_conf", 0.0) for f, _, _ in rule_only],
                                                [ok for _, ok, _ in rule_only]),
        "tagger_disagreed_pct": round(100 * sum(len(c) > 1 for c in test_set) / len(test_set), 1),
    }
    cur = current_row(conn, "decision")
    if cur and Path(cur["path"]).exists():
        _, old_cal = judge(dm.DecisionModel.load(Path(cur["path"])))
        better = cal["brier"] <= old_cal["brier"]
        reason = f"Brier {old_cal['brier']}→{cal['brier']}"
    else:
        better, reason = True, "chưa có mô hình quyết định nào"
    conn.execute("INSERT INTO ml.model (kind, version, path, metrics, promoted, reason) VALUES "
                 "('decision', %s, %s, %s, %s, %s)", (path.stem, str(path), json.dumps(metrics), better, reason))
    log(f"quyết định {path.stem}: {'ĐƯA VÀO DÙNG' if better else 'giữ bản cũ'} ({reason})")
    return {**metrics, "promoted": better, "reason": reason}


def run(n_synth: int = 50000, n_train: int = 2500, n_test: int = 1500) -> dict:
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    models = Path(settings().models_dir)
    models.mkdir(parents=True, exist_ok=True)
    report: dict = {"version": ts}
    with psycopg.connect(settings().pg_dsn, autocommit=True, row_factory=dict_row) as conn:
        cur = current_row(conn, "tagger")
        if llm.configured():
            log("LLM: gán nhãn ca khó trong log 7 ngày")
            report["llm"] = label_hard_cases(conn, Tagger(Path(cur["path"])) if cur else None)
        else:
            report["llm"] = "chưa cấu hình BDS_LLM_URL/BDS_LLM_MODEL, bỏ qua"
        tagger, report["tagger"] = tagger_step(conn, ts, models, n_synth)
        report["decision"] = decision_step(conn, tagger, ts, models, n_train, n_test)
        report["review_queue"] = conn.execute("SELECT count(*) c FROM ml.label WHERE status = 'review'").fetchone()["c"]
    (models / f"report-{ts}.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    return report


def main() -> None:
    args = [int(a) for a in sys.argv[1:]]
    r = run(*args)
    t, d = r["tagger"], r["decision"]
    print("\n# Kết quả vòng học", r["version"])
    print(f"LLM: {r['llm']}")
    print(f"Tagger: gold core_exact {t['gold']['core_exact']}, tổng hợp {t['synth_test']['core_exact']} — "
          f"{'đưa vào dùng' if t['promoted'] else 'giữ bản cũ'} ({t['reason']})")
    print(f"Quyết định: acc@200m chỉ luật {d['acc200_rule_only']} → có ML {d['acc200_chosen']}; "
          f"Brier {d['calibration_heuristic']['brier']} (heuristic) → {d['calibration_model']['brier']} (mô hình); "
          f"ECE {d['calibration_heuristic']['ece']} → {d['calibration_model']['ece']}")
    print("Bảng hiệu chỉnh (dự đoán → thực tế):", [(b["bin"], b["predicted"], b["actual"], b["n"])
                                                 for b in d["calibration_model"]["table"]])
    print(f"Hàng chờ người duyệt: {r['review_queue']}")


if __name__ == "__main__":
    main()
