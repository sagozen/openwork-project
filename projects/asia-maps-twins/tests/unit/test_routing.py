"""Module khoảng cách: gọi Valhalla đúng costing, dự phòng khi lỗi. Dùng phản hồi giả lập, không cần Valhalla."""

import json

import httpx
import pytest

from bds.routing.engine import (
    COSTING,
    CompositeEngine,
    OsrmMatrixEngine,
    Point,
    RoutingService,
    ValhallaEngine,
    fallback_leg,
    haversine_m,
)

HN = Point(21.0285, 105.8542)   # Hồ Gươm
HN2 = Point(21.0368, 105.8342)  # Lăng Bác
HCM = Point(10.7769, 106.7009)


def engine_with(handler) -> ValhallaEngine:
    return ValhallaEngine("http://valhalla", client=httpx.Client(base_url="http://valhalla",
                                                                 transport=httpx.MockTransport(handler)))


def test_haversine_known_distance():
    # Hà Nội – TP.HCM đường chim bay khoảng 1.140 km.
    assert 1_130_000 < haversine_m(HN, HCM) < 1_150_000


def test_route_uses_motor_scooter_costing_for_motorbike():
    seen = {}

    def handler(request):
        seen.update(json.loads(request.content))
        return httpx.Response(200, json={"trip": {"summary": {"length": 2.5, "time": 420},
                                                   "legs": [{"shape": "abc"}]}})

    r = RoutingService(engine_with(handler)).route([HN, HN2], "motorbike")
    assert seen["costing"] == "motor_scooter"
    assert (r.distance_m, r.duration_s, r.source, r.shape) == (2500, 420, "valhalla", "abc")


@pytest.mark.parametrize("vehicle, costing", COSTING.items())
def test_costing_mapping(vehicle, costing):
    seen = {}

    def handler(request):
        seen.update(json.loads(request.content))
        return httpx.Response(200, json={"trip": {"summary": {"length": 1, "time": 60}, "legs": [{}]}})

    RoutingService(engine_with(handler)).route([HN, HN2], vehicle)
    assert seen["costing"] == costing


def test_route_falls_back_when_engine_down():
    def handler(request):
        raise httpx.ConnectError("refused")

    r = RoutingService(engine_with(handler)).route([HN, HN2], "car")
    assert r.source == "fallback"
    assert r.distance_m == pytest.approx(haversine_m(HN, HN2) * 1.35)


def test_route_falls_back_on_http_error():
    r = RoutingService(engine_with(lambda req: httpx.Response(400, json={"error": "no route"}))).route([HN, HN2])
    assert r.source == "fallback"


def test_matrix_fills_unreachable_cells_with_fallback():
    def handler(request):
        return httpx.Response(200, json={"sources_to_targets": [[
            {"distance": 3.0, "time": 600}, {"distance": None, "time": None},
        ]]})

    m = RoutingService(engine_with(handler)).matrix([HN], [HN2, HCM], "truck")
    assert m.distance_m[0][0] == 3000 and m.source[0][0] == "valhalla"
    assert m.source[0][1] == "fallback"
    assert m.distance_m[0][1] == pytest.approx(fallback_leg(HN, HCM, "truck")[0], rel=1e-3)


def test_matrix_falls_back_entirely_when_engine_down():
    def handler(request):
        raise httpx.ReadTimeout("slow")

    m = RoutingService(engine_with(handler)).matrix([HN, HN2], [HCM], "car")
    assert [row[0] for row in m.source] == ["fallback", "fallback"]


def osrm_with(handler) -> OsrmMatrixEngine:
    return OsrmMatrixEngine("http://osrm", client=httpx.Client(base_url="http://osrm",
                                                               transport=httpx.MockTransport(handler)))


def test_osrm_matrix_request_and_parse():
    seen = {}

    def handler(request):
        seen["path"], seen["params"] = request.url.path, dict(request.url.params)
        return httpx.Response(200, json={"code": "Ok", "distances": [[1200.5, None]], "durations": [[180.0, None]]})

    svc = RoutingService(CompositeEngine(engine_with(lambda r: httpx.Response(500)), osrm_with(handler)))
    m = svc.matrix([HN], [HN2, HCM], "motorbike")
    assert seen["path"].startswith("/table/v1/driving/105.854200,21.028500;")
    assert seen["params"]["sources"] == "0" and seen["params"]["destinations"] == "1;2"
    assert seen["params"]["exclude"] == "motorway"
    assert m.distance_m[0][0] == 1200.5 and m.source[0] == ["osrm", "fallback"]


def test_osrm_car_has_no_exclude():
    seen = {}

    def handler(request):
        seen.update(dict(request.url.params))
        return httpx.Response(200, json={"code": "Ok", "distances": [[1.0]], "durations": [[1.0]]})

    osrm_with(handler).matrix([HN], [HN2], "car")
    assert "exclude" not in seen


def test_osrm_error_falls_back():
    def handler(request):
        return httpx.Response(400, json={"code": "TooBig", "message": "Too many table coordinates"})

    m = RoutingService(CompositeEngine(engine_with(lambda r: httpx.Response(500)), osrm_with(handler))).matrix(
        [HN], [HN2], "car")
    assert m.source == [["fallback"]]


def test_composite_routes_through_route_engine():
    def valhalla(request):
        return httpx.Response(200, json={"trip": {"summary": {"length": 2.0, "time": 300}, "legs": [{}]}})

    svc = RoutingService(CompositeEngine(engine_with(valhalla), osrm_with(lambda r: httpx.Response(500))))
    assert svc.route([HN, HN2]).source == "valhalla"


def test_route_requires_two_points():
    with pytest.raises(ValueError):
        RoutingService(engine_with(lambda r: httpx.Response(200))).route([HN])
