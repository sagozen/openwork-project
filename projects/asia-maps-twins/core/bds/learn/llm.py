"""Tầng 5: LLM gán nhãn các ca khó, chạy NGOÀI luồng xử lý yêu cầu (trong vòng học hằng đêm).

- Gọi endpoint chuẩn OpenAI (Ollama, vLLM... tự host) cấu hình bằng BDS_LLM_URL, BDS_LLM_MODEL.
- Chặn bịa: mỗi giá trị LLM trả về phải là một đoạn từ liên tiếp có trong chuỗi gốc (sau chuẩn hoá); không thì loại.
- Đồng ý với tagger, hoặc tagger không chắc → nhận làm nhãn huấn luyện; tagger chắc mà bất đồng → hàng chờ người duyệt.
- Địa chỉ lấy từ log đã che số điện thoại; không gửi tên, số điện thoại ra ngoài.
"""

from __future__ import annotations

import json
import logging

import httpx

from bds.config import settings
from bds.learn.tokens import tokenize

log = logging.getLogger(__name__)
FIELDS = {"house_no": "HOUSE", "alley": "ALLEY", "street": "STREET", "hamlet": "HAMLET", "place": "PLACE",
          "ward": "WARD", "district": "DISTRICT", "province": "PROVINCE"}

PROMPT = """Bạn là bộ tách địa chỉ Việt Nam cho logistics. Trả về DUY NHẤT một JSON với các khoá:
house_no, alley, street, hamlet, place, ward, district, province.
Quy tắc:
- Mỗi giá trị phải CHÉP NGUYÊN VĂN một đoạn liên tiếp trong địa chỉ (giữ cách viết như đầu vào). Không có thì để "".
- Không đoán, không thêm thông tin không có trong địa chỉ.
- "ngõ/ngách/hẻm/kiệt + số" → alley (gộp cả chuỗi ngõ ngách). "tổ/thôn/xóm/ấp/khu phố/bản + tên" → hamlet.
- Tên chợ, trường, bệnh viện, toà nhà, chung cư, khu công nghiệp, khu đô thị → place.
- "phường/xã/thị trấn/đặc khu" → ward; "quận/huyện/thị xã" → district; "tỉnh/thành phố trực thuộc TW" → province.
Địa chỉ: {address}"""


def configured() -> bool:
    return bool(settings().llm_url and settings().llm_model)


def extract(address: str, client: httpx.Client | None = None) -> dict | None:
    s = settings()
    client = client or httpx.Client(timeout=s.llm_timeout_s)
    try:
        r = client.post(f"{s.llm_url.rstrip('/')}/v1/chat/completions", json={
            "model": s.llm_model, "temperature": 0, "response_format": {"type": "json_object"},
            "messages": [{"role": "user", "content": PROMPT.format(address=address)}],
        })
        r.raise_for_status()
        content = r.json()["choices"][0]["message"]["content"]
        data = json.loads(content[content.find("{"):content.rfind("}") + 1])
    except (httpx.HTTPError, KeyError, ValueError) as e:
        log.warning("LLM lỗi với '%s': %s", address[:60], e)
        return None
    return {k: str(v).strip() for k, v in data.items() if k in FIELDS and v and str(v).strip()}


def align(address: str, fields: dict) -> tuple[list[str], list[str]] | None:
    """Chuyển kết quả LLM thành nhãn từng từ. Trả None nếu có giá trị không phải đoạn con của địa chỉ (bịa)."""
    tokens = tokenize(address)
    labels = ["O"] * len(tokens)
    for key, value in fields.items():
        span = [t for t in tokenize(value) if t != ","]
        if not span:
            continue
        for i in range(len(tokens) - len(span) + 1):
            if tokens[i:i + len(span)] == span and all(lab == "O" for lab in labels[i:i + len(span)]):
                labels[i:i + len(span)] = [FIELDS[key]] * len(span)
                break
        else:
            return None
    return tokens, labels


def judge(llm_labels: list[str], tagger_labels: list[str], tagger_conf: float) -> str:
    """Chính sách ít công vận hành: chỉ những ca LLM và tagger bất đồng trong khi tagger đang chắc mới cần người."""
    core = lambda labels: [x if x not in ("WARD", "DISTRICT", "PROVINCE") else "ADMIN" for x in labels]
    if core(llm_labels) == core(tagger_labels) or tagger_conf < 0.6:
        return "accepted"
    return "review"
