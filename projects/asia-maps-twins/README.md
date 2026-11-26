# Asia maps and twins

> Part of [OpenWork](../../README.md).

A self-hosted **map API for Vietnam**, built on OpenStreetMap data, with three core capabilities:

1. **Address suggest**: type-ahead over administrative units, streets, addresses and landmarks.
2. **Address resolve**: turn a free-text address into coordinates with a confidence score, using a cascade of
   rules, cache, a trained tagger and a decision model.
3. **Real road distance**: routes and distance matrices for car, motorbike and truck.

It also exposes a Google Maps Web Service compatible surface, so existing clients can switch by changing the host,
and includes a proof of concept for a **3D city twin** and an ontology-as-code demo.

**Use it as a base for:** a geocoding and routing service you run yourself. It shows how to combine PostGIS,
Valhalla and OSRM behind one FastAPI app, run a shadow-traffic comparison before cutover, and keep an address
parser improving from its own logs.

## Stack

Python 3.12, FastAPI, PostgreSQL with PostGIS, Valhalla (routes), OSRM (matrices), scikit-learn with CRF tagging,
RapidFuzz, MapLibre and deck.gl for the 3D proof of concept. Docs are in Vietnamese.

## Layout

```
core/bds/        The API: suggest, geocode, routing, text, pipeline, ontology, admin, ops, Google-compatible layer
infra/           Docker Compose, bootstrap script, Valhalla limits
poc/ontology/    Ontology-as-code demo (LinkML)
poc/twin-3d/     3D city twin: Python server and a Vite web client
docs/            How-to for the base, Google-compatible API, shadow operation, ADRs (docs/adr)
tests/           Unit tests; integration tests need PostGIS and Valhalla running
research/        Background notes
```

Per the first ADR, `core/` is the shareable part and `connectors/` and `deployments/` were reserved for
company-specific work. Neither is included here.

## Run it

Needs Docker, `uv`, and about 16 GB of RAM for Docker while OSRM builds.

```bash
make bootstrap        # downloads OSM data, builds OSRM and Valhalla, imports, smoke-tests; safe to rerun
open http://127.0.0.1:8800/demo
make test-unit        # unit tests without external services
make ontology-demo
```

Step-by-step setup, measured timings and the three API contracts are in
[docs/huong-dan-base.md](docs/huong-dan-base.md). The Google-compatible endpoints are in
[docs/api-tuong-thich-google.md](docs/api-tuong-thich-google.md).

## License

[MIT](LICENSE). Map data comes from OpenStreetMap contributors (ODbL) and is not included.
