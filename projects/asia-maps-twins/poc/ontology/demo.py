"""Kịch bản demo ontology để quay video: chạy từng cảnh trên database thật, in kết quả dễ đọc.

  make ontology-demo            # chạy liền một mạch
  make ontology-demo STEP=1     # dừng sau mỗi cảnh, bấm Enter để sang cảnh tiếp

Dữ liệu trong demo là dữ liệu mẫu (tên "Mẫu ..."), không phải dữ liệu thật.
"""

from __future__ import annotations

import json
import os
import sys
import uuid
from pathlib import Path

import psycopg
import yaml
from generator.kinetic import load_kinetic
from generator.runtime import ActionRejected, OntologyRuntime
from psycopg.rows import dict_row

ROOT = Path(__file__).parent
SCHEMA, KINETIC = str(ROOT / "ontology/bds.yaml"), str(ROOT / "ontology/kinetic.yaml")
DSN = os.environ.get("BDS_PG_DSN", "postgresql://postgres:bds@127.0.0.1:55433/ontology_demo")
STEP = "--step" in sys.argv

B, DIM, OK, BAD, END = "\033[1m", "\033[2m", "\033[32m", "\033[31m", "\033[0m"


def scene(n: int, title: str, say: str) -> None:
    if STEP and n > 1:
        input(f"{DIM}[Enter để sang cảnh {n}]{END}")
    print(f"\n{B}━━ Cảnh {n}. {title}{END}\n{DIM}{say}{END}\n")


def table(rows: list[dict], cols: list[str]) -> None:
    widths = {c: max(len(c), *(len(str(r.get(c, ""))) for r in rows)) for c in cols} if rows else {}
    print("  " + "  ".join(c.ljust(widths[c]) for c in cols))
    for r in rows:
        print("  " + "  ".join(str(r.get(c, "")).ljust(widths[c]) for c in cols))


def lines(path: Path) -> int:
    return sum(1 for _ in path.open(encoding="utf-8"))


def main() -> None:
    # ---------------------------------------------------------------- 1
    scene(1, "Một nguồn định nghĩa",
          "Toàn bộ mô hình nghiệp vụ nằm trong 2 file YAML. Mọi thứ khác được sinh tự động từ đây.")
    sem = yaml.safe_load(Path(SCHEMA).read_text())
    kin = yaml.safe_load(Path(KINETIC).read_text())
    concrete = [c for c, v in sem["classes"].items() if not v.get("abstract") and not v.get("mixin")]
    interfaces = [c for c, v in sem["classes"].items() if v.get("mixin")]
    print(f"  Lớp ngữ nghĩa (bds.yaml, {lines(Path(SCHEMA))} dòng):")
    print(f"    object type : {', '.join(concrete)}")
    print(f"    interface   : {', '.join(interfaces)}")
    print(f"    danh mục    : {', '.join(sem['enums'])}")
    print(f"  Lớp hành động (kinetic.yaml, {lines(Path(KINETIC))} dòng):")
    print(f"    action      : {', '.join(kin['actions'])}")
    print(f"    function    : {', '.join(kin['functions'])}")
    print("\n  Sinh tự động:")
    for f, what in [("schema.sql", "bảng PostGIS có phiên bản theo thời gian"), ("models.py", "model Pydantic cho API"),
                    ("bds.schema.json", "JSON Schema kiểm tra file đối tác"), ("ai_tools.json", "công cụ cho AI agent")]:
        print(f"    {('generated/' + f).ljust(26)} {str(lines(ROOT / 'generated' / f)).rjust(4)} dòng  — {what}")

    rt = OntologyRuntime(SCHEMA, load_kinetic(KINETIC, SCHEMA))
    with psycopg.connect(DSN, autocommit=True, row_factory=dict_row) as conn:
        conn.execute("DROP SCHEMA IF EXISTS bds CASCADE")
        conn.execute((ROOT / "generated/schema.sql").read_text())
        base = {"source": "demo", "tenant_id": "hang-mau", "data_class": "public"}

        # ------------------------------------------------------------ 2
        scene(2, "Mọi thay đổi đi qua action",
              "Người dùng, job hay AI agent đều dùng chung một cửa: kiểm tra hợp lệ, ghi phiên bản, ghi nhật ký.")
        org = rt.apply(conn, "register_organization", {**base, "name": "Hãng mẫu", "org_type": "carrier",
                                                       "valid_from": "2025-07-01"}, actor="demo")["entity_id"]
        prov = rt.apply(conn, "register_admin_unit", {**base, "code": "T01", "name": "Tỉnh Mẫu", "level": 1,
                                                      "valid_from": "2025-07-01"}, actor="demo")["entity_id"]
        x1 = rt.apply(conn, "register_admin_unit", {**base, "code": "X01", "name": "Xã Mẫu Một", "level": 2,
                                                    "parent": str(prov), "valid_from": "2025-07-01"}, actor="demo")["entity_id"]
        x2 = rt.apply(conn, "register_admin_unit", {**base, "code": "X02", "name": "Xã Mẫu Hai", "level": 2,
                                                    "parent": str(prov), "valid_from": "2025-07-01"}, actor="demo")["entity_id"]
        po = rt.apply(conn, "register_facility", {**base, "code": "BC01", "name": "Bưu cục Mẫu 01",
                                                  "facility_type": "post_office", "operated_by": str(org),
                                                  "in_admin_unit": str(x1), "location": "POINT(106.07 21.18)",
                                                  "valid_from": "2025-08-01"}, actor="nhan-vien-a")["entity_id"]
        table(conn.execute("SELECT action_type, actor, to_char(created_at, 'HH24:MI:SS') luc FROM bds.action_log "
                           "ORDER BY created_at").fetchall(), ["action_type", "actor", "luc"])

        # ------------------------------------------------------------ 3
        scene(3, "Ontology chặn dữ liệu sai trước khi vào hệ thống",
              "Ba thao tác sai đều bị từ chối, kèm lý do bằng tiếng Việt; không có gì được ghi vào DB.")
        attempts = [
            ("Đăng ký bưu cục vào cấp tỉnh", "register_facility",
             {**base, "code": "BC99", "name": "Sai cấp", "facility_type": "post_office", "operated_by": str(org),
              "in_admin_unit": str(prov), "valid_from": "2025-09-01"}),
            ("Trùng mã bưu cục BC01", "register_facility",
             {**base, "code": "BC01", "name": "Trùng", "facility_type": "agent", "operated_by": str(org),
              "in_admin_unit": str(x1), "valid_from": "2025-09-01"}),
            ("Loại điểm không có trong danh mục", "register_facility",
             {**base, "code": "BC98", "name": "Sai loại", "facility_type": "kiosk", "operated_by": str(org),
              "in_admin_unit": str(x1), "valid_from": "2025-09-01"}),
        ]
        for label, action, params in attempts:
            try:
                rt.apply(conn, action, params, actor="nhan-vien-b")
                print(f"  {BAD}✗ {label}: lọt qua (không mong đợi){END}")
            except ActionRejected as e:
                print(f"  {OK}✓ chặn{END} {label} → {e.message}")
            except Exception as e:  # noqa: BLE001 — lỗi kiểm tra kiểu từ model sinh tự động
                print(f"  {OK}✓ chặn{END} {label} → sai kiểu dữ liệu ({type(e).__name__})")

        # ------------------------------------------------------------ 4
        scene(4, "Du hành thời gian: sáp nhập, đổi tên, chuyển địa bàn",
              "Ngày 01/01/2026 xã đổi tên; ngày 01/03/2026 bưu cục chuyển sang xã khác. ID thực thể không đổi.")
        rt.apply(conn, "rename_admin_unit", {"entity_id": str(x1), "name": "Phường Mẫu Một", "valid_from": "2026-01-01"},
                 actor="dong-bo-danh-muc")
        rt.apply(conn, "relocate_facility", {"entity_id": str(po), "in_admin_unit": str(x2),
                                             "location": "POINT(106.09 21.19)", "valid_from": "2026-03-01"},
                 actor="nhan-vien-a")
        rows = []
        for d in ("2025-12-31", "2026-02-01", "2026-03-15"):
            r = conn.execute("SELECT a.name xa FROM bds.facility_at(%(d)s) f JOIN bds.admin_unit_at(%(d)s) a "
                             "ON a.entity_id = f.in_admin_unit WHERE f.entity_id = %(e)s", {"d": d, "e": po}).fetchone()
            rows.append({"ngay": d, "BC01 thuoc": r["xa"]})
        table(rows, ["ngay", "BC01 thuoc"])
        print("\n  Lịch sử phiên bản của BC01 (không ghi đè, chỉ đóng bản cũ và mở bản mới):")
        table(conn.execute("SELECT valid_from::text tu, coalesce(valid_to::text, '(hiện hành)') den, "
                           "ST_AsText(location) vi_tri FROM bds.facility WHERE entity_id = %s ORDER BY valid_from",
                           (po,)).fetchall(), ["tu", "den", "vi_tri"])

        # ------------------------------------------------------------ 5
        scene(5, "Chỉ số định nghĩa một lần, dùng ở mọi nơi",
              "backlog_count là một function của ontology: dashboard, màn 3D và AI đọc cùng một con số.")
        for d in ("2026-03-09", "2026-03-10"):
            conn.execute("SELECT bds.ensure_shipment_event_partition(%s)", (d,))
        events = [("s1", "arrived", "08:00"), ("s1", "out_for_delivery", "10:00"), ("s2", "arrived", "08:30"),
                  ("s3", "arrived", "11:00"), ("s4", "arrived", "09:15")]
        for ref, typ, hhmm in events:
            conn.execute("INSERT INTO bds.shipment_event (event_id, shipment_ref, event_type, facility, ts, source, "
                         "tenant_id, data_class) VALUES (%s,%s,%s,%s,%s,'demo','hang-mau','internal')",
                         (str(uuid.uuid4()), ref, typ, po, f"2026-03-10T{hhmm}:00+07:00"))
        table([{"thoi_diem": t, "don_ton_BC01": rt.call(conn, "backlog_count", facility=po,
                                                         at=f"2026-03-10T{t}:00+07:00")}
               for t in ("08:45", "10:30", "12:00")], ["thoi_diem", "don_ton_BC01"])

        # ------------------------------------------------------------ 6
        scene(6, "Công cụ cho AI agent sinh tự động",
              "AI không tự viết SQL, không bịa số: nó gọi công cụ có kiểu; thay đổi dữ liệu phải có người duyệt.")
        tools = json.loads((ROOT / "generated/ai_tools.json").read_text())
        for t in tools:
            flag = "  [cần người duyệt]" if t.get("x-requires-human-approval") else ""
            print(f"  {t['name'].ljust(31)} {t['description'][:66]}{flag}")
        print(f"\n  Ví dụ JSON Schema của công cụ backlog_count:\n"
              f"  {json.dumps(next(t for t in tools if t['name'] == 'backlog_count')['input_schema'], ensure_ascii=False)}")
    print(f"\n{B}Hết demo.{END} Toàn bộ chạy trên PostgreSQL + PostGIS thật; test đầy đủ: cd poc/ontology && make test\n")


if __name__ == "__main__":
    main()
