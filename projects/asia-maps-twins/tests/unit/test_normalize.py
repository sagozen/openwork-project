import pytest

from bds.text.normalize import fold, normalize_address, street_key


@pytest.mark.parametrize("raw, expected", [
    ("Đường Điện Biên Phủ", "duong dien bien phu"),
    ("ĐẶNG  Văn   Ngữ", "dang van ngu"),
    ("Phường Bến Nghé, Q.1", "phuong ben nghe, q. 1"),
    ("Số 12, ngõ 34", "so 12, ngo 34"),
    ("123/45/6 Nguyễn Trãi", "123/45/6 nguyen trai"),
    ("Hồ Gươḿ", "ho guom"),  # dấu tổ hợp thừa
])
def test_fold(raw, expected):
    assert fold(raw) == expected


@pytest.mark.parametrize("raw, expected", [
    ("59 Nguyễn Huệ, P. Bến Nghé, Q.1, TP.HCM", "59 nguyen hue, phuong ben nghe, quan 1, thanh pho ho chi minh"),
    ("12 Lê Lợi P12 Q3 tphcm", "12 le loi phuong 12 quan 3 thanh pho ho chi minh"),
    ("KĐT Ecopark, Văn Giang, Hưng Yên", "khu do thi ecopark, van giang, hung yen"),
    ("KCN Quế Võ", "khu cong nghiep que vo"),
    ("Toà CT1, CC Mỹ Đình", "toa ct1, chung cu my dinh"),
    ("TDP 5, TT. Đông Anh", "to dan pho 5, thi tran dong anh"),
    ("KP 3, TX. Dĩ An", "khu pho 3, thi xa di an"),
    ("Ngõ 1 Trần Phú, TP Bắc Giang", "ngo 1 tran phu, thanh pho bac giang"),
    ("Đ. Láng, Đống Đa, HN", "duong lang, dong da, ha noi"),
    ("SN 25 phố Huế", "so 25 pho hue"),
    ("Phường Sài Gòn, TP.HCM", "phuong sai gon, thanh pho ho chi minh"),
])
def test_normalize_address(raw, expected):
    assert normalize_address(raw) == expected


@pytest.mark.parametrize("name, expected", [
    ("duong nguyen trai", "nguyen trai"),
    ("pho hue", "hue"),
    ("ql 1a", "quoc lo 1a"),
    ("quoc lo 5", "quoc lo 5"),
    ("dt 741", "tinh lo 741"),
    ("dai lo thang long", "thang long"),
])
def test_street_key(name, expected):
    assert street_key(name) == expected
