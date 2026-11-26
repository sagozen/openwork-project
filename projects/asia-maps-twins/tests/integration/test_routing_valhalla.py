"""Khoảng cách thực tế qua Valhalla với dữ liệu OSM Việt Nam."""

import random
import time

import pytest

from bds.config import settings
from bds.routing.engine import (
    CompositeEngine,
    OsrmMatrixEngine,
    Point,
    RoutingService,
    ValhallaEngine,
    haversine_m,
)

pytestmark = pytest.mark.integration

HO_GUOM = Point(21.0285, 105.8542)
LANG_BAC = Point(21.0368, 105.8342)


@pytest.fixture(scope="module")
def svc(valhalla_up):
    s = settings()
    return RoutingService(CompositeEngine(ValhallaEngine(s.valhalla_url, timeout_s=30),
                                          OsrmMatrixEngine(s.osrm_url, timeout_s=30)))


@pytest.mark.parametrize("vehicle", ["car", "motorbike", "truck"])
def test_route_real_road(svc, vehicle):
    r = svc.route([HO_GUOM, LANG_BAC], vehicle)
    assert r.source == "valhalla"
    straight = haversine_m(HO_GUOM, LANG_BAC)
    assert straight < r.distance_m < straight * 2.5
    assert 60 < r.duration_s < 1800


def test_motorbike_avoids_motorway(svc):
    # Hà Nội → Hải Phòng: ô tô đi cao tốc, xe máy không được đi nên quãng đường/thời gian khác.
    hn, hp = Point(21.0285, 105.8542), Point(20.8449, 106.6881)
    car, moto = svc.route([hn, hp], "car"), svc.route([hn, hp], "motorbike")
    assert car.source == moto.source == "valhalla"
    assert moto.duration_s > car.duration_s


def test_matrix_100x100_under_2s(svc):
    rng = random.Random(1)
    pts = [Point(10.72 + rng.random() * 0.12, 106.62 + rng.random() * 0.12) for _ in range(100)]
    t0 = time.perf_counter()
    m = svc.matrix(pts, pts, "motorbike")
    took = time.perf_counter() - t0
    fallback = sum(row.count("fallback") for row in m.source)
    print(f"matrix 100x100: {took:.2f}s, fallback cells {fallback}")
    assert len(m.distance_m) == 100 and len(m.distance_m[0]) == 100
    assert fallback < 100
    assert took < 2.0
