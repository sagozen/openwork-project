"""Tầng 2: cache kết quả phân giải trong bộ nhớ từng tiến trình (LRU có hạn dùng).

Khoá gồm chuỗi đã chuẩn hoá và phiên bản mô hình, nên khi mô hình mới được đưa vào dùng, kết quả cũ tự hết hiệu lực.
"""

from __future__ import annotations

import threading
import time
from collections import OrderedDict

from bds.ops.metrics import CACHE


class TTLCache:
    def __init__(self, maxsize: int = 50_000, ttl_s: float = 3600.0):
        self.maxsize, self.ttl_s = maxsize, ttl_s
        self._data: OrderedDict = OrderedDict()
        self._lock = threading.Lock()
        self.hits = self.misses = 0

    def get(self, key):
        with self._lock:
            item = self._data.get(key)
            if item and time.monotonic() - item[0] < self.ttl_s:
                self._data.move_to_end(key)
                self.hits += 1
                CACHE.labels(result="hit").inc()
                return item[1]
            self.misses += 1
            CACHE.labels(result="miss").inc()
            return None

    def put(self, key, value) -> None:
        with self._lock:
            self._data[key] = (time.monotonic(), value)
            self._data.move_to_end(key)
            while len(self._data) > self.maxsize:
                self._data.popitem(last=False)

    def stats(self) -> dict:
        total = self.hits + self.misses
        return {"size": len(self._data), "hits": self.hits, "misses": self.misses,
                "hit_ratio": round(self.hits / total, 3) if total else None}
