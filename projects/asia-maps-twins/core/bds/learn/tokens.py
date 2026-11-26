"""Tách từ cho tagger: chạy sau tầng luật (chuẩn hoá + mở viết tắt), dấu phẩy là một từ riêng."""

from __future__ import annotations

import re

from bds.text.normalize import normalize_address

LABELS = ("HOUSE", "ALLEY", "STREET", "HAMLET", "PLACE", "WARD", "DISTRICT", "PROVINCE", "O")
_TOKEN = re.compile(r",|[^\s,]+")


def tokenize(raw: str) -> list[str]:
    return _TOKEN.findall(normalize_address(raw))
