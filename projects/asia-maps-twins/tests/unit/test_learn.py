"""Các phần của tầng hiểu địa chỉ không cần mô hình đã huấn luyện."""

import json
import time

import httpx

from bds.geocode.cache import TTLCache
from bds.learn import decision as dm
from bds.learn import llm
from bds.learn.tagger import TaggedAddress
from bds.learn.tokens import tokenize


def test_tokenize_runs_after_rules():
    assert tokenize("59 Nguyễn Huệ, P. Bến Nghé, Q.1, TP.HCM") == [
        "59", "nguyen", "hue", ",", "phuong", "ben", "nghe", ",", "quan", "1", ",", "thanh", "pho", "ho", "chi", "minh"]


def test_llm_align_accepts_exact_substrings():
    tokens, labels = llm.align("12 ngõ 34 Phố Huế, Hai Bà Trưng, Hà Nội",
                               {"house_no": "12", "alley": "ngõ 34", "street": "Phố Huế", "ward": "Hai Bà Trưng",
                                "province": "Hà Nội"})
    assert labels[:5] == ["HOUSE", "ALLEY", "ALLEY", "STREET", "STREET"]
    assert labels[tokens.index("noi")] == "PROVINCE"


def test_llm_align_rejects_hallucinated_value():
    """LLM thêm thông tin không có trong địa chỉ (bịa tên phường) → loại."""
    assert llm.align("12 Phố Huế, Hà Nội", {"street": "Phố Huế", "ward": "Phường Bạch Đằng"}) is None


def test_llm_extract_parses_openai_style_response(monkeypatch):
    from bds.config import settings
    monkeypatch.setattr(settings(), "llm_url", "http://llm")
    monkeypatch.setattr(settings(), "llm_model", "qwen")

    def handler(request):
        body = json.loads(request.content)
        assert body["model"] == "qwen" and body["temperature"] == 0
        return httpx.Response(200, json={"choices": [{"message": {"content":
                                         '```json\n{"street": "Phố Huế", "house_no": "12", "ward": ""}\n```'}}]})

    out = llm.extract("12 Phố Huế", client=httpx.Client(transport=httpx.MockTransport(handler)))
    assert out == {"street": "Phố Huế", "house_no": "12"}


def test_llm_judge_policy():
    same = ["HOUSE", "STREET", "WARD"]
    assert llm.judge(same, ["HOUSE", "STREET", "DISTRICT"], 0.95) == "accepted"  # chỉ khác cấp hành chính
    assert llm.judge(same, ["PLACE", "STREET", "WARD"], 0.4) == "accepted"       # tagger không chắc
    assert llm.judge(same, ["PLACE", "STREET", "WARD"], 0.95) == "review"        # tagger chắc mà bất đồng


def test_tagged_address_to_parts():
    t = TaggedAddress(["so", "12", "ngo", "34", "ngach", "5", "pho", "hue", ",", "ha", "noi"],
                      ["HOUSE", "HOUSE", "ALLEY", "ALLEY", "ALLEY", "ALLEY", "STREET", "STREET", "O", "PROVINCE",
                       "PROVINCE"],
                      [0.99, 0.99, 0.9, 0.9, 0.8, 0.8, 0.95, 0.95, 1, 1, 1])
    p = t.to_parts()
    assert (p.house_no, p.alleys, p.street) == ("12", [("ngo", "34"), ("ngach", "5")], "hue")
    assert t.confidence == 0.8


def test_decision_vectorize_and_not_found():
    v = dm.vectorize({"level": "STREET", "admin_source": "new", "parser": "tagger", "street_len_m": 900,
                      "tagger_conf": 0.7, "has_street": True})
    assert v["level=STREET"] == 1 and v["parser=tagger"] == 1 and v["has_street"] == 1 and v["log_street_len"] > 0


def test_calibration_perfect_and_bad():
    good = dm.calibration([0.9] * 10 + [0.1] * 10, [True] * 9 + [False] + [False] * 9 + [True])
    bad = dm.calibration([0.9] * 10 + [0.1] * 10, [False] * 9 + [True] + [True] * 9 + [False])
    assert good["ece"] < 0.05 < bad["ece"] and good["brier"] < bad["brier"]


def test_cache_ttl_and_lru():
    c = TTLCache(maxsize=2, ttl_s=0.05)
    c.put("a", 1)
    c.put("b", 2)
    c.put("c", 3)
    assert c.get("a") is None and c.get("c") == 3
    time.sleep(0.06)
    assert c.get("c") is None
