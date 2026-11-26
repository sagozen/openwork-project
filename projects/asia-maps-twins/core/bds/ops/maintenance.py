"""Bảo trì dữ liệu không dựng lại được (schema ops, ml): sao lưu có xoay vòng, xoá log quá hạn.

  uv run python -m bds.ops.maintenance backup      # pg_dump schema ops + ml, giữ 14 bản gần nhất
  uv run python -m bds.ops.maintenance retention   # xoá log quá 180 ngày
"""

from __future__ import annotations

import subprocess
import sys
from datetime import datetime
from pathlib import Path

import psycopg

from bds.config import settings

BACKUP_DIR = Path("data/backup")
KEEP = 14
RETENTION_DAYS = 180
OPS_TABLES = ("geocode_log", "suggest_log", "place_select_log", "route_log", "shadow_compare")


def backup(container: str = "bds-postgis") -> Path:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    target = BACKUP_DIR / f"ops-{datetime.now():%Y%m%d-%H%M%S}.dump"
    with target.open("wb") as f:
        subprocess.run(["docker", "exec", container, "pg_dump", "-U", "postgres", "-d", "bds", "-n", "ops", "-n", "ml",
                        "-Fc"],
                       stdout=f, check=True)
    # Chỉ xoay vòng đúng các file sao lưu do hàm này tạo.
    for old in sorted(BACKUP_DIR.glob("ops-*.dump"), reverse=True)[KEEP:]:
        old.unlink()
    return target


def retention(days: int = RETENTION_DAYS) -> dict[str, int]:
    deleted = {}
    with psycopg.connect(settings().pg_dsn, autocommit=True) as conn:
        for table in OPS_TABLES:
            cur = conn.execute(f"DELETE FROM ops.{table} WHERE ts < now() - make_interval(days => %s)", (days,))
            deleted[table] = cur.rowcount
    return deleted


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "backup":
        path = backup()
        print(f"đã sao lưu: {path} ({path.stat().st_size / 1024:.0f} KB)")
    elif cmd == "retention":
        print("đã xoá:", retention())
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
