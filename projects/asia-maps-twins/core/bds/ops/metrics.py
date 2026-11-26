"""Metric Prometheus của base (đọc ở /metrics)."""

from prometheus_client import Counter, Histogram

REQUESTS = Counter("bds_requests_total", "Số yêu cầu", ["endpoint", "client", "status"])
LATENCY = Histogram("bds_request_latency_seconds", "Độ trễ xử lý", ["endpoint"],
                    buckets=(0.005, 0.01, 0.025, 0.05, 0.08, 0.1, 0.15, 0.25, 0.5, 1, 2, 5))
GEOCODE_LEVEL = Counter("bds_geocode_level_total", "Kết quả phân giải theo mức", ["level"])
ROUTING_FALLBACK = Counter("bds_routing_fallback_total", "Số giá trị khoảng cách phải dùng dự phòng", ["kind"])
LOG_DROPPED = Counter("bds_log_dropped_total", "Số bản ghi log bị bỏ", ["reason"])
RATE_LIMITED = Counter("bds_rate_limited_total", "Số yêu cầu bị chặn vì vượt giới hạn", ["client"])
CACHE = Counter("bds_geocode_cache_total", "Tra cache phân giải", ["result"])
