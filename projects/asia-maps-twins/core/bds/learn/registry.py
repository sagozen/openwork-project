"""Nạp mô hình đang dùng (phiên bản promoted mới nhất) cho API, tự nạp lại khi có phiên bản mới."""

from __future__ import annotations

import logging
import time
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

from bds.config import settings

log = logging.getLogger(__name__)
CHECK_EVERY_S = 60.0
_cache: dict[str, tuple[float, str | None, object | None]] = {}


def current_row(conn, kind: str) -> dict | None:
    return conn.execute("SELECT version, path, metrics FROM ml.model WHERE kind = %s AND promoted "
                        "ORDER BY created_at DESC LIMIT 1", (kind,)).fetchone()


def _load(kind: str, path: str):
    if kind == "tagger":
        from bds.learn.tagger import Tagger
        return Tagger(Path(path))
    from bds.learn.decision import DecisionModel
    return DecisionModel.load(Path(path))


def current(kind: str):
    """Mô hình đang dùng, hoặc None nếu chưa huấn luyện / không đọc được (khi đó hệ thống chạy như chỉ có luật)."""
    checked, version, model = _cache.get(kind, (0.0, None, None))
    if time.monotonic() - checked < CHECK_EVERY_S:
        return model
    try:
        with psycopg.connect(settings().pg_dsn, autocommit=True, row_factory=dict_row) as conn:
            row = current_row(conn, kind)
        if row and row["version"] != version and Path(row["path"]).exists():
            model, version = _load(kind, row["path"]), row["version"]
            log.info("đã nạp mô hình %s %s", kind, version)
    except (psycopg.Error, OSError) as e:
        log.warning("không nạp được mô hình %s: %s", kind, e)
    _cache[kind] = (time.monotonic(), version, model)
    return model


def versions() -> dict[str, str | None]:
    return {k: v[1] for k, v in _cache.items()}
