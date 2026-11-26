"""Tạo schema `geo` (dữ liệu dẫn xuất) `ops` (log vận hành) và `ml` (nhãn, mô hình). Chạy lại nhiều lần không sao."""

from pathlib import Path

import psycopg

from bds.config import settings


def main() -> None:
    geo_sql = (Path(__file__).parent / "schema.sql").read_text()
    ops_sql = (Path(__file__).parents[1] / "ops" / "schema_ops.sql").read_text()
    ml_sql = (Path(__file__).parents[1] / "learn" / "schema_ml.sql").read_text()
    with psycopg.connect(settings().pg_dsn, autocommit=True) as conn:
        conn.execute(geo_sql)
        conn.execute(ops_sql)
        conn.execute(ml_sql)
    print("schema geo, ops, ml: ok")


if __name__ == "__main__":
    main()
