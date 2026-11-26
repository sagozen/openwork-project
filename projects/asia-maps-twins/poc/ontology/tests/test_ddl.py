"""Kiểm chứng 1: DDL sinh ra chạy được trên PostGIS, có cột hình học và index không gian."""


def test_geometry_columns_have_postgis_types(conn):
    rows = conn.execute(
        "SELECT f_table_name, f_geometry_column, type, srid FROM geometry_columns "
        "WHERE f_table_schema = 'bds' AND f_table_name NOT LIKE '%%_current'"
    ).fetchall()
    assert set(rows) == {
        ("admin_unit", "boundary", "MULTIPOLYGON", 4326),
        ("service_zone", "boundary", "MULTIPOLYGON", 4326),
        ("facility", "location", "POINT", 4326),
    }


def test_geometry_columns_have_gist_index(conn):
    indexes = conn.execute(
        "SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = 'bds' AND indexdef LIKE '%%USING gist%%'"
    ).fetchall()
    gist_cols = {(t, d.split("(")[-1].rstrip(")")) for t, d in indexes}
    assert ("facility", "location") in gist_cols
    assert ("admin_unit", "boundary") in gist_cols


def test_shipment_event_is_partitioned_by_day(conn):
    strategy = conn.execute(
        "SELECT partstrat FROM pg_partitioned_table p JOIN pg_class c ON c.oid = p.partrelid "
        "WHERE c.relname = 'shipment_event'"
    ).fetchone()
    assert strategy == ("r",)


def test_enum_is_enforced_by_check_constraint(conn):
    defs = conn.execute(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
        "WHERE conrelid = 'bds.facility'::regclass AND contype = 'c'"
    ).fetchall()
    assert any("post_office" in d[0] and "locker" in d[0] for d in defs)
