COMPOSE = docker compose -f infra/docker-compose.yml

.PHONY: up down valhalla-config osrm-build db-init import test test-unit eval api lint docker-build \
	backup ops-retention shadow-replay shadow-report bootstrap ontology-demo learn

up:
	mkdir -p data/pg data/valhalla
	@test -e data/valhalla/vietnam-latest.osm.pbf || ln data/osm/vietnam-latest.osm.pbf data/valhalla/vietnam-latest.osm.pbf
	$(COMPOSE) up -d

down:
	$(COMPOSE) down

OSRM_IMG = ghcr.io/project-osrm/osrm-backend:v6.0.0
osrm-build:
	mkdir -p data/osrm
	@test -e data/osrm/vietnam-latest.osm.pbf || ln data/osm/vietnam-latest.osm.pbf data/osrm/vietnam-latest.osm.pbf
	docker run --rm -v "$(PWD)/data/osrm:/data" $(OSRM_IMG) osrm-extract -p /opt/car.lua /data/vietnam-latest.osm.pbf
	docker run --rm -v "$(PWD)/data/osrm:/data" $(OSRM_IMG) osrm-partition /data/vietnam-latest.osrm
	docker run --rm -v "$(PWD)/data/osrm:/data" $(OSRM_IMG) osrm-customize /data/vietnam-latest.osrm

valhalla-config:
	uv run python infra/valhalla_limits.py
	docker restart bds-valhalla

db-init:
	uv run python -m bds.pipeline.migrate

import: db-init
	uv run python -m bds.pipeline.import_admin
	uv run python -m bds.pipeline.import_osm
	uv run python -m bds.pipeline.build_suggest

test-unit:
	uv run pytest -q tests/unit

test:
	uv run pytest -q

eval:
	uv run python -m bds.pipeline.eval_geocode

api:
	uv run uvicorn bds.api.app:app --host 127.0.0.1 --port 8800

lint:
	uv run ruff check core tests

docker-build:
	docker build -t bds-api:local .

# Sao lưu schema ops (log vận hành, không dựng lại được); giữ 14 bản gần nhất.
backup:
	uv run python -m bds.ops.maintenance backup

# Xoá log vận hành quá 180 ngày.
ops-retention:
	uv run python -m bds.ops.maintenance retention

# make shadow-replay FILE=dia-chi.csv [OUT=ket-qua.csv]
shadow-replay:
	uv run python -m bds.ops.shadow_replay $(FILE) $(if $(OUT),--out $(OUT),)

# make shadow-report [DAYS=7]
shadow-report:
	uv run python -m bds.ops.shadow_report $(or $(DAYS),7)

# Dựng toàn bộ base trên máy local (chạy lại nhiều lần được).
bootstrap:
	./infra/bootstrap.sh

# Demo ontology để quay video: make ontology-demo [STEP=1]
ontology-demo:
	cd poc/ontology && $(MAKE) generate >/dev/null && \
	BDS_PG_DSN=postgresql://postgres:bds@127.0.0.1:55433/ontology_demo uv run python demo.py $(if $(STEP),--step,)

# Vòng tự học (chạy mỗi đêm): LLM gán nhãn ca khó → huấn luyện tagger → mô hình quyết định, có cổng chất lượng.
learn:
	uv run python -m bds.learn.loop
