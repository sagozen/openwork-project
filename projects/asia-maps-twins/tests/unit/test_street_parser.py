import pytest

from bds.geocode.street_parser import parse_street_part
from bds.text.normalize import normalize_address


def parse(raw):
    return parse_street_part(normalize_address(raw))


@pytest.mark.parametrize("raw, house, alleys, street", [
    ("Số 12 ngõ 34 Phố Huế", "12", [("ngo", "34")], "hue"),
    ("12 ngõ 34 ngách 5 Láng Hạ", "12", [("ngo", "34"), ("ngach", "5")], "lang ha"),
    ("Ngõ 1 Trần Phú", None, [("ngo", "1")], "tran phu"),
    ("123/45 Nguyễn Trãi", "123/45", [], "nguyen trai"),
    ("59 Nguyễn Huệ", "59", [], "nguyen hue"),
    ("25B Đường Lê Lợi", "25b", [], "le loi"),
    ("Kiệt 12 Hùng Vương", None, [("kiet", "12")], "hung vuong"),
    ("hẻm 51 Cao Thắng", None, [("hem", "51")], "cao thang"),
    ("Đường 3/2", None, [], "3/2"),
    ("Quốc lộ 1A", None, [], "quoc lo 1a"),
])
def test_house_alley_street(raw, house, alleys, street):
    p = parse(raw)
    assert (p.house_no, p.alleys, p.street) == (house, alleys, street)


@pytest.mark.parametrize("raw, hamlet", [
    ("Thôn Đông", "thon dong"),
    ("Xóm 3", "xom 3"),
    ("Ấp Bình Hoà", "ap binh hoa"),
    ("TDP 5", "to dan pho 5"),
    ("Khu phố 2", "khu pho 2"),
])
def test_hamlet(raw, hamlet):
    assert parse(raw).hamlet == hamlet


@pytest.mark.parametrize("raw, place_type, place", [
    ("KCN Quế Võ", "khu cong nghiep", "que vo"),
    ("Toà nhà Keangnam, Phạm Hùng", "toa nha", "keangnam"),
    ("Chợ Bến Thành", "cho", "ben thanh"),
    ("Chung cư Hoàng Anh Gia Lai", "chung cu", "hoang anh gia lai"),
])
def test_place(raw, place_type, place):
    p = parse(raw)
    assert (p.place_type, p.place) == (place_type, place)


def test_lot_code_before_street():
    p = parse("LKN-12 Đường 2B")
    assert (p.house_no, p.street) == ("lkn-12", "2b")


def test_place_and_street_together():
    p = parse("Toà nhà Keangnam, Phạm Hùng")
    assert p.street == "pham hung"


def test_house_number_value():
    assert parse("123/45 Nguyễn Trãi").house_number_value == 123
    assert parse("25B Lê Lợi").house_number_value == 25
