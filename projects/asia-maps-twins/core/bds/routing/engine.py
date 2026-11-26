"""Khoảng cách và thời gian theo đường thật.

`RoutingService` gọi engine (Valhalla). Khi engine lỗi, quá thời gian hoặc không tìm được đường cho
một cặp điểm, kết quả dự phòng = đường chim bay × hệ số đường vòng, chia vận tốc trung bình; mọi giá trị
dự phòng đều được đánh dấu `source = "fallback"` để hệ thống gọi biết mức tin cậy.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from itertools import pairwise
from typing import ClassVar, Literal, Protocol

import httpx

Vehicle = Literal["car", "motorbike", "truck"]
COSTING: dict[str, str] = {"car": "auto", "motorbike": "motor_scooter", "truck": "truck"}
# Hệ số đường vòng và vận tốc trung bình cho dự phòng. Sẽ được học lại từ GPS thực tế khi có dữ liệu.
DETOUR = {"car": 1.35, "motorbike": 1.3, "truck": 1.4}
SPEED_KMH = {"car": 35.0, "motorbike": 28.0, "truck": 30.0}


@dataclass(frozen=True)
class Point:
    lat: float
    lon: float


@dataclass
class Leg:
    distance_m: float
    duration_s: float
    shape: str | None = None  # polyline6 của Valhalla; None khi là kết quả dự phòng


@dataclass
class Route:
    distance_m: float
    duration_s: float
    source: str
    shape: str | None = None  # polyline6 của Valhalla (khi chỉ có một chặng)
    legs: list[Leg] = field(default_factory=list)


@dataclass
class Matrix:
    distance_m: list[list[float]]
    duration_s: list[list[float]]
    source: list[list[str]] = field(default_factory=list)


class EngineError(Exception):
    pass


class RoutingEngine(Protocol):
    def route(self, points: list[Point], vehicle: Vehicle) -> Route: ...
    def matrix(self, sources: list[Point], targets: list[Point], vehicle: Vehicle) -> list[list[tuple[float, float] | None]]: ...


def haversine_m(a: Point, b: Point) -> float:
    r = 6_371_000.0
    p1, p2 = math.radians(a.lat), math.radians(b.lat)
    dp, dl = p2 - p1, math.radians(b.lon - a.lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def fallback_leg(a: Point, b: Point, vehicle: Vehicle) -> tuple[float, float]:
    d = haversine_m(a, b) * DETOUR[vehicle]
    return d, d / (SPEED_KMH[vehicle] / 3.6)


class ValhallaEngine:
    matrix_source = "valhalla"

    def __init__(self, base_url: str, timeout_s: float = 5.0, client: httpx.Client | None = None):
        self.client = client or httpx.Client(base_url=base_url, timeout=timeout_s)

    def _post(self, path: str, body: dict) -> dict:
        try:
            r = self.client.post(path, json=body)
        except httpx.HTTPError as e:
            raise EngineError(f"valhalla không phản hồi: {e}") from e
        if r.status_code != 200:
            raise EngineError(f"valhalla {r.status_code}: {r.text[:200]}")
        return r.json()

    def route(self, points: list[Point], vehicle: Vehicle) -> Route:
        data = self._post("/route", {
            "locations": [{"lat": p.lat, "lon": p.lon} for p in points],
            "costing": COSTING[vehicle], "units": "kilometers", "directions_type": "none",
        })
        trip = data["trip"]
        legs = [Leg(leg["summary"]["length"] * 1000, leg["summary"]["time"], leg.get("shape"))
                for leg in trip.get("legs", []) if "summary" in leg]
        shape = trip["legs"][0].get("shape") if len(trip.get("legs", [])) == 1 else None
        return Route(trip["summary"]["length"] * 1000, trip["summary"]["time"], "valhalla", shape, legs)

    def matrix(self, sources: list[Point], targets: list[Point], vehicle: Vehicle):
        data = self._post("/sources_to_targets", {
            "sources": [{"lat": p.lat, "lon": p.lon} for p in sources],
            "targets": [{"lat": p.lat, "lon": p.lon} for p in targets],
            "costing": COSTING[vehicle], "units": "kilometers",
        })
        rows = data["sources_to_targets"]
        out: list[list[tuple[float, float] | None]] = []
        for row in rows:
            out.append([
                (c["distance"] * 1000, c["time"]) if c.get("distance") is not None and c.get("time") is not None
                else None
                for c in row
            ])
        return out


class OsrmMatrixEngine:
    """Ma trận khoảng cách bằng OSRM (thuật toán MLD), nhanh hơn nhiều so với ma trận của Valhalla.

    OSRM chỉ có profile ô tô. Xe máy được xấp xỉ bằng profile ô tô loại bỏ cao tốc (`exclude=motorway`,
    đúng luật xe máy không đi cao tốc); xe tải dùng profile ô tô. Thời gian xe máy/xe tải vì thế là ước lượng.
    """

    EXCLUDE: ClassVar[dict[str, str | None]] = {"car": None, "motorbike": "motorway", "truck": None}
    matrix_source = "osrm"

    def __init__(self, base_url: str, timeout_s: float = 5.0, client: httpx.Client | None = None):
        self.client = client or httpx.Client(base_url=base_url, timeout=timeout_s)

    def route(self, points: list[Point], vehicle: Vehicle) -> Route:
        raise EngineError("OsrmMatrixEngine chỉ dùng cho ma trận")

    def matrix(self, sources: list[Point], targets: list[Point], vehicle: Vehicle):
        coords = ";".join(f"{p.lon:.6f},{p.lat:.6f}" for p in [*sources, *targets])
        params = {
            "sources": ";".join(str(i) for i in range(len(sources))),
            "destinations": ";".join(str(len(sources) + j) for j in range(len(targets))),
            "annotations": "distance,duration",
        }
        if self.EXCLUDE[vehicle]:
            params["exclude"] = self.EXCLUDE[vehicle]
        try:
            r = self.client.get(f"/table/v1/driving/{coords}", params=params)
        except httpx.HTTPError as e:
            raise EngineError(f"osrm không phản hồi: {e}") from e
        data = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        if r.status_code != 200 or data.get("code") != "Ok":
            raise EngineError(f"osrm {r.status_code}: {data.get('message', r.text[:200])}")
        return [
            [(d, t) if d is not None and t is not None else None for d, t in zip(drow, trow)]
            for drow, trow in zip(data["distances"], data["durations"])
        ]


class CompositeEngine:
    """Tuyến đường qua một engine (Valhalla: có costing xe máy), ma trận qua engine khác (OSRM: nhanh)."""

    def __init__(self, route_engine: RoutingEngine, matrix_engine: RoutingEngine):
        self.route_engine, self.matrix_engine = route_engine, matrix_engine
        self.matrix_source = getattr(matrix_engine, "matrix_source", "engine")

    def route(self, points: list[Point], vehicle: Vehicle) -> Route:
        return self.route_engine.route(points, vehicle)

    def matrix(self, sources: list[Point], targets: list[Point], vehicle: Vehicle):
        return self.matrix_engine.matrix(sources, targets, vehicle)


class RoutingService:
    def __init__(self, engine: RoutingEngine):
        self.engine = engine

    def route(self, points: list[Point], vehicle: Vehicle = "motorbike") -> Route:
        if len(points) < 2:
            raise ValueError("cần ít nhất 2 điểm")
        try:
            return self.engine.route(points, vehicle)
        except (EngineError, KeyError, IndexError):
            legs = [Leg(*fallback_leg(a, b, vehicle)) for a, b in pairwise(points)]
            return Route(sum(leg.distance_m for leg in legs), sum(leg.duration_s for leg in legs), "fallback",
                         legs=legs)

    def matrix(self, sources: list[Point], targets: list[Point], vehicle: Vehicle = "motorbike") -> Matrix:
        if not sources or not targets:
            raise ValueError("cần ít nhất 1 điểm nguồn và 1 điểm đích")
        try:
            cells = self.engine.matrix(sources, targets, vehicle)
        except (EngineError, KeyError):
            cells = [[None] * len(targets) for _ in sources]
        dist, dur, src = [], [], []
        for i, row in enumerate(cells):
            drow, trow, srow = [], [], []
            for j, cell in enumerate(row):
                if cell is None:
                    d, t = fallback_leg(sources[i], targets[j], vehicle)
                    srow.append("fallback")
                else:
                    d, t = cell
                    srow.append(getattr(self.engine, "matrix_source", "engine"))
                drow.append(round(d, 1))
                trow.append(round(t, 1))
            dist.append(drow)
            dur.append(trow)
            src.append(srow)
        return Matrix(dist, dur, src)
