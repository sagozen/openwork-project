"""Function (chỉ số) có đáp án biết trước, Observation, công cụ AI sinh từ ontology, kiểm tra chéo kinetic."""

import json
import uuid
from datetime import date
from pathlib import Path

import pytest
import yaml
from jsonschema import Draft202012Validator
from linkml_runtime.utils.schemaview import SchemaView

from generated.models import ShipmentEvent
from generator.kinetic import KineticError, KineticSpec, check_kinetic

ROOT = Path(__file__).resolve().parents[1]


def ingest(conn, facility, shipment, event_type, ts):
    """Nạp một sự kiện: kiểm tra bằng model sinh từ ontology rồi ghi append-only."""
    event = ShipmentEvent(event_id=str(uuid.uuid4()), shipment_ref=shipment, event_type=event_type,
                          facility=str(facility), ts=ts, source="poc", tenant_id="hang-mau",
                          data_class="internal").model_dump(exclude_none=True)
    cols = list(event)
    conn.execute(
        f"INSERT INTO bds.shipment_event ({', '.join(cols)}) VALUES ({', '.join(['%s'] * len(cols))})",
        [event[c] for c in cols],
    )


@pytest.fixture()
def events(conn, seed):
    for d in ("2026-03-09", "2026-03-10"):
        conn.execute("SELECT bds.ensure_shipment_event_partition(%s)", (d,))
    po, hub = seed["post_office"], seed["hub"]
    ingest(conn, po, "s1", "arrived", "2026-03-10T08:00:00+07:00")
    ingest(conn, po, "s1", "sorted", "2026-03-10T09:00:00+07:00")
    ingest(conn, po, "s1", "out_for_delivery", "2026-03-10T10:00:00+07:00")
    ingest(conn, po, "s2", "arrived", "2026-03-10T08:30:00+07:00")
    ingest(conn, hub, "s3", "arrived", "2026-03-10T07:00:00+07:00")
    ingest(conn, hub, "s3", "departed", "2026-03-10T07:30:00+07:00")
    ingest(conn, po, "s3", "arrived", "2026-03-10T11:00:00+07:00")
    ingest(conn, po, "s4", "arrived", "2026-03-09T23:30:00+07:00")  # ngày 9 theo giờ Việt Nam
    ingest(conn, po, "s5", "arrived", "2026-03-10T00:30:00+07:00")  # ngày 10 giờ VN, ngày 9 giờ UTC
    return seed


def test_backlog_count_known_answers(conn, runtime, events):
    po = events["post_office"]
    assert runtime.call(conn, "backlog_count", facility=po, at="2026-03-10T10:30:00+07:00") == 3
    assert runtime.call(conn, "backlog_count", facility=po, at="2026-03-10T12:00:00+07:00") == 4
    assert runtime.call(conn, "backlog_count", facility=events["hub"], at="2026-03-10T07:15:00+07:00") == 1
    assert runtime.call(conn, "backlog_count", facility=events["hub"], at="2026-03-10T12:00:00+07:00") == 0


def test_daily_inbound_uses_vietnam_day(conn, runtime, events):
    assert runtime.call(conn, "daily_inbound", facility=events["post_office"], day=date(2026, 3, 10)) == 4
    assert runtime.call(conn, "daily_inbound", facility=events["post_office"], day=date(2026, 3, 9)) == 1


def test_function_requires_parameters(conn, runtime, events):
    with pytest.raises(ValueError):
        runtime.call(conn, "backlog_count", facility=events["post_office"])


def test_observation_holds_operational_and_statistical_values(conn, runtime, events):
    """Sản lượng (từ function) và dân số xã nằm chung một bảng, so sánh được với nhau."""
    inbound = runtime.call(conn, "daily_inbound", facility=events["post_office"], day=date(2026, 3, 10))
    rows = [
        (events["post_office"], "daily_inbound", "2026-03-10", inbound, "don"),
        (events["x1"], "population", "2026-01-01", 8000, "nguoi"),
    ]
    for subject, variable, d, value, unit in rows:
        conn.execute(
            "INSERT INTO bds.observation (subject, variable, obs_date, value, unit, source, tenant_id, data_class) "
            "VALUES (%s, %s, %s, %s, %s, 'poc', 'hang-mau', 'internal')", (subject, variable, d, value, unit)
        )
    per_1000 = conn.execute("""
        SELECT round((vol.value / pop.value * 1000)::numeric, 2)
        FROM bds.observation vol
        JOIN bds.facility_at(vol.obs_date) f ON f.entity_id = vol.subject
        JOIN bds.observation pop ON pop.subject = f.in_admin_unit AND pop.variable = 'population'
        WHERE vol.variable = 'daily_inbound' AND vol.obs_date = '2026-03-10'
    """).fetchone()[0]
    assert float(per_1000) == 0.5


def test_ai_tools_are_valid_and_cover_the_ontology():
    tools = {t["name"]: t for t in json.loads((ROOT / "generated" / "ai_tools.json").read_text())}
    for tool in tools.values():
        Draft202012Validator.check_schema(tool["input_schema"])
    assert {"find_facility", "backlog_count", "daily_inbound", "propose_register_facility"} <= set(tools)
    assert tools["propose_relocate_facility"]["x-requires-human-approval"] is True
    assert "locker" in tools["find_facility"]["input_schema"]["properties"]["facility_type"]["enum"]
    assert tools["backlog_count"]["input_schema"]["required"] == ["facility", "at"]


def test_kinetic_check_catches_broken_references():
    spec = KineticSpec.model_validate(yaml.safe_load((ROOT / "ontology" / "kinetic.yaml").read_text()))
    spec.actions["relocate_facility"].parameters.append("so_tang")
    spec.functions["daily_inbound"].sql = "SELECT 1"
    with pytest.raises(KineticError) as err:
        check_kinetic(spec, SchemaView(str(ROOT / "ontology" / "bds.yaml")))
    assert "so_tang" in str(err.value)
    assert "không dùng tham số facility" in str(err.value)
