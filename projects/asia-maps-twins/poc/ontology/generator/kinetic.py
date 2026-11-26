"""Đọc và kiểm tra lớp hành động (ontology/kinetic.yaml) với lớp ngữ nghĩa (ontology/bds.yaml)."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

import yaml
from linkml_runtime.utils.schemaview import SchemaView
from pydantic import BaseModel, Field


class Criterion(BaseModel):
    name: str
    message: str
    sql: str


class ActionSpec(BaseModel):
    description: str
    target: str
    kind: Literal["create", "new_version"]
    parameters: list[str]
    source_key: str | None = None
    criteria: list[Criterion] = Field(default_factory=list)


class FunctionParam(BaseModel):
    range: str
    required: bool = False


class FunctionSpec(BaseModel):
    description: str
    returns: Literal["integer", "float", "string"]
    unit: str | None = None
    parameters: dict[str, FunctionParam]
    sql: str


class KineticSpec(BaseModel):
    actions: dict[str, ActionSpec]
    functions: dict[str, FunctionSpec]


class KineticError(ValueError):
    pass


SCALAR_RANGES = {"string", "integer", "float", "date", "datetime", "boolean"}


def load_kinetic(kinetic_path: str | Path, schema_path: str | Path) -> KineticSpec:
    spec = KineticSpec.model_validate(yaml.safe_load(Path(kinetic_path).read_text()))
    check_kinetic(spec, SchemaView(str(schema_path)))
    return spec


def check_kinetic(spec: KineticSpec, sv: SchemaView) -> None:
    """Mọi tham chiếu trong kinetic phải tồn tại trong ontology; sai thì báo lỗi ngay."""
    errors: list[str] = []
    classes = set(sv.all_classes())
    for name, action in spec.actions.items():
        if action.target not in classes:
            errors.append(f"action {name}: target {action.target} không có trong ontology")
            continue
        slots = {s.name for s in sv.class_induced_slots(action.target)}
        for p in action.parameters:
            if p not in slots:
                errors.append(f"action {name}: tham số {p} không phải slot của {action.target}")
        if action.kind == "new_version" and "entity_id" not in action.parameters:
            errors.append(f"action {name}: new_version phải có tham số entity_id")
        if "valid_from" not in action.parameters:
            errors.append(f"action {name}: phải có tham số valid_from")
        if action.source_key and action.source_key not in action.parameters:
            errors.append(f"action {name}: source_key {action.source_key} không nằm trong tham số")
    for name, fn in spec.functions.items():
        for p, param in fn.parameters.items():
            if param.range not in classes and param.range not in SCALAR_RANGES:
                errors.append(f"function {name}: tham số {p} có range {param.range} không hợp lệ")
            if f"%({p})s" not in fn.sql:
                errors.append(f"function {name}: SQL không dùng tham số {p}")
    if errors:
        raise KineticError("\n".join(errors))
