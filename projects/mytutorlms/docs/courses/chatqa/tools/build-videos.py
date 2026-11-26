"""Dựng video từng bài của khoá ChatQASoftware: slide (build-media.mjs) + giọng đọc tiếng Việt VieNeu-TTS.

Chạy (venv có vieneu==3.8.3, model đã cache):
    HF_HUB_OFFLINE=1 <venv>/bin/python docs/courses/chatqa/tools/build-videos.py --ffmpeg <ffmpeg> [--only <id-bài>] [--voice "Ngọc Huyền"]

Vào: build/scenes.json, build/slides/<bài>/<nn>.png. Ra: build/video/<bài>.mp4, .srt, -poster.jpg.
Âm thanh thô cache theo nội dung lời đọc ở build/audio/raw (đổi lời thì chỉ thu lại cảnh đó).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
RAW = BUILD / "audio" / "raw"
SEG = BUILD / "audio" / "seg"
OUT = BUILD / "video"
TEMPO = 0.94
GAP = 0.7  # nghỉ sau mỗi cảnh
LEAD = 0.4  # im lặng trước lời đầu


# Phiên âm cho giọng đọc (kiểm bằng Whisper ngày 26/11/2026): tên riêng tiếng Anh đọc sai nếu để nguyên.
PRON = [
    (r"ChatQASoftware|chát cu a xóp|chát cu a", "Chát Kiu Ây"),
    (r"\bM C P\b|\bMCP\b", "em-xi-pi"),
    (r"\bClaude\b|\bClốt\b", "Cờ-lốt"),
    (r"\bCodex\b|\bcodex\b|Cô-đếch", "Cô-đéc"),
    (r"\badb\b", "a-đê-bê"),
    (r"\btoken\b", "tô-ken"),
]


def spoken(text: str) -> str:
    for pat, rep in PRON:
        text = re.sub(pat, rep, text)
    return text


# Phụ đề hiện chữ viết chuẩn khi lời đọc có phiên âm.
WRITTEN = [
    ("Clốt Đét-tóp", "Claude Desktop"), ("Clốt Cốt", "Claude Code"), ("Clốt", "Claude"), ("Cô-đếch", "Codex"),
    ("Uyn-đâu", "Windows"), ("An-đroi", "Android"), ("a-đê-bê", "adb"), ("U S B", "USB"), ("M C P", "MCP"),
    ("P D F", "PDF"), ("chát cu a", "chatqa"), ("Node JS", "Node.js"),
]


def written(text: str) -> str:
    for a, b in WRITTEN:
        text = text.replace(a, b)
    return text


def run(ff: str, args: list[str]) -> None:
    subprocess.run([ff, "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


def duration(path: Path) -> float:
    with wave.open(str(path)) as w:
        return w.getnframes() / float(w.getframerate())


def sentences(text: str) -> list[str]:
    parts = [p.strip() for p in re.split(r"(?<=[.!?])\s+", text) if p.strip()]
    return parts or [text]


def stamp(t: float) -> str:
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ffmpeg", required=True)
    ap.add_argument("--only", default="")
    ap.add_argument("--voice", default="Ngọc Huyền")
    a = ap.parse_args()
    ff = a.ffmpeg
    lessons = json.loads((BUILD / "scenes.json").read_text())
    if a.only:
        lessons = [l for l in lessons if l["id"] == a.only]
    for d in (RAW, SEG, OUT):
        d.mkdir(parents=True, exist_ok=True)

    from vieneu import Vieneu

    tts = Vieneu()
    for lesson in lessons:
        lid = lesson["id"]
        clips: list[Path] = []
        cues: list[tuple[float, float, str]] = []
        t = 0.0
        for i, scene in enumerate(lesson["scenes"]):
            say = spoken(scene["say"])
            key = hashlib.sha1(f"{a.voice}|{say}".encode()).hexdigest()[:16]
            raw = RAW / f"{key}.wav"
            if not raw.exists():
                audio = tts.infer(say, voice=a.voice, apply_watermark=False, silence_p=0.18)
                tts.save(audio, raw)
            seg = SEG / f"{lid}-{i:02d}.wav"
            lead = LEAD if i == 0 else 0.0
            run(ff, ["-i", str(raw), "-af", f"adelay={int(lead*1000)}:all=1,atempo={TEMPO},apad=pad_dur={GAP}", "-ar", "44100", "-ac", "1", "-c:a", "pcm_s16le", str(seg)])
            dur = duration(seg)
            # Phụ đề: chia lời (hoặc caption) theo câu, rải theo độ dài chữ trên phần có tiếng.
            talk = max(dur - GAP - lead, 0.5)
            parts = sentences(written(scene["caption"]))
            total = sum(len(p) for p in parts)
            cur = t + lead
            for p in parts:
                d = talk * len(p) / total
                cues.append((cur, cur + d, p))
                cur += d
            clip = SEG / f"{lid}-{i:02d}.mp4"
            png = BUILD / "slides" / lid / f"{i:02d}.png"
            run(ff, [
                "-loop", "1", "-framerate", "30", "-i", str(png), "-i", str(seg),
                "-c:v", "libx264", "-tune", "stillimage", "-preset", "medium", "-crf", "22", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-shortest", "-t", f"{dur:.3f}", str(clip),
            ])
            clips.append(clip)
            t += dur
        lst = SEG / f"{lid}.txt"
        lst.write_text("".join(f"file '{c}'\n" for c in clips))
        joined = SEG / f"{lid}-joined.mp4"
        run(ff, ["-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(joined)])
        out = OUT / f"{lid}.mp4"
        run(ff, [
            "-i", str(joined), "-c:v", "copy",
            "-af", f"afade=t=out:st={max(t-0.6,0):.3f}:d=0.6,loudnorm=I=-16:TP=-1.5:LRA=11",
            "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-movflags", "+faststart", str(out),
        ])
        (OUT / f"{lid}.srt").write_text(
            "\n".join(f"{n}\n{stamp(s)} --> {stamp(e)}\n{txt}\n" for n, (s, e, txt) in enumerate(cues, 1)), encoding="utf-8"
        )
        run(ff, ["-i", str(BUILD / "slides" / lid / "00.png"), "-vf", "scale=1280:-1", "-q:v", "3", str(OUT / f"{lid}-poster.jpg")])
        print(f"video {lid}: {t:.1f}s, {out.stat().st_size/1e6:.1f} MB", flush=True)


if __name__ == "__main__":
    main()
