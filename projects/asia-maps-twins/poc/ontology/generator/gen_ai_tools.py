"""Sinh định nghĩa công cụ cho AI agent (sẵn cho MCP server) từ ontology.

- Mỗi object type -> công cụ `find_<bảng>` (tìm theo tên, lọc theo enum, tại một ngày).
- Mỗi function -> công cụ cùng tên, trả về số liệu đã định nghĩa (AI không tự tính).
- Mỗi action -> công cụ `propose_<action>`: AI chỉ đề xuất, người phải xác nhận trước khi chạy.
JSON Schema của từng tham số lấy từ JSON Schema mà gen-json-schema sinh ra, nên khớp ontology.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from linkml_runtime.utils.schemaview import SchemaView

from generator.gen_postgres import PostgresGenerator, snake
from generator.kinetic import load_kinetic

SCALAR_JSON = {
    "string": {"type": "string"},
    "integer": {"type": "integer"},
    "float": {"type": "number"},
    "boolean": {"type": "boolean"},
    "date": {"type": "string", "format": "date"},
    "datetime": {"type": "string", "format": "date-time"},
}


def _resolve(prop: dict, defs: dict) -> dict:
    """Thay $ref tới enum bằng định nghĩa enum, để mỗi công cụ tự đứng được."""
    if "$ref" in prop:
        return {**defs[prop["$ref"].split("/")[-1]], **{k: v for k, v in prop.items() if k != "$ref"}}
    if "anyOf" in prop:
        options = [_resolve(o, defs) for o in prop["anyOf"] if o.get("type") != "null"]
        return options[0] if len(options) == 1 else {"anyOf": options}
    return prop


def _ref_param(cls: str) -> dict:
    return {"type": "string", "format": "uuid", "description": f"entity_id của {cls}"}


def build_tools(schema_path: str, kinetic_path: str, json_schema_path: str) -> list[dict]:
    sv = SchemaView(schema_path)
    gen = PostgresGenerator(schema_path)
    kinetic = load_kinetic(kinetic_path, schema_path)
    defs = json.loads(Path(json_schema_path).read_text())["$defs"]
    tools: list[dict] = []

    for cls in gen.concrete_classes():
        if gen.storage(cls) != "versioned":
            continue
        props: dict = {
            "q": {"type": "string", "description": "Tìm theo tên hoặc mã (không dấu cũng được)"},
            "at": {"type": "string", "format": "date", "description": "Trạng thái tại ngày này; bỏ trống là hôm nay"},
        }
        for slot in sv.class_induced_slots(cls):
            if slot.range in sv.all_enums() and slot.name != "data_class":
                props[slot.name] = _resolve(defs[cls]["properties"][slot.name], defs)
            elif slot.range in sv.all_classes():
                props[slot.name] = _ref_param(slot.range)
        tools.append({
            "name": f"find_{snake(cls)}",
            "description": f"Tìm {cls}: {sv.get_class(cls).description or ''}".strip(),
            "input_schema": {"type": "object", "properties": props, "additionalProperties": False},
        })

    for name, fn in kinetic.functions.items():
        props = {
            p: _ref_param(spec.range) if spec.range in sv.all_classes() else dict(SCALAR_JSON[spec.range])
            for p, spec in fn.parameters.items()
        }
        tools.append({
            "name": name,
            "description": f"{fn.description.strip()} Đơn vị: {fn.unit}.",
            "input_schema": {
                "type": "object", "properties": props, "additionalProperties": False,
                "required": [p for p, s in fn.parameters.items() if s.required],
            },
        })

    for name, action in kinetic.actions.items():
        cls_props = defs[action.target]["properties"]
        props = {}
        for p in action.parameters:
            slot = sv.induced_slot(p, action.target)
            props[p] = _ref_param(slot.range) if slot.range in sv.all_classes() else _resolve(cls_props[p], defs)
        if action.kind == "create":
            required = [p for p in action.parameters if sv.induced_slot(p, action.target).required]
        else:
            required = ["entity_id", "valid_from"]
        tools.append({
            "name": f"propose_{name}",
            "description": f"Đề xuất: {action.description} Cần người xác nhận trước khi thực hiện.",
            "input_schema": {"type": "object", "properties": props, "additionalProperties": False,
                             "required": required},
            "x-requires-human-approval": True,
        })
    return tools


def main() -> None:
    schema, kinetic, json_schema = (sys.argv[1:4] + [None] * 3)[:3]
    tools = build_tools(schema or "ontology/bds.yaml", kinetic or "ontology/kinetic.yaml",
                        json_schema or "generated/bds.schema.json")
    sys.stdout.write(json.dumps(tools, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
