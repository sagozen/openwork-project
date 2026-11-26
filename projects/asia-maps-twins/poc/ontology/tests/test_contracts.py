"""Kiểm chứng 2 và 3: model Pydantic dùng thẳng trong FastAPI; JSON Schema kiểm tra file của đối tác."""

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator
from pydantic import ValidationError

from generated.models import Facility

ROOT = Path(__file__).resolve().parents[1]
VALID = {
    "entity_id": "7c0d4f7e-1b2a-4c3d-9e8f-001122334455",
    "code": "BC01", "name": "Bưu cục mẫu 01", "facility_type": "post_office",
    "operated_by": "11111111-1111-1111-1111-111111111111",
    "in_admin_unit": "22222222-2222-2222-2222-222222222222",
    "location": "POINT(106.07 21.18)", "valid_from": "2025-08-01",
    "source": "poc", "tenant_id": "hang-mau", "data_class": "public",
}


@pytest.fixture(scope="module")
def client():
    app = FastAPI()

    @app.post("/facilities")
    def create(facility: Facility) -> Facility:
        return facility

    return TestClient(app)


def test_fastapi_accepts_valid_facility(client):
    response = client.post("/facilities", json=VALID)
    assert response.status_code == 200
    assert response.json()["facility_type"] == "post_office"


def test_fastapi_rejects_unknown_enum(client):
    response = client.post("/facilities", json={**VALID, "facility_type": "kiosk"})
    assert response.status_code == 422


def test_openapi_exposes_ontology_enum(client):
    spec = client.get("/openapi.json").json()
    assert "locker" in spec["components"]["schemas"]["FacilityType"]["enum"]


def test_pydantic_enforces_confidence_range():
    with pytest.raises(ValidationError):
        Facility(**{**VALID, "confidence": 1.5})


def test_json_schema_flags_bad_partner_rows():
    schema = json.loads((ROOT / "generated" / "bds.schema.json").read_text())
    validator = Draft202012Validator({"$ref": "#/$defs/Facility", "$defs": schema["$defs"]})
    rows = json.loads((ROOT / "tests" / "data" / "partner_facilities.json").read_text())

    errors = {row["code"]: sorted(e.message for e in validator.iter_errors(row)) for row in rows}

    assert errors["DL01"] == []
    assert any("'kiosk' is not one of" in m for m in errors["DL02"])
    assert any("'name' is a required property" in m for m in errors["DL03"])
