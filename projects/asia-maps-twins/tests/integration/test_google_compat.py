"""Tương thích Google Maps: dùng chính thư viện `googlemaps` chính thức của Google, chỉ đổi base_url.

Nếu thư viện này chạy được không cần sửa, thì app/web/backend đang gọi Google cũng chỉ cần đổi host.
"""

import threading
import time
import uuid

import googlemaps
import httpx
import pytest
import uvicorn
from googlemaps.convert import decode_polyline

from bds.api.app import app
from bds.config import settings
from bds.routing.engine import Point, haversine_m

pytestmark = pytest.mark.integration

PORT = 8801
BASE = f"http://127.0.0.1:{PORT}"
KEY = "AIza-bds-test-key"
HO_GUOM = (21.0285, 105.8542)
LANG_BAC = (21.0368, 105.8342)


@pytest.fixture(scope="module")
def server(conn, valhalla_up):
    settings().api_keys = KEY
    srv = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=PORT, log_level="warning"))
    thread = threading.Thread(target=srv.run, daemon=True)
    thread.start()
    for _ in range(100):
        if srv.started:
            break
        time.sleep(0.05)
    yield BASE
    srv.should_exit = True
    thread.join(timeout=5)
    settings().api_keys = ""


@pytest.fixture(scope="module")
def gmaps(server):
    return googlemaps.Client(key=KEY, base_url=server, retry_over_query_limit=False)


def near(loc, lat, lng, max_m):
    return haversine_m(Point(loc["lat"], loc["lng"]), Point(lat, lng)) <= max_m


# ---------- Geocoding ----------
def test_geocode(gmaps):
    results = gmaps.geocode("Phố Huế, Phường Hai Bà Trưng, Hà Nội")
    r = results[0]
    assert r["geometry"]["location_type"] in ("GEOMETRIC_CENTER", "RANGE_INTERPOLATED", "ROOFTOP")
    assert near(r["geometry"]["location"], 21.0135, 105.8513, 1500)
    assert "Phố Huế" in r["formatted_address"] and r["formatted_address"].endswith("Việt Nam")
    types = {t for c in r["address_components"] for t in c["types"]}
    assert {"route", "administrative_area_level_1", "country"} <= types
    assert 0 < r["bds"]["confidence"] <= 1


def test_geocode_legacy_address_is_partial_match(gmaps):
    r = gmaps.geocode("59 Nguyễn Huệ, P. Bến Nghé, Q.1, TP.HCM")[0]
    assert r.get("partial_match") is True
    assert "Phường Sài Gòn" in r["formatted_address"]


def test_geocode_zero_results(gmaps):
    assert gmaps.geocode("xyz không có gì ở đây") == []


def test_geocode_with_components(gmaps):
    r = gmaps.geocode("Phố Huế", components={"administrative_area": "Hà Nội", "country": "VN"})[0]
    assert near(r["geometry"]["location"], 21.0135, 105.8513, 3000)


def test_reverse_geocode(gmaps):
    results = gmaps.reverse_geocode(HO_GUOM)
    assert results and results[-1]["types"] == ["administrative_area_level_1", "political"]
    assert "Hà Nội" in results[0]["formatted_address"]


# ---------- Places ----------
def test_autocomplete_then_details(gmaps):
    token = str(uuid.uuid4())
    preds = gmaps.places_autocomplete("pho hue ha noi", session_token=token, components={"country": "vn"})
    assert preds and any("Phố Huế" in p["description"] for p in preds)
    p = next(p for p in preds if "Phố Huế" in p["description"])
    assert p["structured_formatting"]["main_text"] == "Phố Huế"
    assert p["matched_substrings"]
    details = gmaps.place(p["place_id"], session_token=token, fields=["geometry", "formatted_address", "name"])
    assert details["status"] == "OK"
    assert near(details["result"]["geometry"]["location"], 21.0135, 105.8513, 2000)


def test_autocomplete_types_filter(gmaps):
    preds = gmaps.places_autocomplete("ben thanh", types="(regions)")
    assert preds and all(set(p["types"]) & {"administrative_area_level_1", "administrative_area_level_3"}
                         for p in preds)


def test_autocomplete_location_bias(gmaps):
    preds = gmaps.places_autocomplete("le loi", location=(10.7745, 106.7020), radius=5000)
    assert "Hồ Chí Minh" in preds[0]["description"]


def test_query_autocomplete(gmaps):
    assert gmaps.places_autocomplete_query("cho ben thanh")


def test_details_not_found(gmaps):
    with pytest.raises(googlemaps.exceptions.ApiError) as err:
        gmaps.place("khong_ton_tai")
    assert err.value.status == "NOT_FOUND"


# ---------- Distance Matrix ----------
def test_distance_matrix_mixed_inputs(gmaps):
    m = gmaps.distance_matrix(origins=[HO_GUOM, "Phường Bến Thành, TP Hồ Chí Minh"],
                              destinations=[LANG_BAC], mode="driving")
    assert m["status"] == "OK" and len(m["rows"]) == 2
    e = m["rows"][0]["elements"][0]
    assert e["status"] == "OK" and e["distance"]["value"] > 1000 and e["duration"]["value"] > 60
    assert e["distance"]["text"].endswith(("km", "m"))
    assert "Hà Nội" in m["origin_addresses"][0]
    assert m["rows"][1]["elements"][0]["distance"]["value"] > 1_000_000  # TP.HCM → Hà Nội


def test_distance_matrix_motorbike_extension(server):
    body = httpx.get(f"{server}/maps/api/distancematrix/json",
                     params={"origins": "21.0285,105.8542", "destinations": "20.8449,106.6881",
                             "mode": "two_wheeler", "key": KEY}).json()
    assert body["status"] == "OK" and body["rows"][0]["elements"][0]["bds_source"] in ("osrm", "fallback")


def test_distance_matrix_not_found_element(gmaps):
    m = gmaps.distance_matrix(origins=["xyz không có gì"], destinations=[LANG_BAC])
    assert m["rows"][0]["elements"][0]["status"] == "NOT_FOUND"


# ---------- Directions ----------
def test_directions_with_waypoint(gmaps):
    routes = gmaps.directions(HO_GUOM, LANG_BAC, waypoints=[(21.0245, 105.8412)], mode="driving")
    route = routes[0]
    assert len(route["legs"]) == 2
    leg = route["legs"][0]
    assert leg["distance"]["value"] > 0 and leg["duration"]["value"] > 0
    pts = decode_polyline(route["overview_polyline"]["points"])
    assert near(pts[0], *HO_GUOM, 300) and near(pts[-1], *LANG_BAC, 300)
    assert route["bds_source"] == "valhalla"


def test_directions_not_found(gmaps):
    with pytest.raises(googlemaps.exceptions.ApiError) as err:
        gmaps.directions("xyz không có gì", LANG_BAC)
    assert err.value.status == "NOT_FOUND"


# ---------- Key và lỗi đầu vào ----------
def test_wrong_key_is_denied(server):
    bad = googlemaps.Client(key="AIza-sai-key", base_url=server, retry_over_query_limit=False)
    with pytest.raises(googlemaps.exceptions.ApiError) as err:
        bad.geocode("Hà Nội")
    assert err.value.status == "REQUEST_DENIED"


def test_invalid_request_shape(server):
    body = httpx.get(f"{server}/maps/api/geocode/json", params={"key": KEY}).json()
    assert body["status"] == "INVALID_REQUEST" and body["results"] == [] and body["error_message"]
