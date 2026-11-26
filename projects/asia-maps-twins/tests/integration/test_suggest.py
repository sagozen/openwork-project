"""Gợi ý địa chỉ trên dữ liệu thật: chất lượng top-5 và độ trễ."""

import statistics
import time

import pytest

from bds.suggest.service import PgSuggestIndex

pytestmark = pytest.mark.integration


def labels(conn, q, **kw):
    return [s.label for s in PgSuggestIndex(conn).suggest(q, limit=5, **kw)]


@pytest.mark.parametrize("q, expected_fragment", [
    ("phường bến thành", "Phường Bến Thành"),
    ("ben thanh", "Bến Thành"),
    ("hai ba tr", "Hai Bà Trưng"),
    ("pho hue ha noi", "Phố Huế"),
    ("nguyen hue tphcm", "Nguyễn Huệ"),
    ("cho ben thanh", "Chợ Bến Thành"),
    ("bac ninh", "Bắc Ninh"),
])
def test_top5_contains_expected(conn, q, expected_fragment):
    got = labels(conn, q)
    assert any(expected_fragment in label for label in got), got


@pytest.mark.parametrize("q, expected_fragment", [
    ("nguyen trsi", "Nguyễn Trãi"),     # gõ sai một chữ
    ("phuong ben thnah", "Bến Thành"),  # đảo chữ
])
def test_typo_tolerance(conn, q, expected_fragment):
    got = labels(conn, q)
    assert any(expected_fragment in label for label in got), got


def test_near_point_prefers_local_result(conn):
    # "Lê Lợi" có ở rất nhiều tỉnh; đứng ở TP.HCM thì kết quả đầu phải ở TP.HCM.
    got = PgSuggestIndex(conn).suggest("le loi", limit=3, near=(10.7745, 106.7020))
    assert got and got[0].province_code == "79"


def test_province_filter(conn):
    got = PgSuggestIndex(conn).suggest("tran phu", limit=5, province_code="01")
    assert got and all(s.province_code == "01" for s in got)


def test_short_query_returns_nothing(conn):
    assert PgSuggestIndex(conn).suggest("a") == []


def test_latency_p95_under_80ms(conn):
    index = PgSuggestIndex(conn)
    queries = ["ng", "ngu", "nguy", "nguyen", "nguyen tr", "nguyen trai", "pho", "pho h", "pho hue", "le l",
               "le loi", "hai b", "tran hung d", "cho ben", "phuong 1", "dien bien", "kcn que vo", "bac ninh",
               "ly thuong kiet", "cau giay"] * 3
    took = []
    for q in queries:
        t0 = time.perf_counter()
        index.suggest(q)
        took.append((time.perf_counter() - t0) * 1000)
    p95 = statistics.quantiles(took, n=20)[18]
    print(f"suggest p50={statistics.median(took):.1f}ms p95={p95:.1f}ms")
    assert p95 < 80
