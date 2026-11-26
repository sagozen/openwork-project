# Image API của base. Build: make docker-build. Chạy cùng PostGIS/Valhalla/OSRM: make up (service api).
FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.10.12 /uv /usr/local/bin/uv
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY core ./core
RUN uv sync --frozen --no-dev

ENV PATH="/app/.venv/bin:$PATH" PROMETHEUS_MULTIPROC_DIR=/tmp/prometheus
RUN mkdir -p /tmp/prometheus
EXPOSE 8800
HEALTHCHECK --interval=15s --timeout=3s --retries=5 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8800/health', timeout=2)"
# Mỗi worker có bộ giới hạn tốc độ và hàng đợi log riêng (xem core/bds/ops).
CMD ["uvicorn", "bds.api.app:app", "--host", "0.0.0.0", "--port", "8800", "--workers", "4"]
