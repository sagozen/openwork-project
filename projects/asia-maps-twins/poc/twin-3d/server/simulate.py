"""Sinh mạng lưới điểm và số liệu vận hành MÔ PHỎNG cho PoC màn điều hành 3D.

- Vị trí: 599 bưu cục thật lấy từ OpenStreetMap (ODbL) làm điểm neo; phần còn lại tới N điểm được
  rải quanh các điểm neo, nên mật độ bám theo phân bố thật. Số liệu vận hành hoàn toàn là mô phỏng.
- Số liệu theo giờ trong 30 ngày: hàng đến (Poisson theo khung giờ), năng lực khai thác theo ca,
  sự cố giảm năng lực, đơn tồn tính theo hàng đợi, đơn tồn quá 48h tính theo FIFO.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import h3
import numpy as np

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
VN_TZ = timezone(timedelta(hours=7))
START = datetime(2026, 10, 7, 0, 0, tzinfo=VN_TZ)
DAYS = 30
HOURS = DAYS * 24
H3_RES = (5, 6, 7)
TYPES = ["post_office", "agent", "pickup_point", "hub"]
BASE_DAILY = {"post_office": 600.0, "agent": 80.0, "pickup_point": 40.0, "hub": 20000.0}
MEGA_HUBS = [(105.85, 21.03), (106.70, 10.78)]  # Hà Nội, TP. Hồ Chí Minh (toạ độ gần đúng)

# Hàng đến theo giờ trong ngày: đỉnh sáng và đầu giờ chiều.
ARRIVAL_PROFILE = np.array([1, 0.5, 0.3, 0.3, 0.5, 1.5, 4, 8, 10, 9, 7, 6,
                            5, 7, 8, 7, 6, 5, 4, 3, 2.5, 2, 1.5, 1.2], dtype=float)
ARRIVAL_PROFILE /= ARRIVAL_PROFILE.sum()
WORK_HOURS = np.zeros(24)
WORK_HOURS[7:21] = 1.0


@dataclass
class Simulation:
    code: list[str]
    name: list[str]
    ftype: np.ndarray          # int8, chỉ số trong TYPES
    lon: np.ndarray
    lat: np.ndarray
    backlog: np.ndarray        # int32 [HOURS, N]
    aging48: np.ndarray        # int32 [HOURS, N]
    daily_inbound: np.ndarray  # int32 [DAYS, N]
    stale: list[tuple[int, int, int]]   # (facility, giờ bắt đầu, giờ kết thúc) mất dữ liệu
    arcs_src: np.ndarray
    arcs_dst: np.ndarray
    arcs_daily: np.ndarray     # float [DAYS, E]
    h3_cells: dict[int, list[str]]
    h3_index: dict[int, np.ndarray]   # facility -> chỉ số ô H3 trong h3_cells[res]

    @property
    def n(self) -> int:
        return len(self.code)


def load_osm_anchors() -> list[tuple[float, float, str, int]]:
    raw = json.loads((DATA_DIR / "raw" / "osm_post_offices.json").read_text())
    anchors = []
    for el in raw["elements"]:
        lon = el.get("lon", el.get("center", {}).get("lon"))
        lat = el.get("lat", el.get("center", {}).get("lat"))
        if lon is None or not (102 <= lon <= 110 and 8 <= lat <= 23.6):
            continue
        # Tên trung tính: vị trí là thật, nhưng số liệu gắn vào là mô phỏng, không gán cho bưu cục có tên thật.
        anchors.append((lon, lat, f"Bưu cục OSM {el['id']}", el["id"]))
    return anchors


def build_network(n_total: int, rng: np.random.Generator):
    anchors = load_osm_anchors()
    lon = [a[0] for a in anchors]
    lat = [a[1] for a in anchors]
    code = [f"OSM-{a[3]}" for a in anchors]
    name = [a[2] for a in anchors]
    ftype = [0] * len(anchors)

    n_sim = n_total - len(anchors)
    pick = rng.integers(0, len(anchors), n_sim)
    sigma = np.where(rng.random(n_sim) < 0.75, 0.02, 0.06)
    lon += list(np.array([anchors[i][0] for i in pick]) + rng.normal(0, 1, n_sim) * sigma)
    lat += list(np.array([anchors[i][1] for i in pick]) + rng.normal(0, 1, n_sim) * sigma)
    sim_types = rng.choice([0, 1, 2], n_sim, p=[0.25, 0.70, 0.05])
    ftype += list(sim_types)
    code += [f"SIM-{i:05d}" for i in range(n_sim)]
    name += [f"Điểm mô phỏng {i:05d}" for i in range(n_sim)]

    lon_a, lat_a, ftype_a = np.array(lon), np.array(lat), np.array(ftype, dtype=np.int8)

    # Hub: mỗi ô 1°×1° đủ đông chọn điểm gần trọng tâm nhất; thêm hai hub lớn.
    cell = np.floor(lon_a).astype(int) * 1000 + np.floor(lat_a).astype(int)
    for c in np.unique(cell):
        members = np.where(cell == c)[0]
        if len(members) < 80:
            continue
        cx, cy = lon_a[members].mean(), lat_a[members].mean()
        best = members[np.argmin((lon_a[members] - cx) ** 2 + (lat_a[members] - cy) ** 2)]
        ftype_a[best] = TYPES.index("hub")
    mega = []
    for mx, my in MEGA_HUBS:
        best = int(np.argmin((lon_a - mx) ** 2 + (lat_a - my) ** 2))
        ftype_a[best] = TYPES.index("hub")
        mega.append(best)
    for i in np.where(ftype_a == TYPES.index("hub"))[0]:
        if not code[i].startswith("OSM-"):
            name[i] = f"Hub mô phỏng {code[i][4:]}"
    return code, name, ftype_a, lon_a, lat_a, mega


def simulate(n_total: int = 20000, seed: int = 7) -> Simulation:
    rng = np.random.default_rng(seed)
    code, name, ftype, lon, lat, mega = build_network(n_total, rng)
    n = len(code)

    base = np.array([BASE_DAILY[TYPES[t]] for t in ftype]) * rng.lognormal(0, 0.5, n)
    base[mega] *= 6
    day_factor = 1 + 0.15 * np.sin(np.arange(DAYS) / 7 * 2 * np.pi) + rng.normal(0, 0.05, DAYS)
    capacity = base * 1.12 / WORK_HOURS.sum()

    # Sự cố: 1,5% điểm mất 70% năng lực trong 1–4 ngày.
    incident = np.ones((HOURS, n))
    for f in rng.choice(n, int(n * 0.015), replace=False):
        start = rng.integers(0, HOURS - 24)
        incident[start:start + rng.integers(24, 97), f] = 0.3

    backlog = np.zeros((HOURS, n), dtype=np.int32)
    processed = np.zeros((HOURS, n), dtype=np.int64)
    arrivals = np.zeros((HOURS, n), dtype=np.int32)
    b = rng.poisson(base * 0.3).astype(np.int64)
    for h in range(HOURS):
        hod, day = h % 24, h // 24
        a = rng.poisson(base * ARRIVAL_PROFILE[hod] * day_factor[day])
        cap = capacity * (WORK_HOURS[hod] + 0.03) * incident[h]
        p = np.minimum(b + a, cap.astype(np.int64))
        b = b + a - p
        arrivals[h], processed[h], backlog[h] = a, p, b

    # Đơn tồn quá 48h theo FIFO: tồn của 48h trước trừ phần đã xử lý trong 48h qua.
    cum = np.cumsum(processed, axis=0)
    aging48 = np.zeros_like(backlog)
    done_48 = cum[48:] - cum[:-48]
    aging48[48:] = np.clip(backlog[:-48] - done_48, 0, None)
    aging48 = np.minimum(aging48, backlog)

    daily_inbound = arrivals.reshape(DAYS, 24, n).sum(axis=1).astype(np.int32)

    stale = []
    for f in rng.choice(n, int(n * 0.004), replace=False):
        start = int(rng.integers(0, HOURS - 3))
        stale.append((int(f), start, start + int(rng.integers(3, 11))))

    hubs = np.where(ftype == TYPES.index("hub"))[0]
    edges = set()
    for i in hubs:
        d = (lon[hubs] - lon[i]) ** 2 + (lat[hubs] - lat[i]) ** 2
        for j in hubs[np.argsort(d)[1:4]]:
            edges.add(tuple(sorted((int(i), int(j)))))
        nearest_mega = min(mega, key=lambda m: (lon[m] - lon[i]) ** 2 + (lat[m] - lat[i]) ** 2)
        if nearest_mega != i:
            edges.add(tuple(sorted((int(i), int(nearest_mega)))))
    src = np.array([e[0] for e in edges])
    dst = np.array([e[1] for e in edges])
    arcs_daily = np.sqrt(daily_inbound[:, src].astype(float) * daily_inbound[:, dst]) * 0.4

    h3_cells, h3_index = {}, {}
    for res in H3_RES:
        ids = [h3.latlng_to_cell(float(y), float(x), res) for x, y in zip(lon, lat)]
        cells, inverse = np.unique(ids, return_inverse=True)
        h3_cells[res], h3_index[res] = list(cells), inverse

    return Simulation(code, name, ftype, lon, lat, backlog, aging48, daily_inbound, stale,
                      src, dst, arcs_daily, h3_cells, h3_index)


def hour_label(h: int) -> str:
    return (START + timedelta(hours=h)).strftime("%Y-%m-%dT%H:%M:%S+07:00")
