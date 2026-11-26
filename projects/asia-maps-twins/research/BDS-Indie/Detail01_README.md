# Bản đồ số 2.0 — Solo Founder Playbook

Mục tiêu 90 ngày: 1 tỉnh pilot chạy 100% Autocomplete + Geocoding nội bộ,
Route Matrix chạy shadow, có số liệu tiết kiệm thực tế so Google.

Nguyên tắc vận hành:
1. Data-first: không viết feature nào trước khi có golden set + eval harness.
2. Rule → Cache → AI. LLM không bao giờ nằm trong request path.
3. Agent làm 80% khối lượng; con người review, quyết định, demo.
4. Mọi PR phải kèm eval score trước/sau. Không score = không merge.
5. Zero vendor lock-in, zero license phí: PostGIS, OSRM, OpenSearch, Redis. (Không dùng Elasticsearch — license SSPL/ELv2, không còn thuần OSS.)

| File | Nội dung | Thời điểm dùng |
|---|---|---|
| ADR_week0.md | 3 bản ghi quyết định kiến trúc (Rule→Cache→AI; nguồn dữ liệu; PII + tagger) | Tuần 0 |
| Detail02_diagnosis.md | Đọc lại bài toán, luận điểm trình bày | Tuần 0 |
| Detail03_landscape.md | Overview Google/Grab/AWS/Mapbox/VN + bài học | Tuần 0 |
| Detail04_architecture.md | Kiến trúc, schema, API, perf/security | Tuần 1–2 |
| Detail07_agent_ops.md | Cách vận hành agent 24/7, prompt, guardrail | Tuần 1 → mãi |
| Detail05_roadmap.md | 90 ngày theo tuần, deliverable cầm được | Toàn bộ |
| Detail06_kpi.md | KPI thay thế "90% so Google", cách đo | Tuần 0 + báo cáo |
| Detail08_vietnamese_nlp.md | Xử lý tiếng Việt: chuẩn hoá, viết tắt, từ vùng miền, sáp nhập HC, tagger | Tuần 1 → mãi |
| Proposal01.md | Tài liệu trình duyệt tổng hợp (gồm rủi ro §13, chi phí §12) | Trình lãnh đạo |

Chi phí mục tiêu toàn dự án 90 ngày (ngoài lương bạn):
- Hạ tầng: 1 máy 8 vCPU/32GB + 1 PC workstation RTX 3090 24GB (đã có)
- AI coding agent: Claude Code / Cursor ~ $100–200/tháng
- LLM batch parse: self-host Qwen2.5-7B trên RTX 3090 24GB (hoặc API rẻ) ~ $50/tháng
- Dữ liệu: 0đ (OSM, Overture, lịch sử phát nội bộ; OpenAddresses gần như không có dữ liệu VN → bỏ qua)
- Fallback Goong/Google: chỉ shadow benchmark mẫu nhỏ, < 2tr/tháng