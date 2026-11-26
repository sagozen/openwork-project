"""Phụ thuộc dùng chung giữa các router."""

from __future__ import annotations

from functools import lru_cache

from psycopg import Connection

from bds.config import settings
from bds.geocode.cache import TTLCache
from bds.geocode.resolver import Geocoder, GeocodeResult
from bds.learn import registry
from bds.routing.engine import CompositeEngine, OsrmMatrixEngine, RoutingService, ValhallaEngine
from bds.text.normalize import normalize_address

GEOCODE_CACHE = TTLCache()


@lru_cache
def routing() -> RoutingService:
    s = settings()
    return RoutingService(CompositeEngine(ValhallaEngine(s.valhalla_url, s.valhalla_timeout_s),
                                          OsrmMatrixEngine(s.osrm_url, s.osrm_timeout_s)))


def resolve_address(conn: Connection, address: str, trace: bool = False) -> tuple[GeocodeResult, bool]:
    """Phân giải qua đủ các tầng: luật → cache → tagger → mô hình quyết định. Trả (kết quả, có lấy từ cache không).
    Chưa huấn luyện mô hình thì chạy như chỉ có luật."""
    tagger, decision = registry.current("tagger"), registry.current("decision")
    versions = registry.versions()
    key = (normalize_address(address), versions.get("tagger"), versions.get("decision"))
    if not trace and (hit := GEOCODE_CACHE.get(key)) is not None:
        return hit, True
    result = Geocoder(conn).geocode(address, tagger=tagger, decision=decision, trace=trace)
    if not trace:
        GEOCODE_CACHE.put(key, result)
    return result, False
