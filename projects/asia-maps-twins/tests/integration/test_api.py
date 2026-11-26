"""Hợp đồng API của ba năng lực lõi (gọi qua FastAPI TestClient, cần PostGIS + Valhalla)."""

import pytest
from fastapi.testclient import TestClient

from bds.api.app import app

pytestmark = pytest.mark.integration


@pytest.fixture(scope="module")
def client(conn):
    return TestClient(app)


def test_health(client):
    assert client.get("/health").json() == {"status": "ok"}


def test_suggest_contract(client):
    body = client.get("/v1/suggest", params={"q": "pho hue ha noi", "limit": 5}).json()
    assert 0 < len(body["items"]) <= 5
    item = body["items"][0]
    assert {"label", "kind", "lat", "lon", "ward_code", "province_code", "score"} <= set(item)


def test_geocode_contract(client):
    body = client.get("/v1/geocode", params={"address": "Phố Huế, Phường Hai Bà Trưng, Hà Nội"}).json()
    assert {"lat", "lon", "level", "confidence", "source", "admin", "components"} <= set(body)
    assert body["admin"]["ward_code"] and 0 < body["confidence"] <= 1


def test_geocode_rejects_empty(client):
    assert client.get("/v1/geocode", params={"address": ""}).status_code == 422


def test_route_contract(client, valhalla_up):
    body = client.post("/v1/route", json={"points": [{"lat": 21.0285, "lon": 105.8542},
                                                     {"lat": 21.0368, "lon": 105.8342}],
                                          "vehicle": "motorbike"}).json()
    assert body["source"] == "valhalla" and body["distance_m"] > 0 and body["duration_s"] > 0


def test_route_validates_input(client):
    assert client.post("/v1/route", json={"points": [{"lat": 21.0, "lon": 105.8}]}).status_code == 422
    assert client.post("/v1/route", json={"points": [{"lat": 99, "lon": 0}, {"lat": 0, "lon": 0}]}).status_code == 422


def test_matrix_contract(client, valhalla_up):
    pts = [{"lat": 21.0285, "lon": 105.8542}, {"lat": 21.0368, "lon": 105.8342}]
    body = client.post("/v1/matrix", json={"sources": pts, "targets": pts, "vehicle": "car"}).json()
    assert len(body["distance_m"]) == 2 and len(body["distance_m"][0]) == 2
    assert body["distance_m"][0][0] == pytest.approx(0, abs=50)


def test_explain_shows_every_layer(client):
    body = client.get("/v1/geocode/explain", params={"address": "toa nha keangnam pham hung nam tu liem hn"}).json()
    t = body["trace"]
    assert t["normalized"] and t["admin"]["province"] and t["candidates"]
    if t["tagger"]:  # đã huấn luyện mô hình (make learn)
        assert len(t["tagger"]["tokens"]) == len(t["tagger"]["labels"]) == len(t["tagger"]["probs"])
        assert t["decision_model"] and all(c["probability"] is not None for c in t["candidates"])
        assert 0 <= body["confidence"] <= 1


def test_second_call_is_cached(client):
    q = {"address": "Phường Bến Thành, TP Hồ Chí Minh"}
    client.get("/v1/geocode", params=q)
    assert client.get("/v1/geocode", params=q).json()["cached"] is True


def test_ml_status(client):
    body = client.get("/v1/ml/status").json()
    assert {"models", "labels", "llm_configured", "cache"} <= set(body)
