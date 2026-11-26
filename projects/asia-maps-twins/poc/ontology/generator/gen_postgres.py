"""Sinh DDL PostgreSQL + PostGIS từ ontology LinkML.

LinkML gen-sqltables không biết PostGIS, không có phiên bản theo thời gian hiệu lực
và không sinh index không gian, nên dự án dùng generator riêng này. Nó đọc cùng một
file schema với gen-pydantic và gen-json-schema, nên định nghĩa vẫn chỉ có một nơi.

Quy ước:
- Class có annotation `storage: versioned` (kế thừa từ Record): mỗi dòng là một phiên bản.
  Cột hệ thống: version_id (PK), entity_id, recorded_at. Ràng buộc loại trừ chặn hai phiên bản
  của cùng một thực thể có khoảng hiệu lực chồng nhau. Sinh thêm view `<bảng>_current`
  và hàm `<bảng>_at(ngày)`.
- Class có annotation `storage: event`: append-only. Nếu có `partition_by`, bảng được
  phân vùng theo ngày trên cột đó.
- Slot có range là class: cột uuid tham chiếu bảng `entity` (registry thực thể).
- Type có annotation `postgis`: cột hình học, kèm index GiST.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

from linkml_runtime.utils.schemaview import SchemaView

SCHEMA = "bds"

SCALAR_SQL = {
    "string": "text",
    "integer": "bigint",
    "float": "double precision",
    "double": "double precision",
    "boolean": "boolean",
    "date": "date",
    "datetime": "timestamptz",
    "uri": "text",
}

# Cột do hệ thống quản lý, không lấy từ slot.
SYSTEM_VERSIONED = {"entity_id", "valid_from", "valid_to"}


def snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def annotation(element, key: str) -> str | None:
    ann = element.annotations.get(key) if element.annotations else None
    return str(ann.value) if ann is not None else None


class PostgresGenerator:
    def __init__(self, schema_path: str | Path):
        self.sv = SchemaView(str(schema_path))

    # ---------- phân loại class ----------
    def storage(self, cls_name: str) -> str | None:
        for ancestor in self.sv.class_ancestors(cls_name):
            value = annotation(self.sv.get_class(ancestor), "storage")
            if value:
                return value
        return None

    def concrete_classes(self) -> list[str]:
        result = []
        for name in self.sv.all_classes():
            cls = self.sv.get_class(name)
            if cls.abstract or cls.mixin:
                continue
            if self.storage(name):
                result.append(name)
        return result

    # ---------- ánh xạ kiểu ----------
    def column_type(self, slot) -> tuple[str, str | None]:
        """Trả về (kiểu SQL, loại đặc biệt: 'geometry' | 'ref' | 'enum' | None)."""
        rng = slot.range or self.sv.schema.default_range
        if rng in self.sv.all_classes():
            return "uuid", "ref"
        if rng in self.sv.all_enums():
            return "text", "enum"
        if rng in self.sv.all_types():
            t = self.sv.get_type(rng)
            postgis = annotation(t, "postgis")
            if postgis:
                return postgis, "geometry"
            base = rng
            while base not in SCALAR_SQL and self.sv.get_type(base).typeof:
                base = self.sv.get_type(base).typeof
            return SCALAR_SQL.get(base, "text"), None
        return "text", None

    def geometry_slots(self, cls_name: str) -> list[str]:
        return [
            s.name
            for s in self.sv.class_induced_slots(cls_name)
            if self.column_type(s)[1] == "geometry"
        ]

    def business_slots(self, cls_name: str):
        storage = self.storage(cls_name)
        for slot in self.sv.class_induced_slots(cls_name):
            if storage == "versioned" and slot.name in SYSTEM_VERSIONED:
                continue
            yield slot

    # ---------- DDL ----------
    def column_ddl(self, slot, *, identifier_as_pk: bool) -> tuple[str, list[str]]:
        sql_type, kind = self.column_type(slot)
        parts = [f"{slot.name} {sql_type}"]
        checks: list[str] = []
        if slot.identifier and identifier_as_pk:
            parts.append("NOT NULL DEFAULT gen_random_uuid()")
            parts[0] = f"{slot.name} uuid"
        elif slot.required:
            parts.append("NOT NULL")
        if kind == "ref":
            parts.append(f"REFERENCES {SCHEMA}.entity(entity_id)")
        if kind == "enum":
            values = ", ".join(
                f"'{v}'" for v in self.sv.get_enum(slot.range).permissible_values
            )
            checks.append(f"CHECK ({slot.name} IN ({values}))")
        if slot.minimum_value is not None:
            checks.append(f"CHECK ({slot.name} >= {slot.minimum_value})")
        if slot.maximum_value is not None:
            checks.append(f"CHECK ({slot.name} <= {slot.maximum_value})")
        return " ".join(parts), checks

    def table_ddl(self, cls_name: str) -> str:
        table = snake(cls_name)
        storage = self.storage(cls_name)
        cls = self.sv.get_class(cls_name)
        lines: list[str] = []
        constraints: list[str] = []
        after: list[str] = []

        if storage == "versioned":
            lines += [
                "version_id uuid PRIMARY KEY DEFAULT gen_random_uuid()",
                f"entity_id uuid NOT NULL REFERENCES {SCHEMA}.entity(entity_id)",
                "valid_from date NOT NULL",
                "valid_to date",
                "recorded_at timestamptz NOT NULL DEFAULT now()",
            ]
            constraints += [
                "CHECK (valid_to IS NULL OR valid_to > valid_from)",
                "EXCLUDE USING gist (entity_id WITH =, daterange(valid_from, valid_to) WITH &&)",
            ]
        partition_by = annotation(cls, "partition_by")

        for slot in self.business_slots(cls_name):
            col, checks = self.column_ddl(slot, identifier_as_pk=storage == "event")
            lines.append(col)
            constraints += checks

        if storage == "event":
            ident = next(s.name for s in self.sv.class_induced_slots(cls_name) if s.identifier)
            lines.append("recorded_at timestamptz NOT NULL DEFAULT now()")
            pk_cols = [ident] + ([partition_by] if partition_by else [])
            constraints.append(f"PRIMARY KEY ({', '.join(pk_cols)})")

        body = ",\n  ".join(lines + constraints)
        comment = (cls.description or "").replace("'", "''")
        ddl = f"CREATE TABLE {SCHEMA}.{table} (\n  {body}\n)"
        if partition_by:
            ddl += f" PARTITION BY RANGE ({partition_by})"
        ddl += ";\n"
        ddl += f"COMMENT ON TABLE {SCHEMA}.{table} IS '{comment}';\n"

        # index
        for geom in self.geometry_slots(cls_name):
            after.append(f"CREATE INDEX ON {SCHEMA}.{table} USING gist ({geom});")
        for slot in self.business_slots(cls_name):
            if self.column_type(slot)[1] == "ref":
                after.append(f"CREATE INDEX ON {SCHEMA}.{table} ({slot.name});")
        if storage == "versioned":
            after.append(f"CREATE INDEX ON {SCHEMA}.{table} (entity_id);")
            after.append(
                f"CREATE VIEW {SCHEMA}.{table}_current AS "
                f"SELECT * FROM {SCHEMA}.{table} WHERE valid_to IS NULL;"
            )
            after.append(
                f"CREATE FUNCTION {SCHEMA}.{table}_at(d date) RETURNS SETOF {SCHEMA}.{table} "
                f"LANGUAGE sql STABLE AS $$ SELECT * FROM {SCHEMA}.{table} "
                f"WHERE valid_from <= d AND (valid_to IS NULL OR valid_to > d) $$;"
            )
        if partition_by:
            after.append(self.partition_helper(table, partition_by))
        return ddl + "\n".join(after) + "\n"

    @staticmethod
    def partition_helper(table: str, column: str) -> str:
        return f"""CREATE FUNCTION {SCHEMA}.ensure_{table}_partition(d date) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE part text := format('{table}_%s', to_char(d, 'YYYYMMDD'));
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS {SCHEMA}.%I PARTITION OF {SCHEMA}.{table} FOR VALUES FROM (%L) TO (%L)',
    part, d::timestamptz, (d + 1)::timestamptz);
END $$;
COMMENT ON FUNCTION {SCHEMA}.ensure_{table}_partition(date) IS 'Tạo phân vùng ngày cho cột {column}.';"""

    def generate(self) -> str:
        header = f"""-- SINH TỰ ĐỘNG từ ontology/bds.yaml bởi generator/gen_postgres.py. Không sửa tay.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE SCHEMA IF NOT EXISTS {SCHEMA};

-- Registry thực thể: ID ổn định qua mọi phiên bản và mọi nguồn.
CREATE TABLE {SCHEMA}.entity (
  entity_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,
  tenant_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Bridge: mã của từng nguồn (mã nội bộ, OSM id, GERS id...) trỏ về một thực thể.
CREATE TABLE {SCHEMA}.source_ref (
  entity_id uuid NOT NULL REFERENCES {SCHEMA}.entity(entity_id),
  source_system text NOT NULL,
  source_key text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_system, source_key)
);
CREATE INDEX ON {SCHEMA}.source_ref (entity_id);

-- Nhật ký mọi action đã chạy.
CREATE TABLE {SCHEMA}.action_log (
  action_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type text NOT NULL,
  actor text NOT NULL,
  params jsonb NOT NULL,
  affected jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);
"""
        tables = [self.table_ddl(c) for c in self.concrete_classes()]
        return header + "\n" + "\n".join(tables)


def main() -> None:
    schema = sys.argv[1] if len(sys.argv) > 1 else "ontology/bds.yaml"
    sys.stdout.write(PostgresGenerator(schema).generate())


if __name__ == "__main__":
    main()
