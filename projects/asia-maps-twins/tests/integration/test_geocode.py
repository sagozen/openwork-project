"""Phân giải địa chỉ trên dữ liệu thật (OSM + đơn vị hành chính). Toạ độ tham chiếu là vị trí công khai, gần đúng."""

import pytest

from bds.geocode.resolver import Geocoder
from bds.routing.engine import Point, haversine_m

pytestmark = pytest.mark.integration


def dist(result, lat, lon):
    return haversine_m(Point(result.lat, result.lon), Point(lat, lon))


def test_ward_only_returns_ward_centroid(conn):
    r = Geocoder(conn).geocode("Phường Bến Thành, TP Hồ Chí Minh")
    assert r.level == "WARD_CENTROID" and r.admin["ward"] == "Phường Bến Thành"
    assert dist(r, 10.7713, 106.694) < 1500


def test_street_in_ward(conn):
    r = Geocoder(conn).geocode("Phố Huế, Phường Hai Bà Trưng, Hà Nội")
    assert r.level in ("STREET", "RANGE_INTERPOLATED", "ROOFTOP")
    assert dist(r, 21.0135, 105.8513) < 1500


def test_street_without_diacritics(conn):
    r = Geocoder(conn).geocode("pho hue phuong hai ba trung ha noi")
    assert r.level in ("STREET", "RANGE_INTERPOLATED", "ROOFTOP")
    assert dist(r, 21.0135, 105.8513) < 1500


def test_legacy_three_level_address(conn):
    r = Geocoder(conn).geocode("59 Nguyễn Huệ, P. Bến Nghé, Q.1, TP.HCM")
    assert r.admin["source"] == "legacy_converted"
    assert r.level in ("STREET", "RANGE_INTERPOLATED", "ROOFTOP")
    assert dist(r, 10.7745, 106.7035) < 800


def test_place_market(conn):
    r = Geocoder(conn).geocode("Chợ Bến Thành, Phường Bến Thành, TP.HCM")
    assert r.level == "PLACE"
    assert dist(r, 10.7725, 106.6980) < 400


def test_unknown_address_is_not_found(conn):
    r = Geocoder(conn).geocode("xyz không có gì ở đây")
    assert r.level == "NOT_FOUND" and r.lat is None and r.confidence == 0


def test_confidence_orders_levels(conn):
    g = Geocoder(conn)
    street = g.geocode("Phố Huế, Phường Hai Bà Trưng, Hà Nội")
    ward = g.geocode("Phường Hai Bà Trưng, Hà Nội")
    province = g.geocode("Hà Nội")
    assert street.confidence > ward.confidence > province.confidence


def test_no_diacritics_no_commas_matches_full_form(conn):
    """'59 nguyen hue p ben nghe q1 tphcm': chữ 'p' không được dính vào tên đường."""
    g = Geocoder(conn)
    a, b = g.geocode("59 nguyen hue p ben nghe q1 tphcm"), g.geocode("59 Nguyễn Huệ, P. Bến Nghé, Q.1, TP.HCM")
    assert (a.level, a.matched_name, a.confidence) == (b.level, b.matched_name, b.confidence)


def test_hamlet_is_not_fuzzy_matched_to_unrelated_place(conn):
    """'Thôn Đông' không được khớp nhầm sang 'Đồng Tháp' hay đường 'Đông An Thọ'."""
    r = Geocoder(conn).geocode("Thôn Đông, xã Tân Lập, huyện Đan Phượng, Hà Nội")
    assert r.level == "WARD_CENTROID" and r.admin["source"] == "legacy_converted"


def test_place_type_only_uses_ward_name(conn):
    """'KCN Quế Võ': thư viện hành chính dùng 'Quế Võ' cho phường, phần còn lại chỉ là 'kcn'."""
    r = Geocoder(conn).geocode("KCN Quế Võ, Bắc Ninh")
    assert r.level == "PLACE" and "Quế Võ" in r.matched_name
