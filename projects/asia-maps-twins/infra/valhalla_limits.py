"""Nâng giới hạn dịch vụ của Valhalla cho nhu cầu logistics (mặc định ma trận tối đa 2.500 cặp điểm).

Chạy sau khi Valhalla đã sinh data/valhalla/valhalla.json lần đầu: make valhalla-config
"""

import json
import sys
from pathlib import Path

OVERRIDES = {
    "auto": {"max_matrix_location_pairs": 10000},
    "truck": {"max_matrix_location_pairs": 10000},
    # Xe máy: mặc định chỉ cho tuyến tối đa 500 km; nâng để tuyến liên tỉnh dài không rơi vào dự phòng.
    "motor_scooter": {"max_matrix_location_pairs": 10000, "max_distance": 2_000_000.0},
}


def main(path: str = "data/valhalla/valhalla.json") -> None:
    p = Path(path)
    config = json.loads(p.read_text())
    for costing, values in OVERRIDES.items():
        config["service_limits"][costing].update(values)
    p.write_text(json.dumps(config, indent=2))
    print("đã cập nhật giới hạn:", OVERRIDES)


if __name__ == "__main__":
    main(*sys.argv[1:])
