"""Ghi log + metric cho mọi lời gọi, dùng chung giữa API gốc /v1 và API tương thích Google.

`ctx` là ngữ cảnh của yêu cầu hiện tại (request_id, hệ thống gọi, order_id, trạng thái), do middleware tạo.
Endpoint đồng bộ chạy trong threadpool nhận bản sao contextvar nhưng cùng một đối tượng dict, nên ghi vào
dict này middleware vẫn đọc được sau khi endpoint trả về.
"""

from __future__ import annotations

import uuid
from contextvars import ContextVar

from bds.geocode.resolver import GeocodeResult
from bds.ops.metrics import GEOCODE_LEVEL, ROUTING_FALLBACK
from bds.ops.request_log import mask_pii, writer
from bds.routing.engine import Point, haversine_m

_ctx: ContextVar[dict | None] = ContextVar("bds_request_ctx", default=None)


def new_ctx(request_id: str | None, order_id: str | None) -> dict:
    try:
        rid = str(uuid.UUID(request_id)) if request_id else str(uuid.uuid4())
    except ValueError:
        rid = str(uuid.uuid4())
    ctx = {"request_id": rid, "client": "-", "order_id": order_id, "status": None}
    _ctx.set(ctx)
    return ctx


def ctx() -> dict:
    current = _ctx.get()
    if current is None:  # gọi ngoài HTTP (test, CLI)
        current = new_ctx(None, None)
    return current


def record_geocode(api: str, query: str, r: GeocodeResult, latency_ms: float, order_id: str | None = None,
                   reference: dict | None = None) -> None:
    c = ctx()
    GEOCODE_LEVEL.labels(level=r.level).inc()
    writer().write("geocode_log", {
        "request_id": c["request_id"], "client": c["client"], "api": api,
        "order_id": order_id or c.get("order_id"), "query": mask_pii(query)[:500],
        "lat": r.lat, "lon": r.lon, "level": r.level, "confidence": r.confidence, "source": r.source,
        "admin_source": r.admin.get("source"), "ward_code": r.admin.get("ward_code"),
        "province_code": r.admin.get("province_code"), "latency_ms": round(latency_ms, 2),
    })
    if reference and r.lat is not None:
        # Chỉ lưu khoảng cách tới nguồn tham chiếu, không lưu toạ độ của nguồn đó.
        writer().write("shadow_compare", {
            "request_id": c["request_id"], "client": c["client"], "reference": reference["source"],
            "reference_location_type": reference.get("location_type"),
            "distance_m": round(haversine_m(Point(r.lat, r.lon), Point(reference["lat"], reference["lng"])), 1),
        })


def record_suggest(api: str, query: str, place_ids: list[str], latency_ms: float,
                   session_token: str | None) -> None:
    c = ctx()
    writer().write("suggest_log", {
        "request_id": c["request_id"], "client": c["client"], "api": api, "session_token": session_token,
        "query": mask_pii(query)[:200], "place_ids": place_ids, "latency_ms": round(latency_ms, 2),
    })


def record_select(place_id: str, session_token: str | None) -> None:
    c = ctx()
    writer().write("place_select_log", {"request_id": c["request_id"], "client": c["client"],
                                        "session_token": session_token, "place_id": place_id})


def record_route(api: str, kind: str, vehicle: str, n_sources: int, n_targets: int, fallback_cells: int,
                 latency_ms: float) -> None:
    c = ctx()
    if fallback_cells:
        ROUTING_FALLBACK.labels(kind=kind).inc(fallback_cells)
    writer().write("route_log", {
        "request_id": c["request_id"], "client": c["client"], "api": api, "kind": kind, "vehicle": vehicle,
        "n_sources": n_sources, "n_targets": n_targets, "fallback_cells": fallback_cells,
        "latency_ms": round(latency_ms, 2),
    })
