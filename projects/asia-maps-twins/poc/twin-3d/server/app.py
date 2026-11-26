"""API cho PoC màn điều hành 3D. Toàn bộ số liệu vận hành là MÔ PHỎNG (xem simulate.py).

Luồng dữ liệu theo ADR-0004: mở màn hình lấy danh sách điểm + ảnh chụp số liệu tại một giờ;
sau đó WebSocket đẩy phần thay đổi mỗi khi "bảng tổng hợp làm mới" (ở đây mô phỏng mỗi vài giây).
"""

from __future__ import annotations

import asyncio
import time

import numpy as np
from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.gzip import GZipMiddleware

from simulate import DAYS, H3_RES, HOURS, TYPES, hour_label, simulate

SIM = simulate()
app = FastAPI(title="BDS twin 3D PoC")
app.add_middleware(GZipMiddleware, minimum_size=1024)
LIVE_INTERVAL_S = 3.0
LIVE_FRACTION = 0.05


def _stale_at(h: int) -> list[int]:
    return [f for f, s, e in SIM.stale if s <= h < e]


def _spikes_at(h: int) -> list[int]:
    """Đơn tồn tăng bất thường: gấp 3 lần trung vị 7 ngày trước đó và từ 50 đơn trở lên."""
    window = SIM.backlog[max(0, h - 168):h + 1]
    median = np.median(window, axis=0)
    return np.where((SIM.backlog[h] >= 50) & (SIM.backlog[h] > 3 * np.maximum(median, 1)))[0].tolist()


@app.get("/api/meta")
def meta():
    return {"hours": HOURS, "days": DAYS, "start": hour_label(0), "n": SIM.n, "types": TYPES,
            "h3_res": list(H3_RES), "live_interval_s": LIVE_INTERVAL_S, "simulated": True}


@app.get("/api/facilities")
def facilities():
    return {"code": SIM.code, "name": SIM.name, "type": SIM.ftype.tolist(),
            "lon": np.round(SIM.lon, 5).tolist(), "lat": np.round(SIM.lat, 5).tolist()}


@app.get("/api/snapshot")
def snapshot(hour: int = Query(..., ge=0, lt=HOURS), res: int = Query(6)):
    if res not in H3_RES:
        raise HTTPException(400, f"res phải thuộc {H3_RES}")
    day = hour // 24
    backlog, aging = SIM.backlog[hour], SIM.aging48[hour]
    hex_values = np.bincount(SIM.h3_index[res], weights=SIM.daily_inbound[day], minlength=len(SIM.h3_cells[res]))
    top = np.argsort(-backlog)[:10]
    return {
        "hour": hour, "label": hour_label(hour),
        "backlog": backlog.tolist(), "aging48": aging.tolist(),
        "stale": _stale_at(hour), "spikes": _spikes_at(hour),
        "hex": {"res": res, "id": SIM.h3_cells[res], "value": hex_values.astype(int).tolist()},
        "arcs": {"src": SIM.arcs_src.tolist(), "dst": SIM.arcs_dst.tolist(),
                 "value": np.round(SIM.arcs_daily[day]).astype(int).tolist()},
        "top": [{"i": int(i), "code": SIM.code[i], "name": SIM.name[i], "backlog": int(backlog[i]),
                 "aging48": int(aging[i])} for i in top],
        "totals": {"backlog": int(backlog.sum()), "aging48": int(aging.sum()),
                   "daily_inbound": int(SIM.daily_inbound[day].sum())},
    }


@app.get("/api/facility/{i}")
def facility(i: int, hour: int = Query(..., ge=0, lt=HOURS)):
    if not 0 <= i < SIM.n:
        raise HTTPException(404, "không có điểm này")
    start = max(0, hour - 71)
    day = hour // 24
    return {
        "i": i, "code": SIM.code[i], "name": SIM.name[i], "type": TYPES[SIM.ftype[i]],
        "lon": float(SIM.lon[i]), "lat": float(SIM.lat[i]),
        "backlog_72h": SIM.backlog[start:hour + 1, i].tolist(),
        "aging48_72h": SIM.aging48[start:hour + 1, i].tolist(),
        "daily_inbound_7d": SIM.daily_inbound[max(0, day - 6):day + 1, i].tolist(),
        "first_hour": start,
    }


@app.websocket("/ws/live")
async def live(ws: WebSocket):
    """Mỗi LIVE_INTERVAL_S giây, mô phỏng một lần làm mới bảng tổng hợp và đẩy phần thay đổi."""
    await ws.accept()
    rng = np.random.default_rng()
    hour = HOURS - 1
    backlog = SIM.backlog[hour].astype(np.int64).copy()
    aging = SIM.aging48[hour].astype(np.int64).copy()

    async def receive():
        nonlocal hour, backlog, aging
        while True:
            msg = await ws.receive_json()
            if "hour" in msg:
                hour = int(msg["hour"])
                backlog = SIM.backlog[hour].astype(np.int64).copy()
                aging = SIM.aging48[hour].astype(np.int64).copy()

    reader = asyncio.create_task(receive())
    try:
        while True:
            await asyncio.sleep(LIVE_INTERVAL_S)
            idx = rng.choice(SIM.n, int(SIM.n * LIVE_FRACTION), replace=False)
            backlog[idx] = np.maximum(0, backlog[idx] + rng.normal(0, 0.15, len(idx)) * (backlog[idx] + 5)).astype(np.int64)
            aging[idx] = np.minimum(aging[idx], backlog[idx])
            await ws.send_json({"sent_at_ms": time.time() * 1000, "hour": hour, "idx": idx.tolist(),
                                "backlog": backlog[idx].tolist(), "aging48": aging[idx].tolist()})
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        reader.cancel()
