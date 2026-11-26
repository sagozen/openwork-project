# 03 — Vận hành AI agent 24/7

## 1. Bộ công cụ (chi phí thấp nhất đủ dùng)
| Vai trò | Công cụ | Chi phí/tháng |
|---|---|---|
| Coding agent chính | Claude Code (CLI, chạy nền được) hoặc Cursor | $100–200 |
| Batch LLM parse địa chỉ | Qwen2.5-7B/14B-Instruct qua vLLM trên RTX 3090 24GB (fallback: API rẻ DeepSeek/Qwen) | $0–50 |
| Model quyết định (System One/Jev) | Plumb-4B / decider-2B / Lichen tự host trên RTX 3090 24GB (fallback CPU: Laya 421M) | 0 |
| CI/CD | GitHub Actions / GitLab CI nội bộ | 0 |
| Scheduler | cron / systemd timer (không dùng Airflow giai đoạn này) | 0 |
| Alert → agent | Grafana webhook → script tạo issue + gọi Claude Code `-p` | 0 |

## 2. File `CLAUDE.md` (quy tắc bắt buộc cho agent — dán vào root repo)
Bạn là engineer của dự án vtp-maps. Quy tắc:

- Đọc docs/02-architecture.md trước mọi task. Không đổi kiến trúc nếu không có ADR.
- Mỗi task: viết test trước (tests/unit hoặc tests/golden), rồi code, rồi chạy make test.
- Thay đổi parser/resolver/search PHẢI chạy make eval và dán bảng before/after vào PR.
- Accuracy giảm → không tạo PR, báo lại.
- Không gọi API ngoài (Google/Goong) trong code production trừ module resolver/external.py.
- Không log/gửi SĐT, tên khách. Địa chỉ gửi LLM ngoài phải qua pipeline/mask.py.
- Không merge vào main. Tạo branch agent/<task-id>, mở PR, chờ review.
- Ưu tiên: đơn giản > thông minh. Pure python/SQL trước, ML sau.
- Tiếng Việt không dấu là mặc định cho mọi so khớp.
- Commit message: [<module>] <việc> | eval: <before>→<after>.

## 3. Các agent loop chạy định kỳ
### 3.1 `nightly-feedback` (cron 01:00)
1. ETL: lấy scan "phát thành công" 24h qua (order_id, gps, ts, post_office) + địa chỉ raw đơn.
2. Join geocode_log theo order_id → distance(gps, result_geom).
3. Upsert delivery_points: n_success++, geom = median GPS, gps_spread_m.
4. Ghi eval_daily: accuracy@50m, @200m, @ward theo tỉnh/bưu cục/level.
5. Xuất report markdown → Slack/Telegram 7:00.

Script thuần Python/SQL, không cần LLM. Agent chỉ viết nó 1 lần.

### 3.2 `parser-retrain` (cron 02:00, có LLM)
Input: địa chỉ 24h qua có parse_conf < 0.5 hoặc geocode sai > 500m (có nhãn từ 3.1)
Bước:
a. mask.py → bỏ tên/SĐT
b. LLM batch: trích components JSON cho từng địa chỉ (prompt ở mục 4)
c. Bổ sung vào tập huấn luyện tagger (delivery_points + golden_set đã gán nhãn)
d. Retrain tagger (PhoBERT / char-BiLSTM) trên RTX 3090 → gọi Claude Code:
"Retrain tagger với nhãn mới. Viết test, chạy make eval, mở PR kèm bảng trước/sau."
Output: 0–3 PR/đêm, mỗi PR kèm eval before/after.

Bạn: sáng review 10–30 phút, merge.

### 3.3 `shadow-benchmark` (cron 03:00, mẫu ≤ 1.000)

Lấy 1.000 địa chỉ random có nhãn GPS → gọi /geocode nội bộ + Goong (+ Google mẫu 200)
→ tính accuracy@200m từng nguồn → report.

### 3.4 `alert-triage` (event-driven)
Grafana alert (p95 tăng, accuracy tụt, external_calls tăng) → webhook → script:
`claude -p "Phân tích log 30 phút qua tại ... , xác định nguyên nhân, đề xuất fix, mở issue"` → bạn nhận issue có sẵn phân tích.

### 3.5 `weekly-report` (thứ 2, 06:00)
Agent tổng hợp eval_daily tuần → markdown 1 trang: accuracy trend, cost tiết kiệm (= external_calls tránh được × đơn giá Google), top-10 ward tụt, PR đã merge. Bạn copy vào slide.

## 4. Prompt batch parse (self-host)

Bạn là bộ phân tích địa chỉ Việt Nam cho logistics. Trích JSON:
{"house_no":"","alley":"","street":"","hamlet":"","kdt_kcn":"","ward":"","province":"","landmark":"","residual":""}
Quy tắc: giữ nguyên chữ không dấu; "ngõ/ngách/hẻm/kiệt" → alley kèm số;
"tổ/thôn/xóm/ấp/khu phố" → hamlet; không đoán ward/province nếu không có trong chuỗi.
Địa chỉ: {addr_masked}
Gợi ý tỉnh/xã đã chọn trên OMS: {province_hint}/{ward_hint}

Chạy vLLM batch 1.000 địa chỉ/phút trên 1 GPU 24GB; không GPU → API rẻ, ~$1/100k địa chỉ.

## 5. Cách giao task cho coding agent (template)

Task <id>: <tên>

Context: docs/02-architecture.md §<n>
Mục tiêu: <1 câu>
Acceptance:

- test mới trong tests/<...> pass
- make eval không giảm; đính kèm bảng
- p95 không tăng > 10% (make load)
- Không làm: <liệt kê để agent không lan man>

Mỗi task ≤ 1 ngày agent. Task lớn → bạn chia nhỏ, đừng để agent tự chia.

## 6. Guardrail
- Branch protection: main chỉ merge qua PR + CI xanh + 1 approve (bạn).
- CI chạy: unit, golden eval, load test nhẹ, `ruff`, `mypy`.
- Agent không có credential production DB; chỉ có DB staging (bản sao nightly).
- Giới hạn chi phí LLM API: hard cap $5/ngày trong script.
