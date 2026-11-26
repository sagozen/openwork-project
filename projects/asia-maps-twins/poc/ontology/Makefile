PG_DSN ?= postgresql://postgres:poc@127.0.0.1:55432/bds

.PHONY: generate db test

generate:
	mkdir -p generated
	uv run gen-pydantic ontology/bds.yaml > generated/models.py
	uv run gen-json-schema ontology/bds.yaml > generated/bds.schema.json
	uv run python -m generator.gen_postgres ontology/bds.yaml > generated/schema.sql
	uv run python -m generator.gen_ai_tools > generated/ai_tools.json

db:
	docker start bds-poc-postgis 2>/dev/null || docker run -d --name bds-poc-postgis \
		-e POSTGRES_PASSWORD=poc -e POSTGRES_DB=bds -p 127.0.0.1:55432:5432 imresamu/postgis:17-3.5

test: generate
	BDS_PG_DSN=$(PG_DSN) uv run pytest -q
