"""Kiểm chứng 4 và lớp hành động.

- Truy vấn "điểm mạng lưới thuộc xã X tại ngày D" đúng qua một lần đổi tên xã và một lần chuyển địa bàn.
- Action kiểm tra điều kiện hợp lệ, ghi phiên bản, ghi bridge và nhật ký trong một giao dịch.
"""

import psycopg
import pytest
from pydantic import ValidationError

from generator.runtime import ActionRejected

FACILITIES_IN_UNIT_AT = """
SELECT f.code, a.name
FROM bds.facility_at(%(d)s) f
JOIN bds.admin_unit_at(%(d)s) a ON a.entity_id = f.in_admin_unit
WHERE f.in_admin_unit = %(unit)s
ORDER BY f.code
"""


def facilities_in(conn, unit, d):
    return conn.execute(FACILITIES_IN_UNIT_AT, {"unit": unit, "d": d}).fetchall()


def test_query_is_correct_across_rename_and_relocation(conn, runtime, seed):
    runtime.apply(conn, "rename_admin_unit",
                  {"entity_id": str(seed["x1"]), "name": "Phường Mẫu Một", "valid_from": "2026-01-01"},
                  actor="tester")
    runtime.apply(conn, "relocate_facility",
                  {"entity_id": str(seed["post_office"]), "in_admin_unit": str(seed["x2"]),
                   "location": "POINT(106.09 21.19)", "valid_from": "2026-03-01"},
                  actor="tester")

    assert facilities_in(conn, seed["x1"], "2025-12-31") == [("BC01", "Xã Mẫu Một")]
    assert facilities_in(conn, seed["x1"], "2026-02-01") == [("BC01", "Phường Mẫu Một")]
    assert facilities_in(conn, seed["x1"], "2026-03-15") == []
    assert facilities_in(conn, seed["x2"], "2026-03-15") == [("BC01", "Xã Mẫu Hai"), ("HUB01", "Xã Mẫu Hai")]
    # Trước ngày đăng ký, bưu cục chưa tồn tại.
    assert facilities_in(conn, seed["x1"], "2025-07-15") == []


def test_entity_id_is_stable_and_old_version_is_closed(conn, runtime, seed):
    result = runtime.apply(conn, "relocate_facility",
                           {"entity_id": str(seed["post_office"]), "in_admin_unit": str(seed["x2"]),
                            "valid_from": "2026-03-01"}, actor="tester")
    versions = conn.execute(
        "SELECT valid_from::text, valid_to::text, ST_AsText(location) FROM bds.facility "
        "WHERE entity_id = %s ORDER BY valid_from", (seed["post_office"],)
    ).fetchall()
    assert result["entity_id"] == seed["post_office"]
    assert versions == [("2025-08-01", "2026-03-01", "POINT(106.07 21.18)"),
                        ("2026-03-01", None, "POINT(106.07 21.18)")]


def test_database_rejects_overlapping_versions(conn, seed):
    with pytest.raises(psycopg.errors.ExclusionViolation):
        conn.execute(
            "INSERT INTO bds.facility (entity_id, valid_from, facility_type, in_admin_unit, code, name, "
            "operated_by, source, tenant_id, data_class) "
            "SELECT entity_id, '2025-09-01', facility_type, in_admin_unit, code, name, operated_by, source, "
            "tenant_id, data_class FROM bds.facility WHERE entity_id = %s", (seed["post_office"],)
        )


def test_source_ref_bridges_internal_code_to_entity(conn, seed):
    row = conn.execute(
        "SELECT entity_id FROM bds.source_ref WHERE source_system = 'poc' AND source_key = 'BC01'"
    ).fetchone()
    assert row == (seed["post_office"],)


def test_register_facility_rejects_province_level_unit(conn, runtime, seed):
    with pytest.raises(ActionRejected) as err:
        runtime.apply(conn, "register_facility",
                      {**seed["base"], "code": "BC99", "name": "Bưu cục sai cấp", "facility_type": "post_office",
                       "operated_by": str(seed["org"]), "in_admin_unit": str(seed["province"]),
                       "valid_from": "2025-09-01"}, actor="tester")
    assert err.value.criterion == "don_vi_hanh_chinh_cap_xa"


def test_register_facility_rejects_duplicate_code(conn, runtime, seed):
    with pytest.raises(ActionRejected) as err:
        runtime.apply(conn, "register_facility",
                      {**seed["base"], "code": "BC01", "name": "Trùng mã", "facility_type": "agent",
                       "operated_by": str(seed["org"]), "in_admin_unit": str(seed["x1"]),
                       "valid_from": "2025-09-01"}, actor="tester")
    assert err.value.criterion == "ma_chua_ton_tai"


def test_register_facility_rejects_unknown_type_before_touching_db(conn, runtime, seed):
    before = conn.execute("SELECT count(*) FROM bds.action_log").fetchone()[0]
    with pytest.raises(ValidationError):
        runtime.apply(conn, "register_facility",
                      {**seed["base"], "code": "BC98", "name": "Sai loại", "facility_type": "kiosk",
                       "operated_by": str(seed["org"]), "in_admin_unit": str(seed["x1"]),
                       "valid_from": "2025-09-01"}, actor="tester")
    assert conn.execute("SELECT count(*) FROM bds.action_log").fetchone()[0] == before


def test_new_version_must_be_after_current(conn, runtime, seed):
    with pytest.raises(ActionRejected) as err:
        runtime.apply(conn, "relocate_facility",
                      {"entity_id": str(seed["post_office"]), "in_admin_unit": str(seed["x2"]),
                       "valid_from": "2025-07-15"}, actor="tester")
    assert err.value.criterion == "thu_tu_thoi_gian"


def test_unknown_parameter_is_rejected(conn, runtime, seed):
    with pytest.raises(ValueError):
        runtime.apply(conn, "relocate_facility",
                      {"entity_id": str(seed["post_office"]), "name": "Đổi tên lén", "valid_from": "2026-03-01"},
                      actor="tester")


def test_every_action_is_logged(conn, runtime, seed):
    rows = conn.execute("SELECT action_type, actor FROM bds.action_log ORDER BY created_at").fetchall()
    assert [r[0] for r in rows] == ["register_organization", "register_admin_unit", "register_admin_unit",
                                    "register_admin_unit", "register_facility", "register_facility"]
    assert {r[1] for r in rows} == {"seed"}
