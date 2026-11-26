"""Ghi log yêu cầu vào schema ops qua hàng đợi chạy nền, không chặn đường xử lý của API.

Hàng đợi có giới hạn; khi đầy hoặc DB lỗi thì bỏ bản ghi và tăng metric `bds_log_dropped_total`,
không bao giờ làm API lỗi theo.
"""

from __future__ import annotations

import logging
import queue
import re
import threading
import time
from functools import lru_cache

import psycopg

from bds.config import settings
from bds.ops.metrics import LOG_DROPPED

log = logging.getLogger(__name__)

# Số điện thoại Việt Nam lẫn trong chuỗi địa chỉ (0xx... hoặc +84...), có thể có dấu cách/chấm/gạch.
_PHONE = re.compile(r"(?<!\d)(?:\+?84|0)(?:[\s.\-]?\d){8,10}(?!\d)")

TABLE_COLUMNS = {
    "geocode_log": ("request_id", "client", "api", "order_id", "query", "lat", "lon", "level", "confidence",
                    "source", "admin_source", "ward_code", "province_code", "latency_ms"),
    "suggest_log": ("request_id", "client", "api", "session_token", "query", "place_ids", "latency_ms"),
    "place_select_log": ("request_id", "client", "session_token", "place_id"),
    "route_log": ("request_id", "client", "api", "kind", "vehicle", "n_sources", "n_targets", "fallback_cells",
                  "latency_ms"),
    "shadow_compare": ("request_id", "client", "reference", "reference_location_type", "distance_m"),
}


def mask_pii(text: str | None) -> str | None:
    return _PHONE.sub("[SĐT]", text) if text else text


class RequestLogWriter:
    def __init__(self, dsn: str, max_queue: int = 50_000, batch: int = 500, flush_s: float = 1.0):
        self.dsn, self.batch, self.flush_s = dsn, batch, flush_s
        self.q: queue.Queue[tuple[str, dict]] = queue.Queue(maxsize=max_queue)
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="request-log-writer", daemon=True)
        self._thread.start()

    def write(self, table: str, row: dict) -> None:
        try:
            self.q.put_nowait((table, row))
        except queue.Full:
            LOG_DROPPED.labels(reason="queue_full").inc()

    def flush(self, timeout_s: float = 5.0) -> None:
        """Chờ hàng đợi ghi hết (dùng trong test và khi tắt server)."""
        end = time.monotonic() + timeout_s
        while not self.q.empty() and time.monotonic() < end:
            time.sleep(0.02)
        time.sleep(self.flush_s + 0.1)

    def _run(self) -> None:
        conn = None
        while not self._stop.is_set():
            items = self._drain()
            if not items:
                continue
            try:
                if conn is None or conn.closed:
                    conn = psycopg.connect(self.dsn, autocommit=True)
                self._insert(conn, items)
            except psycopg.Error as e:
                log.warning("không ghi được log yêu cầu: %s", e)
                LOG_DROPPED.labels(reason="db_error").inc(len(items))
                conn = None

    def _drain(self) -> list[tuple[str, dict]]:
        items: list[tuple[str, dict]] = []
        deadline = time.monotonic() + self.flush_s
        while len(items) < self.batch:
            try:
                items.append(self.q.get(timeout=max(0.0, deadline - time.monotonic())))
            except queue.Empty:
                break
        return items

    @staticmethod
    def _insert(conn: psycopg.Connection, items: list[tuple[str, dict]]) -> None:
        by_table: dict[str, list[tuple]] = {}
        for table, row in items:
            by_table.setdefault(table, []).append(tuple(row.get(c) for c in TABLE_COLUMNS[table]))
        with conn.cursor() as cur:
            for table, rows in by_table.items():
                cols = TABLE_COLUMNS[table]
                cur.executemany(
                    f"INSERT INTO ops.{table} ({', '.join(cols)}) VALUES ({', '.join(['%s'] * len(cols))}) "
                    "ON CONFLICT DO NOTHING", rows)


@lru_cache
def writer() -> RequestLogWriter:
    return RequestLogWriter(settings().pg_dsn)
