"""Xác thực theo hệ thống gọi và giới hạn tốc độ.

BDS_API_KEYS có dạng "oms:AIza...,app:AIza..." (tên hệ thống : key). Key không kèm tên được đặt tên "key-xxxx"
theo 4 ký tự cuối. Để trống thì không kiểm tra key (môi trường dev, mọi yêu cầu mang tên "dev").
Giới hạn tốc độ là token bucket trong bộ nhớ của từng tiến trình; chạy nhiều bản thì cần chuyển sang Valkey.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass

from bds.config import settings
from bds.ops.metrics import RATE_LIMITED


@dataclass
class AuthResult:
    client: str | None
    error: str | None = None     # missing_key | invalid_key | rate_limited


def parse_keys(raw: str) -> dict[str, str]:
    """key -> tên hệ thống."""
    out = {}
    for item in (x.strip() for x in raw.split(",")):
        if not item:
            continue
        name, sep, key = item.rpartition(":")
        if not sep:
            name, key = f"key-{item[-4:]}", item
        out[key] = name
    return out


class RateLimiter:
    def __init__(self, rps: float, burst: float):
        self.rps, self.burst = rps, burst
        self._state: dict[str, tuple[float, float]] = {}
        self._lock = threading.Lock()

    def allow(self, client: str) -> bool:
        if self.rps <= 0:
            return True
        now = time.monotonic()
        with self._lock:
            tokens, last = self._state.get(client, (self.burst, now))
            tokens = min(self.burst, tokens + (now - last) * self.rps)
            if tokens < 1:
                self._state[client] = (tokens, now)
                return False
            self._state[client] = (tokens - 1, now)
            return True


_limiter: RateLimiter | None = None


def limiter() -> RateLimiter:
    global _limiter
    s = settings()
    if _limiter is None or (_limiter.rps, _limiter.burst) != (s.rate_limit_rps, s.rate_limit_rps * 2):
        _limiter = RateLimiter(s.rate_limit_rps, s.rate_limit_rps * 2)
    return _limiter


def authenticate(key: str | None) -> AuthResult:
    keys = parse_keys(settings().api_keys)
    if not keys:
        client = "dev"
    elif not key:
        return AuthResult(None, "missing_key")
    elif key not in keys:
        return AuthResult(None, "invalid_key")
    else:
        client = keys[key]
    if not limiter().allow(client):
        RATE_LIMITED.labels(client=client).inc()
        return AuthResult(client, "rate_limited")
    return AuthResult(client)
