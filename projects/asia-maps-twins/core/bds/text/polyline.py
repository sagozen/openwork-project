"""Encoded polyline (thuật toán của Google). Valhalla trả độ chính xác 6, Google API dùng độ chính xác 5."""

from __future__ import annotations


def decode(encoded: str, precision: int = 5) -> list[tuple[float, float]]:
    """Trả danh sách (lat, lng)."""
    factor = 10 ** precision
    points, index, lat, lng = [], 0, 0, 0
    while index < len(encoded):
        for coord in (0, 1):
            shift, result = 0, 0
            while True:
                b = ord(encoded[index]) - 63
                index += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            delta = ~(result >> 1) if result & 1 else result >> 1
            if coord == 0:
                lat += delta
            else:
                lng += delta
        points.append((lat / factor, lng / factor))
    return points


def encode(points: list[tuple[float, float]], precision: int = 5) -> str:
    factor = 10 ** precision
    out, prev_lat, prev_lng = [], 0, 0
    for lat, lng in points:
        ilat, ilng = round(lat * factor), round(lng * factor)
        for delta in (ilat - prev_lat, ilng - prev_lng):
            value = ~(delta << 1) if delta < 0 else delta << 1
            while value >= 0x20:
                out.append(chr((0x20 | (value & 0x1F)) + 63))
                value >>= 5
            out.append(chr(value + 63))
        prev_lat, prev_lng = ilat, ilng
    return "".join(out)
