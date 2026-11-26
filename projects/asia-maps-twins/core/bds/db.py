"""Kết nối PostgreSQL dùng chung (pool)."""

from __future__ import annotations

from functools import lru_cache

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from bds.config import settings


@lru_cache
def pool() -> ConnectionPool:
    return ConnectionPool(settings().pg_dsn, min_size=1, max_size=10, kwargs={"row_factory": dict_row}, open=True)
