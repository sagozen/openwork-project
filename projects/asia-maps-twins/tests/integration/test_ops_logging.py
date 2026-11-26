"""Log vận hành, key theo hệ thống, giới hạn tốc độ, request_id, metric — điều kiện để chạy shadow."""

import uuid

import pytest
from fastapi.testclient import TestClient

from bds.api.app import app
from bds.config import settings
from bds.ops import auth
from bds.ops.request_log import writer

pytestmark = pytest.mark.integration

OMS, APP = "AIza-oms-test", "AIza-app-test"


@pytest.fixture()
def client(conn):
    s = settings()
    old = (s.api_keys, s.rate_limit_rps)
    s.api_keys, s.rate_limit_rps = f"oms:{OMS},app:{APP}", 100
    auth._limiter = None
    yield TestClient(app)
    s.api_keys, s.rate_limit_rps = old
    auth._limiter = None


def row(conn, table, request_id):
    writer().flush()
    return conn.execute(f"SELECT * FROM ops.{table} WHERE request_id = %s", (request_id,)).fetchone()


def test_geocode_is_logged_with_client_order_and_masked_phone(conn, client):
    rid = str(uuid.uuid4())
    resp = client.get("/v1/geocode", params={"address": "Phố Huế, Phường Hai Bà Trưng, Hà Nội, 0912345678",
                                             "order_id": "DH-001"},
                      headers={"X-API-Key": OMS, "X-Request-Id": rid})
    assert resp.status_code == 200 and resp.headers["X-Request-Id"] == rid
    r = row(conn, "geocode_log", rid)
    assert r["client"] == "oms" and r["order_id"] == "DH-001" and r["api"] == "v1"
    assert "0912345678" not in r["query"] and "[SĐT]" in r["query"]
    assert r["level"] == resp.json()["level"] and r["lat"] is not None


def test_order_id_from_header(conn, client):
    rid = str(uuid.uuid4())
    client.get("/maps/api/geocode/json", params={"address": "Phường Bến Thành, TP HCM", "key": APP},
               headers={"X-Order-Id": "DH-002", "X-Request-Id": rid})
    r = row(conn, "geocode_log", rid)
    assert (r["client"], r["order_id"], r["api"]) == ("app", "DH-002", "google")


def test_shadow_compare_stores_only_distance(conn, client):
    rid = str(uuid.uuid4())
    client.get("/maps/api/geocode/json",
               params={"address": "Phường Bến Thành, TP HCM", "key": OMS,
                       "ref_lat": 10.7725, "ref_lng": 106.6980, "ref_type": "APPROXIMATE"},
               headers={"X-Request-Id": rid})
    r = row(conn, "shadow_compare", rid)
    assert r["reference"] == "google" and r["reference_location_type"] == "APPROXIMATE"
    assert 0 <= r["distance_m"] < 3000
    columns = {c.name for c in conn.execute("SELECT * FROM ops.shadow_compare LIMIT 0").description}
    assert not columns & {"lat", "lng", "ref_lat", "ref_lng"}  # không có cột chứa toạ độ tham chiếu


def test_autocomplete_session_and_selection_logged(conn, client):
    token = str(uuid.uuid4())
    preds = client.get("/maps/api/place/autocomplete/json",
                       params={"input": "pho hue ha noi", "sessiontoken": token, "key": OMS}).json()["predictions"]
    client.get("/maps/api/place/details/json",
               params={"place_id": preds[0]["place_id"], "sessiontoken": token, "key": OMS})
    writer().flush()
    s = conn.execute("SELECT place_ids FROM ops.suggest_log WHERE session_token = %s", (token,)).fetchone()
    p = conn.execute("SELECT place_id FROM ops.place_select_log WHERE session_token = %s", (token,)).fetchone()
    assert s["place_ids"][0] == preds[0]["place_id"] == p["place_id"]


def test_matrix_logged(conn, client):
    rid = str(uuid.uuid4())
    pts = [{"lat": 21.0285, "lon": 105.8542}, {"lat": 21.0368, "lon": 105.8342}]
    client.post("/v1/matrix", json={"sources": pts, "targets": pts, "vehicle": "car"},
                headers={"X-API-Key": OMS, "X-Request-Id": rid})
    r = row(conn, "route_log", rid)
    assert (r["kind"], r["n_sources"], r["n_targets"], r["client"]) == ("matrix", 2, 2, "oms")


def test_missing_or_wrong_key(client):
    assert client.get("/v1/geocode", params={"address": "Hà Nội"}).status_code == 401
    assert client.get("/v1/geocode", params={"address": "Hà Nội"}, headers={"X-API-Key": "sai"}).status_code == 401
    body = client.get("/maps/api/geocode/json", params={"address": "Hà Nội"}).json()
    assert body["status"] == "REQUEST_DENIED"


def test_rate_limit(client):
    settings().rate_limit_rps = 1
    auth._limiter = None
    codes = [client.get("/v1/geocode", params={"address": "Hà Nội"}, headers={"X-API-Key": OMS}).status_code
             for _ in range(4)]
    assert codes[:2] == [200, 200] and 429 in codes
    body = client.get("/maps/api/geocode/json", params={"address": "Hà Nội", "key": OMS}).json()
    assert body["status"] == "OVER_QUERY_LIMIT"


def test_metrics_exposed(client):
    client.get("/v1/geocode", params={"address": "Hà Nội"}, headers={"X-API-Key": OMS})
    text = client.get("/metrics").text
    assert 'bds_requests_total{client="oms",endpoint="/v1/geocode",status="200"}' in text
    assert "bds_geocode_level_total" in text and "bds_request_latency_seconds_bucket" in text


def test_shadow_replay_computes_accuracy_and_logs(conn, tmp_path):
    from bds.ops.shadow_replay import replay
    src = tmp_path / "in.csv"
    src.write_text(
        "order_id,address,ref_lat,ref_lng,truth_lat,truth_lng\n"
        'R-1,"Chợ Bến Thành, Phường Bến Thành, TP.HCM",10.7725,106.6980,10.7725,106.6980\n'
        'R-2,"xyz không có gì",,,,\n', encoding="utf-8")
    out = tmp_path / "out.csv"
    summary = replay(str(src), str(out))
    assert summary["n"] == 2 and summary["levels"]["NOT_FOUND"] == 1
    assert summary["truth"]["n"] == 1 and summary["truth"]["acc500"] == 1.0
    assert "bds_level" in out.read_text(encoding="utf-8")
    logged = conn.execute("SELECT count(*) c FROM ops.geocode_log WHERE client = 'replay' AND order_id = 'R-1'")
    assert logged.fetchone()["c"] >= 1


def test_shadow_report_runs(conn):
    from bds.ops.shadow_report import report
    sections = report(1)
    assert sections.get("Phân giải theo mức")
