import pytest

from bds.ops.auth import RateLimiter, parse_keys
from bds.ops.request_log import mask_pii


@pytest.mark.parametrize("raw, expected", [
    ("12 Phố Huế, Hà Nội, sđt 0912345678", "12 Phố Huế, Hà Nội, sđt [SĐT]"),
    ("gọi 0912 345 678 khi tới", "gọi [SĐT] khi tới"),
    ("+84 912.345.678 ngõ 5", "[SĐT] ngõ 5"),
    ("123/45 Nguyễn Trãi, Phường 2", "123/45 Nguyễn Trãi, Phường 2"),  # số nhà không bị che
    ("Quốc lộ 1A km 1234", "Quốc lộ 1A km 1234"),
])
def test_mask_pii(raw, expected):
    assert mask_pii(raw) == expected


def test_parse_keys_named_and_unnamed():
    assert parse_keys("oms:AIza-oms, app:AIza-app,AIzaPlain1234") == {
        "AIza-oms": "oms", "AIza-app": "app", "AIzaPlain1234": "key-1234"}
    assert parse_keys("") == {}


def test_rate_limiter_burst_then_block():
    lim = RateLimiter(rps=1, burst=2)
    assert [lim.allow("oms") for _ in range(3)] == [True, True, False]
    assert lim.allow("app")  # mỗi hệ thống một bucket riêng


def test_rate_limiter_disabled():
    lim = RateLimiter(rps=0, burst=0)
    assert all(lim.allow("x") for _ in range(100))
