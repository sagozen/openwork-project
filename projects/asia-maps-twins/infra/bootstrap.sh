#!/usr/bin/env bash
# Dựng toàn bộ base trên máy local bằng một lệnh: make bootstrap
# Chạy lại nhiều lần được: bước nào đã xong thì bỏ qua.
# Cần: Docker (cấp cho Docker khoảng 16 GB RAM), uv, curl. Lần đầu mất khoảng 20 phút, lần sau vài giây.
set -euo pipefail
cd "$(dirname "$0")/.."

PBF=data/osm/vietnam-latest.osm.pbf
PSQL=(docker exec bds-postgis psql -U postgres -d bds -Atc)
step() { printf '\n\033[1;34m==> %s\033[0m\n' "$1"; }
wait_for() {  # wait_for <mô tả> <số giây> <lệnh...>
  local what=$1 limit=$2; shift 2
  for ((i = 0; i < limit; i += 2)); do "$@" >/dev/null 2>&1 && return 0; sleep 2; done
  echo "Quá thời gian chờ: $what" >&2; return 1
}

step "Kiểm tra công cụ"
command -v docker >/dev/null || { echo "Cần cài Docker"; exit 1; }
command -v uv >/dev/null || { echo "Cần cài uv (https://docs.astral.sh/uv/)"; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker chưa chạy"; exit 1; }

step "Dữ liệu OpenStreetMap Việt Nam"
if [[ -s $PBF ]]; then echo "đã có $PBF"; else
  mkdir -p data/osm
  curl -L --fail -o "$PBF" https://download.geofabrik.de/asia/vietnam-latest.osm.pbf
fi

step "Thư viện Python"
uv sync --quiet

step "Dữ liệu OSRM (ma trận khoảng cách)"
if [[ -s data/osrm/vietnam-latest.osrm.mldgr ]]; then echo "đã có"; else make osrm-build; fi

step "Khởi động PostGIS, Valhalla, OSRM, API"
make docker-build >/dev/null
make up
wait_for "PostGIS" 120 docker exec bds-postgis pg_isready -U postgres -d bds
echo "PostGIS sẵn sàng"
echo "Chờ Valhalla (lần đầu tự dựng tile, khoảng 5 phút)..."
wait_for "Valhalla" 1800 curl -sf http://127.0.0.1:8002/status
echo "Valhalla sẵn sàng"

step "Giới hạn dịch vụ của Valhalla"
if grep -q '"max_matrix_location_pairs": 10000' data/valhalla/valhalla.json; then echo "đã cấu hình"; else
  make valhalla-config
  wait_for "Valhalla sau khi khởi động lại" 300 curl -sf http://127.0.0.1:8002/status
fi

step "Schema và dữ liệu"
make db-init
if [[ "$("${PSQL[@]}" "SELECT coalesce((SELECT count(*) FROM geo.suggest_entry), 0)" 2>/dev/null || echo 0)" -gt 0 ]]; then
  echo "đã nạp dữ liệu"
else
  uv run python -m bds.pipeline.import_admin
  uv run python -m bds.pipeline.import_osm
  uv run python -m bds.pipeline.build_suggest
fi

step "Mô hình hiểu địa chỉ (tagger + mô hình quyết định)"
if [[ "$("${PSQL[@]}" "SELECT count(*) FROM ml.model WHERE promoted" 2>/dev/null || echo 0)" -gt 0 ]]; then
  echo "đã có mô hình"
else
  echo "Huấn luyện lần đầu (khoảng 3 phút)..."
  uv run python -m bds.learn.loop
fi

step "Database cho demo ontology"
if [[ "$(docker exec bds-postgis psql -U postgres -Atc "SELECT 1 FROM pg_database WHERE datname = 'ontology_demo'")" == 1 ]]; then
  echo "đã có"
else
  docker exec bds-postgis createdb -U postgres ontology_demo
fi

step "Kiểm tra nhanh"
wait_for "API" 120 curl -sf http://127.0.0.1:8800/health
curl -sf "http://127.0.0.1:8800/maps/api/geocode/json" --get \
  --data-urlencode "address=59 Nguyễn Huệ, P. Bến Nghé, Q.1, TP.HCM" | grep -o '"formatted_address": *"[^"]*"' | head -1

cat <<'EOF'

Sẵn sàng:
  Trang demo:        http://127.0.0.1:8800/demo
  Tài liệu API:      http://127.0.0.1:8800/docs
  Metric:            http://127.0.0.1:8800/metrics
  Demo ontology:     make ontology-demo
  Tắt toàn bộ:       make down
EOF
