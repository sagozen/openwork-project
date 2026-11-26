"""Chuẩn hoá chữ tiếng Việt cho so khớp địa chỉ.

- `fold`: chữ thường, bỏ dấu đúng cách (đ → d bằng bảng riêng, không dùng unidecode), gộp khoảng trắng.
- `expand_abbreviations`: mở viết tắt thường gặp trong địa chỉ (p., q., tp., kdt, kcn...), chạy trên chuỗi đã fold.
Giữ chuỗi gốc có dấu để hiển thị; chỉ dùng chuỗi đã fold để index và so khớp.
"""

from __future__ import annotations

import re
import unicodedata

_D_TABLE = str.maketrans({"đ": "d", "Đ": "d"})
# Giữ dấu chấm ở bước fold để nhận ra viết tắt (TT., Đ., P.); expand_abbreviations bỏ chấm sau cùng.
_KEEP = re.compile(r"[^a-z0-9/,.\- ]+")
_SPACES = re.compile(r"\s+")


def fold(text: str) -> str:
    text = unicodedata.normalize("NFC", text).translate(_D_TABLE).lower()
    text = "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c))
    text = _KEEP.sub(" ", text)
    text = re.sub(r"\.(?=\S)", ". ", text)  # "q.1" -> "q. 1"
    return _SPACES.sub(" ", text).strip(" ,.")


# Thứ tự quan trọng: mẫu dài trước mẫu ngắn. Mỗi mẫu chạy trên chuỗi đã fold, có ranh giới từ.
_ABBREVIATIONS: list[tuple[str, str]] = [
    (r"\b(?:tp|t p)\s*\.?\s*(?:hcm|ho chi minh)\b", "thanh pho ho chi minh"),
    (r"\b(?:tphcm|hcmc|hcm)\b", "thanh pho ho chi minh"),
    (r"\b(?:tp|t p)\s*\.?\s*hn\b", "thanh pho ha noi"),
    (r"\bhn\b", "ha noi"),
    (r"\b(?:tp|t p)\s*\.?\s*(?=[a-z])", "thanh pho "),
    (r"\b(?:tx|t x)\s*\.\s*", "thi xa "),
    (r"\btx\s+(?=[a-z])", "thi xa "),
    (r"\b(?:tt|t t)\s*\.\s*", "thi tran "),
    (r"\bkdt\b\.?", "khu do thi"),
    (r"\bkcn\b\.?", "khu cong nghiep"),
    (r"\bkcx\b\.?", "khu che xuat"),
    (r"\bchcc\b\.?", "chung cu cao cap"),
    (r"\bcc\s+(?=[a-z])", "chung cu "),
    (r"\btdp\b\.?", "to dan pho"),
    (r"\bkp\s*\.?\s*(?=[a-z0-9])", "khu pho "),
    (r"\bp\s*\.?\s*(?=\d)", "phuong "),
    (r"\bp\s*\.\s*(?=[a-z])", "phuong "),
    (r"\bq\s*\.?\s*(?=\d)", "quan "),
    (r"\bq\s*\.\s*(?=[a-z])", "quan "),
    # Khách hay gõ "p ben nghe", "q binh thanh" không có dấu chấm: chỉ mở khi sau là một từ chữ cái.
    (r"(?:(?<=\s)|(?<=^)|(?<=,))p\s+(?=[a-z]{2,})", "phuong "),
    (r"(?:(?<=\s)|(?<=^)|(?<=,))q\s+(?=[a-z]{2,})", "quan "),
    (r"\bh\s*\.\s*(?=[a-z])", "huyen "),
    (r"\bx\s*\.\s*(?=[a-z])", "xa "),
    (r"\bd\s*\.\s*(?=[a-z0-9])", "duong "),
    (r"\bng\s*\.\s*(?=\d)", "ngo "),
    (r"\bsn\s*\.?\s*(?=\d)", "so "),
]
_COMPILED = [(re.compile(p), r) for p, r in _ABBREVIATIONS]


def expand_abbreviations(folded: str) -> str:
    out = folded
    for pattern, repl in _COMPILED:
        out = pattern.sub(repl, out)
    out = out.replace(".", " ")
    return _SPACES.sub(" ", out).strip(" ,")


def normalize_address(text: str) -> str:
    """fold + mở viết tắt. Dấu phẩy được giữ để parser tách cụm."""
    return expand_abbreviations(fold(text))


# Từ chỉ loại đường, bỏ đi khi so khớp tên đường.
STREET_TYPE_WORDS = ("duong", "pho", "dai lo", "quoc lo", "tinh lo", "huong lo", "dt", "ql", "tl")
_STREET_PREFIX = re.compile(r"^(?:duong|pho|dai lo)\s+")


def street_key(name_folded: str) -> str:
    """Khoá so khớp tên đường: đã fold, bỏ tiền tố 'đường/phố/đại lộ', chuẩn hoá quốc lộ."""
    s = _STREET_PREFIX.sub("", name_folded.strip())
    s = re.sub(r"^(?:ql|quoc lo)\s*\.?\s*(\d+\w*)$", r"quoc lo \1", s)
    s = re.sub(r"^(?:tl|dt|tinh lo)\s*\.?\s*(\d+\w*)$", r"tinh lo \1", s)
    return s
