"""Chạy action và function của ontology trên PostgreSQL.

Mọi thay đổi dữ liệu nghiệp vụ đi qua `ActionRunner.apply`: kiểm tra tham số bằng model
Pydantic sinh từ ontology, chạy điều kiện hợp lệ, ghi phiên bản mới, ghi bridge và action_log
trong cùng một giao dịch.
"""

from __future__ import annotations

import importlib
import json
import uuid
from datetime import date, datetime
from typing import Any

import psycopg
from psycopg.rows import dict_row, tuple_row

from generator.gen_postgres import SCHEMA, PostgresGenerator, snake
from generator.kinetic import KineticSpec


class ActionRejected(Exception):
    def __init__(self, criterion: str, message: str):
        super().__init__(f"{criterion}: {message}")
        self.criterion = criterion
        self.message = message


def _json_default(value: Any) -> str:
    if isinstance(value, (date, datetime, uuid.UUID)):
        return value.isoformat() if not isinstance(value, uuid.UUID) else str(value)
    if hasattr(value, "value"):  # Enum
        return value.value
    raise TypeError(f"không chuyển được {type(value)} sang JSON")


class OntologyRuntime:
    def __init__(self, schema_path: str, kinetic: KineticSpec, models_module: str = "generated.models"):
        self.gen = PostgresGenerator(schema_path)
        self.kinetic = kinetic
        self.models = importlib.import_module(models_module)

    # ---------- hỗ trợ ----------
    def _columns(self, cls_name: str) -> dict[str, str | None]:
        """Tên cột nghiệp vụ -> loại đặc biệt (geometry/ref/enum/None)."""
        return {s.name: self.gen.column_type(s)[1] for s in self.gen.business_slots(cls_name)}

    def _db_values(self, cls_name: str, obj: dict[str, Any]) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for col, kind in self._columns(cls_name).items():
            value = obj.get(col)
            if hasattr(value, "value"):
                value = value.value
            if kind == "ref" and value is not None:
                value = uuid.UUID(str(value))
            out[col] = value
        return out

    def _insert_version(self, cur, cls_name: str, entity_id: uuid.UUID, obj: dict[str, Any]) -> uuid.UUID:
        table = snake(cls_name)
        values = self._db_values(cls_name, obj)
        values.update(entity_id=entity_id, valid_from=obj["valid_from"], valid_to=obj.get("valid_to"))
        cols = list(values)
        placeholders = [
            f"ST_GeomFromText(%({c})s, 4326)" if self._columns(cls_name).get(c) == "geometry" else f"%({c})s"
            for c in cols
        ]
        cur.execute(
            f"INSERT INTO {SCHEMA}.{table} ({', '.join(cols)}) VALUES ({', '.join(placeholders)}) "
            "RETURNING version_id",
            values,
        )
        return cur.fetchone()["version_id"]

    def _current(self, cur, cls_name: str, entity_id: uuid.UUID) -> dict[str, Any]:
        table = snake(cls_name)
        geoms = {c for c, k in self._columns(cls_name).items() if k == "geometry"}
        select = ", ".join(f"ST_AsText({c}) AS {c}" if c in geoms else c for c in self._columns(cls_name))
        cur.execute(
            f"SELECT version_id, entity_id, valid_from, {select} FROM {SCHEMA}.{table} "
            "WHERE entity_id = %s AND valid_to IS NULL FOR UPDATE",
            (entity_id,),
        )
        row = cur.fetchone()
        if row is None:
            raise ActionRejected("ton_tai", f"không có phiên bản hiện hành của {cls_name} {entity_id}")
        return dict(row)

    def _check_criteria(self, cur, action, params: dict[str, Any]) -> None:
        for crit in action.criteria:
            cur.execute(crit.sql, params)
            if not cur.fetchone()[next(iter(cur.description)).name]:
                raise ActionRejected(crit.name, crit.message)

    # ---------- action ----------
    def apply(self, conn: psycopg.Connection, action_name: str, params: dict[str, Any], actor: str) -> dict:
        action = self.kinetic.actions[action_name]
        unknown = set(params) - set(action.parameters)
        if unknown:
            raise ValueError(f"tham số không thuộc action {action_name}: {sorted(unknown)}")
        model_cls = getattr(self.models, action.target)

        with conn.transaction(), conn.cursor(row_factory=dict_row) as cur:
            if action.kind == "create":
                entity_id = uuid.uuid4()
                state = model_cls(**{**params, "entity_id": str(entity_id)}).model_dump()
            else:
                entity_id = uuid.UUID(str(params["entity_id"]))
                current = self._current(cur, action.target, entity_id)
                merged = {k: v for k, v in current.items() if k not in ("version_id",)}
                merged.update(params)
                merged["entity_id"] = str(entity_id)
                for k, v in merged.items():
                    if isinstance(v, uuid.UUID):
                        merged[k] = str(v)
                state = model_cls(**merged).model_dump()
                if state["valid_from"] <= current["valid_from"]:
                    raise ActionRejected("thu_tu_thoi_gian", "ngày hiệu lực mới phải sau phiên bản hiện hành")

            crit_params = {**self._db_values(action.target, state), "valid_from": state["valid_from"],
                           "entity_id": entity_id}
            self._check_criteria(cur, action, crit_params)

            if action.kind == "create":
                cur.execute(
                    f"INSERT INTO {SCHEMA}.entity (entity_id, entity_type, tenant_id) VALUES (%s, %s, %s)",
                    (entity_id, action.target, state["tenant_id"]),
                )
            else:
                cur.execute(
                    f"UPDATE {SCHEMA}.{snake(action.target)} SET valid_to = %s WHERE version_id = %s",
                    (state["valid_from"], current["version_id"]),
                )
            version_id = self._insert_version(cur, action.target, entity_id, state)

            if action.source_key:
                cur.execute(
                    f"INSERT INTO {SCHEMA}.source_ref (entity_id, source_system, source_key) VALUES (%s, %s, %s)",
                    (entity_id, state["source"], state[action.source_key]),
                )
            affected = [{"entity_id": str(entity_id), "version_id": str(version_id)}]
            cur.execute(
                f"INSERT INTO {SCHEMA}.action_log (action_type, actor, params, affected) "
                "VALUES (%s, %s, %s, %s) RETURNING action_id",
                (action_name, actor, json.dumps(params, default=_json_default), json.dumps(affected)),
            )
            action_id = cur.fetchone()["action_id"]
        return {"action_id": action_id, "entity_id": entity_id, "version_id": version_id}

    # ---------- function ----------
    def call(self, conn: psycopg.Connection, function_name: str, **params: Any):
        fn = self.kinetic.functions[function_name]
        missing = [p for p, spec in fn.parameters.items() if spec.required and p not in params]
        if missing:
            raise ValueError(f"function {function_name} thiếu tham số {missing}")
        with conn.cursor(row_factory=tuple_row) as cur:  # chạy được cả khi kết nối mặc định trả dict
            cur.execute(fn.sql, params)
            return cur.fetchone()[0]
