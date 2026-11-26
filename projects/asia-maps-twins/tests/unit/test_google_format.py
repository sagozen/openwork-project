import pytest

from bds.compat import google_format as gf
from bds.text.polyline import decode, encode

# Ví dụ chính thức trong tài liệu "Encoded Polyline Algorithm Format" của Google.
GOOGLE_POINTS = [(38.5, -120.2), (40.7, -120.95), (43.252, -126.453)]
GOOGLE_ENCODED = "_p~iF~ps|U_ulLnnqC_mqNvxq`@"


def test_polyline_matches_google_reference():
    assert encode(GOOGLE_POINTS) == GOOGLE_ENCODED
    assert decode(GOOGLE_ENCODED) == GOOGLE_POINTS


def test_polyline6_to_polyline5_roundtrip():
    pts = [(21.028511, 105.854201), (21.036812, 105.834215)]
    back = decode(encode(decode(encode(pts, 6), 6)), 5)
    assert all(abs(a - c) < 1e-5 and abs(b - d) < 1e-5 for (a, b), (c, d) in zip(pts, back, strict=True))


@pytest.mark.parametrize("meters, lang, text, value", [
    (850.4, "vi", "850 m", 850),
    (12345, "vi", "12,3 km", 12345),
    (12345, "en", "12.3 km", 12345),
])
def test_fmt_distance(meters, lang, text, value):
    assert gf.fmt_distance(meters, lang) == {"text": text, "value": value}


@pytest.mark.parametrize("seconds, lang, text", [
    (20, "vi", "1 phút"),
    (900, "vi", "15 phút"),
    (3900, "vi", "1 giờ 5 phút"),
    (3900, "en", "1 hour 5 mins"),
    (93600, "vi", "1 ngày 2 giờ"),
])
def test_fmt_duration(seconds, lang, text):
    assert gf.fmt_duration(seconds, lang)["text"] == text


def test_matched_substrings_on_original_text_without_diacritics():
    label = "Phố Huế, Phường Hai Bà Trưng, Thành phố Hà Nội"
    assert gf.matched_substrings(label, "pho hue") == [{"offset": 0, "length": 3}, {"offset": 4, "length": 3}]


def test_terms_offsets():
    assert gf.terms("Phố Huế, Phường Hai Bà Trưng, Hà Nội") == [
        {"offset": 0, "value": "Phố Huế"}, {"offset": 9, "value": "Phường Hai Bà Trưng"},
        {"offset": 30, "value": "Hà Nội"}]


@pytest.mark.parametrize("text, expected", [
    ("21.0285,105.8542", (21.0285, 105.8542)),
    ("21.0285, 105.8542", (21.0285, 105.8542)),
    ("Hà Nội", None),
    ("91,0", None),
])
def test_parse_latlng(text, expected):
    assert gf.parse_latlng(text) == expected


def test_house_text():
    assert gf.house_text("12", [("ngo", "34"), ("ngach", "5")]) == "12 Ngõ 34 Ngách 5"
    assert gf.house_text("25b", []) == "25B"
    assert gf.house_text(None, []) is None
