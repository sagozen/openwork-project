"""Nhận diện đơn vị hành chính 2 cấp, kể cả địa chỉ cũ 3 cấp. Đáp án lấy từ bảng chuyển đổi 2025."""

import pytest

from bds.admin.resolve import resolve_admin


@pytest.mark.parametrize("address, ward, province, source", [
    ("Số 12 ngõ 34 Phố Huế, Phường Hai Bà Trưng, Thành phố Hà Nội", "Phường Hai Bà Trưng", "Thành phố Hà Nội", "new"),
    ("so 12 ngo 34 pho hue phuong hai ba trung ha noi", "Phường Hai Bà Trưng", "Thành phố Hà Nội", "new"),
    ("Phường Bến Thành, TP Hồ Chí Minh", "Phường Bến Thành", "Thành phố Hồ Chí Minh", "new"),
    # Địa chỉ cũ 3 cấp → đơn vị mới.
    ("59 Nguyễn Huệ, P. Bến Nghé, Q.1, TP.HCM", "Phường Sài Gòn", "Thành phố Hồ Chí Minh", "legacy_converted"),
    ("59 nguyen hue p ben nghe q1 tphcm", "Phường Sài Gòn", "Thành phố Hồ Chí Minh", "legacy_converted"),
    ("123/45 Nguyễn Trãi, Phường 2, Quận 5, Hồ Chí Minh", "Phường Chợ Quán", "Thành phố Hồ Chí Minh", "legacy_converted"),
])
def test_ward_resolution(address, ward, province, source):
    m = resolve_admin(address)
    assert (m.ward, m.province, m.source) == (ward, province, source)
    assert m.lat and m.lon and m.ward_code


def test_legacy_address_is_not_matched_to_same_named_new_ward():
    """'xã Tân Lập, huyện Đan Phượng' (cũ) không được khớp nhầm sang 'Xã Đan Phượng' (mới)."""
    m = resolve_admin("Thôn Đông, xã Tân Lập, huyện Đan Phượng, Hà Nội")
    assert m.source == "legacy_converted"
    assert m.ward != "Xã Đan Phượng"


def test_old_province_maps_to_new_province():
    m = resolve_admin("ngõ 1 Trần Phú, Bắc Giang")
    assert m.province == "Tỉnh Bắc Ninh"


def test_province_only_has_low_confidence():
    m = resolve_admin("Hà Nội")
    assert m.ward is None and m.province == "Thành phố Hà Nội"
    assert m.source == "province_only" and m.confidence <= 0.3
    assert m.lat is not None


def test_new_format_has_higher_confidence_than_converted():
    assert resolve_admin("Phường Bến Thành, TP Hồ Chí Minh").confidence > \
        resolve_admin("P. Bến Nghé, Q.1, TP.HCM").confidence


def test_street_text_is_returned():
    m = resolve_admin("Số 12 ngõ 34 Phố Huế, Phường Hai Bà Trưng, Hà Nội")
    assert "Phố Huế" in m.street_text
