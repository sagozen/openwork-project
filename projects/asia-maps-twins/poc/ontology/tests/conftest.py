"""Fixture dùng chung: mỗi test chạy trên schema `bds` dựng mới từ DDL sinh ra.

Dữ liệu trong các test là dữ liệu mẫu (tên "Mẫu ..."), không phải dữ liệu thật.
"""

from __future__ import annotations

import os
from pathlib import Path

import psycopg
import pytest

from generator.kinetic import load_kinetic
from generator.runtime import OntologyRuntime

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_YAML = str(ROOT / "ontology" / "bds.yaml")
KINETIC_YAML = str(ROOT / "ontology" / "kinetic.yaml")
DSN = os.environ.get("BDS_PG_DSN", "postgresql://postgres:poc@127.0.0.1:55432/bds")


@pytest.fixture(scope="session")
def runtime() -> OntologyRuntime:
    return OntologyRuntime(SCHEMA_YAML, load_kinetic(KINETIC_YAML, SCHEMA_YAML))


@pytest.fixture()
def conn():
    ddl = (ROOT / "generated" / "schema.sql").read_text()
    with psycopg.connect(DSN, autocommit=True) as c:
        c.execute("DROP SCHEMA IF EXISTS bds CASCADE")
        c.execute(ddl)
        yield c


@pytest.fixture()
def seed(conn, runtime):
    """Một hãng, một tỉnh, hai xã mẫu, một bưu cục và một hub."""
    base = {"source": "poc", "tenant_id": "hang-mau", "data_class": "public"}
    org = runtime.apply(conn, "register_organization",
                        {**base, "name": "Hãng mẫu", "org_type": "carrier", "valid_from": "2025-07-01"},
                        actor="seed")["entity_id"]
    province = runtime.apply(conn, "register_admin_unit",
                             {**base, "code": "T01", "name": "Tỉnh mẫu", "level": 1,
                              "valid_from": "2025-07-01"}, actor="seed")["entity_id"]
    x1 = runtime.apply(conn, "register_admin_unit",
                       {**base, "code": "X01", "name": "Xã Mẫu Một", "level": 2, "parent": str(province),
                        "valid_from": "2025-07-01"}, actor="seed")["entity_id"]
    x2 = runtime.apply(conn, "register_admin_unit",
                       {**base, "code": "X02", "name": "Xã Mẫu Hai", "level": 2, "parent": str(province),
                        "valid_from": "2025-07-01"}, actor="seed")["entity_id"]
    fac = {**base, "operated_by": str(org), "valid_from": "2025-08-01"}
    post_office = runtime.apply(conn, "register_facility",
                                {**fac, "code": "BC01", "name": "Bưu cục mẫu 01", "facility_type": "post_office",
                                 "in_admin_unit": str(x1), "location": "POINT(106.07 21.18)"},
                                actor="seed")["entity_id"]
    hub = runtime.apply(conn, "register_facility",
                        {**fac, "code": "HUB01", "name": "Hub mẫu 01", "facility_type": "hub",
                         "in_admin_unit": str(x2), "location": "POINT(106.10 21.20)"},
                        actor="seed")["entity_id"]
    return {"org": org, "province": province, "x1": x1, "x2": x2, "post_office": post_office, "hub": hub,
            "base": base}
