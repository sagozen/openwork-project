"""API của base: gợi ý địa chỉ, phân giải địa chỉ, khoảng cách thực tế.

Mọi yêu cầu có request_id (header X-Request-Id, tự sinh nếu thiếu, trả lại trong response) và được ghi log
vào schema ops. Hệ thống gọi xác định bằng key (header X-API-Key hoặc tham số `key`).
"""

from __future__ import annotations

import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from prometheus_client import CONTENT_TYPE_LATEST, CollectorRegistry, generate_latest, multiprocess
from pydantic import BaseModel, Field

from bds.api.deps import GEOCODE_CACHE, resolve_address, routing
from bds.compat.google import router as google_router
from bds.config import settings
from bds.db import pool
from bds.learn import llm, registry
from bds.ops import recording
from bds.ops.auth import authenticate
from bds.ops.metrics import LATENCY, REQUESTS
from bds.ops.request_log import writer
from bds.routing.engine import Point
from bds.suggest.service import PgSuggestIndex


@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield
    writer().flush()  # ghi nốt log còn trong hàng đợi trước khi tắt


STATIC = Path(__file__).parent / "static"
app = FastAPI(title="Bản đồ số — base API", version="0.2.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=[o.strip() for o in settings().cors_origins.split(",")],
                   allow_methods=["GET", "POST"], allow_headers=["*"], expose_headers=["X-Request-Id"])
app.include_router(google_router)


@app.middleware("http")
async def request_context(request: Request, call_next):
    ctx = recording.new_ctx(request.headers.get("x-request-id"), request.headers.get("x-order-id"))
    t0 = time.perf_counter()
    response = await call_next(request)
    route = request.scope.get("route")
    endpoint = route.path if route is not None else "unmatched"
    if endpoint not in ("/metrics", "/health"):
        LATENCY.labels(endpoint=endpoint).observe(time.perf_counter() - t0)
        REQUESTS.labels(endpoint=endpoint, client=ctx["client"],
                        status=ctx["status"] or str(response.status_code)).inc()
    response.headers["X-Request-Id"] = ctx["request_id"]
    return response


def v1_client(key: str | None = Query(None, include_in_schema=False),
              x_api_key: str | None = Header(None)) -> str:
    auth = authenticate(x_api_key or key)
    recording.ctx()["client"] = auth.client or "-"
    if auth.error in ("missing_key", "invalid_key"):
        raise HTTPException(401, "API key thiếu hoặc không hợp lệ")
    if auth.error == "rate_limited":
        raise HTTPException(429, "Vượt giới hạn tốc độ")
    return auth.client


class LatLon(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)


Vehicle = Literal["car", "motorbike", "truck"]


class RouteRequest(BaseModel):
    points: list[LatLon] = Field(min_length=2, max_length=25)
    vehicle: Vehicle = "motorbike"


class MatrixRequest(BaseModel):
    sources: list[LatLon] = Field(min_length=1, max_length=200)
    targets: list[LatLon] = Field(min_length=1, max_length=200)
    vehicle: Vehicle = "motorbike"


@app.get("/health")
def health():
    with pool().connection() as conn:
        conn.execute("SELECT 1")
    return {"status": "ok"}


@app.get("/demo", include_in_schema=False)
def demo():
    """Trang demo trực quan cho ba năng lực lõi và API chuẩn Google."""
    return FileResponse(STATIC / "demo.html")


@app.get("/metrics", include_in_schema=False)
def metrics():
    # Chạy nhiều worker (uvicorn --workers) thì mỗi worker có bộ đếm riêng: gộp qua thư mục multiprocess.
    if os.environ.get("PROMETHEUS_MULTIPROC_DIR"):
        registry = CollectorRegistry()
        multiprocess.MultiProcessCollector(registry)
        return Response(generate_latest(registry), media_type=CONTENT_TYPE_LATEST)
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.get("/v1/suggest")
def suggest(q: str = Query(min_length=1, max_length=200), limit: int = Query(10, ge=1, le=20),
            lat: float | None = None, lon: float | None = None, province_code: str | None = None,
            session_token: str | None = None, _client: str = Depends(v1_client)):
    t0 = time.perf_counter()
    near = (lat, lon) if lat is not None and lon is not None else None
    with pool().connection() as conn:
        items = PgSuggestIndex(conn).suggest(q, limit, near, province_code)
    took = (time.perf_counter() - t0) * 1000
    recording.record_suggest("v1", q, [i.ref for i in items], took, session_token)
    return {"query": q, "items": [i.to_dict() for i in items], "took_ms": round(took, 1)}


@app.get("/v1/geocode")
def geocode(address: str = Query(min_length=2, max_length=500), order_id: str | None = None,
            ref_lat: float | None = None, ref_lng: float | None = None, ref_source: str = "google",
            ref_type: str | None = None, _client: str = Depends(v1_client)):
    """`order_id`: để đối chiếu với GPS phát. `ref_*`: kết quả của nguồn tham chiếu khi chạy shadow
    (chỉ khoảng cách được lưu, toạ độ tham chiếu không được lưu)."""
    t0 = time.perf_counter()
    with pool().connection() as conn:
        result, cached = resolve_address(conn, address)
    took = (time.perf_counter() - t0) * 1000
    reference = ({"source": ref_source, "lat": ref_lat, "lng": ref_lng, "location_type": ref_type}
                 if ref_lat is not None and ref_lng is not None else None)
    recording.record_geocode("v1", address, result, took, order_id, reference)
    return {**result.to_dict(), "cached": cached, "request_id": recording.ctx()["request_id"],
            "took_ms": round(took, 1)}


@app.get("/v1/geocode/explain")
def geocode_explain(address: str = Query(min_length=2, max_length=500), _client: str = Depends(v1_client)):
    """Giải thích từng tầng: chuẩn hoá, nhận diện hành chính, nhãn của tagger, các ứng viên và xác suất."""
    t0 = time.perf_counter()
    with pool().connection() as conn:
        result, _ = resolve_address(conn, address, trace=True)
    return {**result.to_dict(), "took_ms": round((time.perf_counter() - t0) * 1000, 1)}


@app.get("/v1/ml/status")
def ml_status(_client: str = Depends(v1_client)):
    """Mô hình đang dùng, nhãn đã có theo nguồn, hàng chờ người duyệt, cache."""
    with pool().connection() as conn:
        models = conn.execute(
            "SELECT DISTINCT ON (kind) kind, version, metrics, reason, created_at FROM ml.model "
            "WHERE promoted ORDER BY kind, created_at DESC").fetchall()
        history = conn.execute("SELECT kind, version, promoted, reason, created_at FROM ml.model "
                               "ORDER BY created_at DESC LIMIT 10").fetchall()
        labels = conn.execute("SELECT source, status, count(*) n FROM ml.label GROUP BY 1, 2 ORDER BY 1, 2").fetchall()
    registry.current("tagger"), registry.current("decision")
    return {"models": models, "history": history, "labels": labels, "llm_configured": llm.configured(),
            "cache": GEOCODE_CACHE.stats(), "loaded_versions": registry.versions()}


@app.post("/v1/route")
def route(req: RouteRequest, _client: str = Depends(v1_client)):
    t0 = time.perf_counter()
    try:
        r = routing().route([Point(p.lat, p.lon) for p in req.points], req.vehicle)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    recording.record_route("v1", "route", req.vehicle, len(req.points), 0, int(r.source == "fallback"),
                           (time.perf_counter() - t0) * 1000)
    return {"distance_m": round(r.distance_m, 1), "duration_s": round(r.duration_s, 1), "source": r.source,
            "vehicle": req.vehicle, "shape": r.shape}


@app.post("/v1/matrix")
def matrix(req: MatrixRequest, _client: str = Depends(v1_client)):
    if len(req.sources) * len(req.targets) > 10_000:
        raise HTTPException(400, "tối đa 10.000 ô (ví dụ 100×100)")
    t0 = time.perf_counter()
    m = routing().matrix([Point(p.lat, p.lon) for p in req.sources], [Point(p.lat, p.lon) for p in req.targets],
                         req.vehicle)
    took = (time.perf_counter() - t0) * 1000
    recording.record_route("v1", "matrix", req.vehicle, len(req.sources), len(req.targets),
                           sum(row.count("fallback") for row in m.source), took)
    return {"distance_m": m.distance_m, "duration_s": m.duration_s, "source": m.source, "vehicle": req.vehicle,
            "took_ms": round(took, 1)}
