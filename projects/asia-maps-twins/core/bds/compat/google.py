"""API tương thích Google Maps Platform (Web Service API bản legacy).

Cùng đường dẫn, tham số và cấu trúc JSON với maps.googleapis.com, nên app/web/backend đang gọi Google chỉ cần
đổi host. Hỗ trợ: Geocoding (thuận + ngược), Place Autocomplete, Query Autocomplete, Place Details,
Distance Matrix, Directions. Mỗi kết quả có thêm khối `bds` (mức, độ tin cậy, nguồn); client cũ bỏ qua khối này.

Như Google, lỗi nghiệp vụ trả HTTP 200 kèm `status` (ZERO_RESULTS, INVALID_REQUEST, REQUEST_DENIED...).
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Query
from psycopg import Connection

from bds.api.deps import resolve_address, routing
from bds.compat import google_format as gf
from bds.config import settings
from bds.db import pool
from bds.geocode.resolver import GeocodeResult
from bds.geocode.reverse import ReverseHit, reverse_geocode
from bds.ops import recording
from bds.ops.auth import authenticate
from bds.routing.engine import Point, haversine_m
from bds.suggest.service import PgSuggestIndex
from bds.text.polyline import decode, encode

router = APIRouter(prefix="/maps/api", tags=["Tương thích Google Maps"])

MODE_VEHICLE = {"driving": None, "two_wheeler": "motorbike", "motorbike": "motorbike", "truck": "truck"}
TRAVEL_MODE = {"car": "DRIVING", "motorbike": "TWO_WHEELER", "truck": "DRIVING"}
COPYRIGHT = "Dữ liệu bản đồ © OpenStreetMap contributors"


# ---------- tiện ích chung ----------
def _status(status: str, message: str | None = None, **body: Any) -> dict:
    recording.ctx()["status"] = status
    out = {**body, "status": status}
    if message:
        out["error_message"] = message
    return out


def _denied(key: str | None) -> dict | None:
    auth = authenticate(key)
    recording.ctx()["client"] = auth.client or "-"
    if auth.error == "missing_key":
        return _status("REQUEST_DENIED", "Thiếu tham số key.")
    if auth.error == "invalid_key":
        return _status("REQUEST_DENIED", "API key không hợp lệ.")
    if auth.error == "rate_limited":
        return _status("OVER_QUERY_LIMIT", "Vượt giới hạn tốc độ của key.")
    return None


def _vehicle(mode: str | None) -> str | None:
    mode = (mode or "driving").lower()
    if mode not in MODE_VEHICLE:
        return None
    return MODE_VEHICLE[mode] or settings().google_driving_vehicle


def _gc_place_id(lat: float, lon: float) -> str:
    return f"gc_{lat:.6f}_{lon:.6f}"


# ---------- kết quả geocode ----------
def _geocode_result(conn: Connection, r: GeocodeResult) -> dict:
    a, c = r.admin, r.components
    house = gf.house_text(c.get("house_no"), c.get("alleys") or []) if r.level in (
        "ROOFTOP", "RANGE_INTERPOLATED", "STREET") else None
    route = r.matched_name if r.level in ("ROOFTOP", "RANGE_INTERPOLATED", "STREET") else None
    place = r.matched_name if r.level == "PLACE" else None
    first = " ".join(p for p in (house, route) if p) or place
    names = gf.admin_names(conn, a.get("ward_code"), a.get("province_code"))
    ward = names.get(a.get("ward_code"))
    province = names.get(a.get("province_code"))
    if r.level == "WARD_CENTROID":
        delta, place_id = gf.ward_delta(ward["area_km2"] if ward else None), f"au_{a['ward_code']}"
    elif r.level == "PROVINCE_CENTROID":
        delta, place_id = gf.VIEWPORT_DELTA["province"], f"au_{a['province_code']}"
    else:
        delta, place_id = gf.VIEWPORT_DELTA.get(r.level, 0.003), _gc_place_id(r.lat, r.lon)
    asked_finer = (c.get("house_no") and r.level not in ("ROOFTOP", "RANGE_INTERPOLATED")) or \
                  (c.get("street") and r.level in ("WARD_CENTROID", "PROVINCE_CENTROID"))
    components = gf.address_components(conn, house_no=house if route else None, route=route or place,
                                       ward_code=a.get("ward_code"), province_code=a.get("province_code"))
    result = {
        "address_components": components,
        "formatted_address": gf.formatted_address(first, ward["name"] if ward else None,
                                                  province["name"] if province else None),
        "geometry": {"location": gf.latlng(r.lat, r.lon), "location_type": gf.LOCATION_TYPE[r.level],
                     "viewport": gf.viewport(r.lat, r.lon, delta)},
        "place_id": place_id,
        "types": gf.LEVEL_TYPES[r.level],
        "bds": {"level": r.level, "confidence": r.confidence, "source": r.source,
                "admin_source": a.get("source"), "notes": r.notes},
    }
    if asked_finer or a.get("source") != "new":
        result["partial_match"] = True
    return result


def _reverse_result(conn: Connection, h: ReverseHit) -> dict:
    if h.kind == "address":
        first, types, ltype, delta = f"{h.house_no} {h.street}", ["street_address"], "ROOFTOP", 0.0014
        comps = {"house_no": h.house_no, "route": h.street}
    elif h.kind == "street":
        first, types, ltype, delta = h.street, ["route"], "GEOMETRIC_CENTER", 0.005
        comps = {"house_no": None, "route": h.street}
    elif h.kind == "ward":
        first, types, ltype, delta = None, gf.WARD_TYPES, "APPROXIMATE", 0.02
        comps = {"house_no": None, "route": None}
    else:
        return {
            "address_components": gf.address_components(conn, house_no=None, route=None, ward_code=None,
                                                        province_code=h.province_code),
            "formatted_address": gf.formatted_address(h.province),
            "geometry": {"location": gf.latlng(h.lat, h.lon), "location_type": "APPROXIMATE",
                         "viewport": gf.viewport(h.lat, h.lon, 0.5)},
            "place_id": f"au_{h.province_code}", "types": gf.PROVINCE_TYPES,
        }
    return {
        "address_components": gf.address_components(conn, ward_code=h.ward_code, province_code=h.province_code,
                                                    **comps),
        "formatted_address": gf.formatted_address(first, h.ward, h.province),
        "geometry": {"location": gf.latlng(h.lat, h.lon), "location_type": ltype,
                     "viewport": gf.viewport(h.lat, h.lon, delta)},
        "place_id": f"au_{h.ward_code}" if h.kind == "ward" else _gc_place_id(h.lat, h.lon),
        "types": types,
    }


def _place_result(conn: Connection, place_id: str) -> dict | None:
    """Kết quả Place Details cho mọi loại place_id do base phát ra."""
    if place_id.startswith("gc_"):
        try:
            _, lat, lon = place_id.split("_")
            hits = reverse_geocode(conn, float(lat), float(lon))
        except ValueError:
            return None
        if not hits:
            return None
        res = _reverse_result(conn, hits[0])
        res["geometry"]["location"] = gf.latlng(float(lat), float(lon))
        res["place_id"] = place_id
        res["name"] = res["formatted_address"].split(", ")[0]
        return res
    item = PgSuggestIndex(conn).get(place_id)
    if not item:
        return None
    first = item.label.split(", ")[0]
    house_no = route = None
    if item.kind == "address":
        house_no, _, route = first.partition(" ")
    elif item.kind == "street":
        route = first
    names = gf.admin_names(conn, item.ward_code, item.province_code)
    if item.kind == "ward":
        delta = gf.ward_delta(names[item.ward_code]["area_km2"] if item.ward_code in names else None)
    else:
        delta = gf.VIEWPORT_DELTA.get(item.kind, 0.003)
    return {
        "address_components": gf.address_components(conn, house_no=house_no, route=route,
                                                    ward_code=item.ward_code, province_code=item.province_code),
        "formatted_address": gf.formatted_address(item.label),
        "geometry": {"location": gf.latlng(item.lat, item.lon), "viewport": gf.viewport(item.lat, item.lon, delta)},
        "name": first,
        "place_id": item.ref,
        "types": gf.KIND_TYPES[item.kind],
        "vicinity": ", ".join(item.label.split(", ")[1:]) or item.label,
    }


def _resolve_location(conn: Connection, text: str) -> tuple[Point, str, str, list] | None:
    """Đầu vào kiểu Google: "lat,lng", "place_id:XXX" hoặc địa chỉ chữ."""
    text = text.strip()
    if text.startswith("place_id:"):
        res = _place_result(conn, text[len("place_id:"):])
        if not res:
            return None
        loc = res["geometry"]["location"]
        return Point(loc["lat"], loc["lng"]), res["formatted_address"], res["place_id"], res["types"]
    if (ll := gf.parse_latlng(text)) is not None:
        hits = reverse_geocode(conn, *ll)
        formatted = _reverse_result(conn, hits[0])["formatted_address"] if hits else text
        return Point(*ll), formatted, _gc_place_id(*ll), ["street_address"]
    r, _ = resolve_address(conn, text)
    if r.level == "NOT_FOUND":
        return None
    res = _geocode_result(conn, r)
    return Point(r.lat, r.lon), res["formatted_address"], res["place_id"], res["types"]


# ---------- Geocoding API ----------
@router.get("/geocode/json")
def geocode(address: str | None = None, latlng: str | None = None, place_id: str | None = None,
            components: str | None = None, result_type: str | None = None, location_type: str | None = None,
            key: str | None = None, language: str | None = None, region: str | None = None,
            order_id: str | None = None, ref_lat: float | None = None, ref_lng: float | None = None,
            ref_source: str = "google", ref_type: str | None = None):
    """Mở rộng ngoài Google: `order_id` (đối chiếu GPS phát), `ref_*` (kết quả nguồn tham chiếu khi chạy
    shadow; chỉ khoảng cách được lưu)."""
    if denied := _denied(key):
        return denied
    t0 = time.perf_counter()
    with pool().connection() as conn:
        if latlng:
            ll = gf.parse_latlng(latlng)
            if ll is None:
                return _status("INVALID_REQUEST", "latlng phải có dạng 'lat,lng'.", results=[])
            results = [_reverse_result(conn, h) for h in reverse_geocode(conn, *ll)]
            if result_type:
                wanted = set(result_type.split("|"))
                results = [r for r in results if wanted & set(r["types"])]
            if location_type:
                wanted = set(location_type.split("|"))
                results = [r for r in results if r["geometry"].get("location_type") in wanted]
            return _status("OK" if results else "ZERO_RESULTS", results=results)
        if place_id:
            res = _place_result(conn, place_id)
            return _status("OK", results=[res]) if res else _status("ZERO_RESULTS", results=[])
        text = address or ""
        if components:
            for comp in components.split("|"):
                name, _, value = comp.partition(":")
                if name == "country" and value.lower() not in ("vn", "vietnam", "việt nam"):
                    return _status("ZERO_RESULTS", results=[])
                if name in ("administrative_area", "locality", "route") and value.lower() not in text.lower():
                    text = f"{text}, {value}" if text else value
        if not text:
            return _status("INVALID_REQUEST", "Cần address, latlng, place_id hoặc components.", results=[])
        r, _ = resolve_address(conn, text)
        reference = ({"source": ref_source, "lat": ref_lat, "lng": ref_lng, "location_type": ref_type}
                     if ref_lat is not None and ref_lng is not None else None)
        recording.record_geocode("google", text, r, (time.perf_counter() - t0) * 1000, order_id, reference)
        if r.level == "NOT_FOUND":
            return _status("ZERO_RESULTS", results=[])
        return _status("OK", results=[_geocode_result(conn, r)])


# ---------- Places API: Autocomplete, Query Autocomplete, Details ----------
def _autocomplete(input: str, location: str | None, offset: int | None, types: str | None,
                  components: str | None, key: str | None, origin: str | None,
                  session_token: str | None = None) -> dict:
    if denied := _denied(key):
        return denied
    t0 = time.perf_counter()
    if not input.strip():
        return _status("INVALID_REQUEST", "Thiếu tham số input.", predictions=[])
    if components and not any(c.split(":")[-1].lower() == "vn" for c in components.split("|")
                              if c.startswith("country:")):
        return _status("ZERO_RESULTS", predictions=[])
    text = input[:offset] if offset else input
    near = gf.parse_latlng(location) if location else None
    allowed = gf.AUTOCOMPLETE_TYPES.get(types) if types else None
    with pool().connection() as conn:
        items = PgSuggestIndex(conn).suggest(text, limit=20 if allowed else 5, near=near)
    if allowed:
        items = [i for i in items if i.kind in allowed][:5]
    recording.record_suggest("google", text, [i.ref for i in items], (time.perf_counter() - t0) * 1000,
                             session_token)
    origin_pt = gf.parse_latlng(origin) if origin else None
    predictions = []
    for i in items:
        main, _, secondary = i.label.partition(", ")
        p = {
            "description": i.label,
            "matched_substrings": gf.matched_substrings(i.label, text),
            "place_id": i.ref,
            "reference": i.ref,
            "structured_formatting": {"main_text": main, "secondary_text": secondary,
                                      "main_text_matched_substrings": gf.matched_substrings(main, text)},
            "terms": gf.terms(i.label),
            "types": gf.KIND_TYPES[i.kind],
        }
        if origin_pt:
            p["distance_meters"] = int(haversine_m(Point(*origin_pt), Point(i.lat, i.lon)))
        predictions.append(p)
    return _status("OK" if predictions else "ZERO_RESULTS", predictions=predictions)


@router.get("/place/autocomplete/json")
def place_autocomplete(input: str = Query(""), sessiontoken: str | None = None, location: str | None = None,
                       radius: float | None = None, offset: int | None = None, types: str | None = None,
                       components: str | None = None, strictbounds: bool = False, origin: str | None = None,
                       language: str | None = None, key: str | None = None):
    return _autocomplete(input, location, offset, types, components, key, origin, sessiontoken)


@router.get("/place/queryautocomplete/json")
def query_autocomplete(input: str = Query(""), location: str | None = None, radius: float | None = None,
                       offset: int | None = None, language: str | None = None, key: str | None = None):
    return _autocomplete(input, location, offset, None, None, key, None)


@router.get("/place/details/json")
def place_details(place_id: str = Query(""), placeid: str = Query(""), fields: str | None = None,
                  sessiontoken: str | None = None, language: str | None = None, key: str | None = None):
    if denied := _denied(key):
        return denied
    place_id = place_id or placeid  # Google nhận cả tên cũ `placeid` (thư viện googlemaps dùng tên này)
    if not place_id:
        return _status("INVALID_REQUEST", "Thiếu tham số place_id.")
    with pool().connection() as conn:
        res = _place_result(conn, place_id)
    if not res:
        return _status("NOT_FOUND", "Không tìm thấy place_id.", html_attributions=[])
    recording.record_select(place_id, sessiontoken)
    return _status("OK", html_attributions=[], result=res)


# ---------- Distance Matrix API ----------
@router.get("/distancematrix/json")
def distance_matrix(origins: str = Query(""), destinations: str = Query(""), mode: str | None = None,
                    language: str = "vi", units: str | None = None, avoid: str | None = None,
                    departure_time: str | None = None, key: str | None = None):
    if denied := _denied(key):
        return denied
    o_texts = [t for t in origins.split("|") if t.strip()]
    d_texts = [t for t in destinations.split("|") if t.strip()]
    if not o_texts or not d_texts:
        return _status("INVALID_REQUEST", "Cần origins và destinations.", rows=[])
    if len(o_texts) > 200 or len(d_texts) > 200:
        return _status("MAX_DIMENSIONS_EXCEEDED", "Tối đa 200 điểm mỗi phía.", rows=[])
    if len(o_texts) * len(d_texts) > 10_000:
        return _status("MAX_ELEMENTS_EXCEEDED", "Tối đa 10.000 phần tử.", rows=[])
    vehicle = _vehicle(mode)
    if vehicle is None:
        return _status("INVALID_REQUEST", f"mode '{mode}' chưa hỗ trợ (driving, two_wheeler, truck).", rows=[])
    t0 = time.perf_counter()
    with pool().connection() as conn:
        o_res = [_resolve_location(conn, t) for t in o_texts]
        d_res = [_resolve_location(conn, t) for t in d_texts]
    o_ok = [i for i, r in enumerate(o_res) if r]
    d_ok = [j for j, r in enumerate(d_res) if r]
    matrix = routing().matrix([o_res[i][0] for i in o_ok], [d_res[j][0] for j in d_ok], vehicle) \
        if o_ok and d_ok else None
    rows = []
    for i in range(len(o_texts)):
        elements = []
        for j in range(len(d_texts)):
            if i not in o_ok or j not in d_ok:
                elements.append({"status": "NOT_FOUND"})
                continue
            oi, dj = o_ok.index(i), d_ok.index(j)
            elements.append({"distance": gf.fmt_distance(matrix.distance_m[oi][dj], language),
                             "duration": gf.fmt_duration(matrix.duration_s[oi][dj], language),
                             "status": "OK", "bds_source": matrix.source[oi][dj]})
        rows.append({"elements": elements})
    recording.record_route("google", "matrix", vehicle, len(o_texts), len(d_texts),
                           sum(row.count("fallback") for row in matrix.source) if matrix else 0,
                           (time.perf_counter() - t0) * 1000)
    return _status("OK", destination_addresses=[r[1] if r else "" for r in d_res],
                   origin_addresses=[r[1] if r else "" for r in o_res], rows=rows)


# ---------- Directions API ----------
@router.get("/directions/json")
def directions(origin: str = Query(""), destination: str = Query(""), waypoints: str | None = None,
               mode: str | None = None, language: str = "vi", alternatives: bool = False,
               avoid: str | None = None, units: str | None = None, departure_time: str | None = None,
               key: str | None = None):
    if denied := _denied(key):
        return denied
    if not origin or not destination:
        return _status("INVALID_REQUEST", "Cần origin và destination.", routes=[], geocoded_waypoints=[])
    vehicle = _vehicle(mode)
    if vehicle is None:
        return _status("INVALID_REQUEST", f"mode '{mode}' chưa hỗ trợ (driving, two_wheeler, truck).",
                       routes=[], geocoded_waypoints=[])
    t0 = time.perf_counter()
    via = [w.removeprefix("via:") for w in (waypoints or "").split("|") if w and not w.startswith("optimize:")]
    texts = [origin, *via, destination]
    with pool().connection() as conn:
        resolved = [_resolve_location(conn, t) for t in texts]
    geocoded = [{"geocoder_status": "OK", "place_id": r[2], "types": r[3]} if r else
                {"geocoder_status": "ZERO_RESULTS"} for r in resolved]
    if not all(resolved):
        return _status("NOT_FOUND", "Không phân giải được ít nhất một điểm.", routes=[],
                       geocoded_waypoints=geocoded)
    pts = [r[0] for r in resolved]
    route = routing().route(pts, vehicle)
    legs, overview = [], []
    for k, leg in enumerate(route.legs):
        a, b = pts[k], pts[k + 1]
        line = decode(leg.shape, 6) if leg.shape else [(a.lat, a.lon), (b.lat, b.lon)]
        overview += line if not overview else line[1:]
        start, end = line[0], line[-1]
        legs.append({
            "distance": gf.fmt_distance(leg.distance_m, language),
            "duration": gf.fmt_duration(leg.duration_s, language),
            "end_address": resolved[k + 1][1], "end_location": gf.latlng(*end),
            "start_address": resolved[k][1], "start_location": gf.latlng(*start),
            "steps": [{
                "distance": gf.fmt_distance(leg.distance_m, language),
                "duration": gf.fmt_duration(leg.duration_s, language),
                "end_location": gf.latlng(*end), "start_location": gf.latlng(*start),
                "html_instructions": "", "polyline": {"points": encode(line)},
                "travel_mode": TRAVEL_MODE[vehicle],
            }],
            "traffic_speed_entry": [], "via_waypoint": [],
        })
    recording.record_route("google", "route", vehicle, len(pts), 0, int(route.source == "fallback"),
                           (time.perf_counter() - t0) * 1000)
    warnings = ["Khoảng cách và thời gian là ước lượng (engine không tìm được đường)."] \
        if route.source == "fallback" else []
    return _status("OK", geocoded_waypoints=geocoded, routes=[{
        "bounds": gf.bounds(overview), "copyrights": COPYRIGHT, "legs": legs,
        "overview_polyline": {"points": encode(overview)}, "summary": "", "warnings": warnings,
        "waypoint_order": list(range(len(via))), "bds_source": route.source,
    }])
