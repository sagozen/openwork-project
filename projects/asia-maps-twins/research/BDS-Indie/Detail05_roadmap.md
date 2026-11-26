# 04 — Roadmap 90 ngày (12 tuần)

Nguyên tắc: mỗi tuần có 1 thứ **chạy được + đo được**. Demo thứ 6 hàng tuần, 15 phút.

| Tuần | Milestone | Bạn làm | Agent làm | Deliverable cầm được |
|---|---|---|---|---|
| 0 | Quyền + máy + tỉnh pilot | Xin data access, máy, chốt KPI | ADR 001–003 (ADR_week0.md) | 3 ADR, quyền truy cập log phát |
| 1 | **Golden set + baseline** | Chọn 1.000 địa chỉ có ≥3 lần phát thành công, GPS spread < 50m | Script extract, tính accuracy *hiện tại* của bản đồ 1.0 và Goong/Google mẫu 200 trên golden set | **Con số đối chứng**: "1.0 đạt X%, Google Y%" |
| 2 | Data foundation | Review schema | docker-compose (PostGIS, OpenSearch, Redis), ingest OSM + Overture + admin 2 cấp + alias cũ→mới, ingest 213k/863k địa chỉ nội bộ | `make up` chạy 1 lệnh; bảng dữ liệu đầy |
| 3 | Feedback pipeline + eval harness | Verify join scan↔đơn đúng | `nightly-feedback`, `make eval`, CI | `delivery_points` tự lớn mỗi đêm; eval chạy trong CI |
| 4 | Parser v1 | Viết 50 rule đầu tay cho tỉnh pilot (bạn hiểu địa chỉ VN hơn agent) | Normalize, bootstrap tagger, 300 unit test từ golden set | parse_conf ≥ 0.5 cho ≥ 85% địa chỉ pilot |
| 5 | Resolver cascade | Review ngưỡng conf | Bước 1–5, Redis, `/geocode` + OpenAPI, Prometheus | Accuracy@200m trên golden ≥ baseline 1.0 |
| 6 | Shadow geocode 1% | Xin OMS gửi shadow traffic | Shadow middleware, `shadow-benchmark`, Grafana | Dashboard accuracy ngày + cost |
| 7 | Autocomplete v1 | Chọn 2 bưu cục A/B | OpenSearch index, rerank, session log | Top-3 hit ≥ 75% offline |
| 8 | A/B autocomplete tại 2 bưu cục | Thu feedback bưu cục | LTR dataset, tune function_score | Top-3 hit ≥ 85%; thời gian tạo đơn giảm |
| 9 | OSRM + /matrix | Chọn profile xe | Build OSRM, cache, precompute hub↔hub, so 10k cặp với Google Distance Matrix (mẫu) | Sai lệch ≤ 20% ở ≥ 85% cặp |
| 10 | `parser-retrain` + `alert-triage` | Review PR đầu tiên từ agent | 2 loop chạy tự động | Hệ thống tự ra PR mỗi đêm |
| 11 | Pilot 100% tỉnh | Chốt với OMS bật 100% autocomplete + geocode | Load test, runbook, backup | Tỉnh pilot chạy nội bộ, Google = fallback conf<0.5 |
| 12 | Báo cáo & kế hoạch scale | Trình bày | `weekly-report` 12 tuần, cost thực tế, roadmap tỉnh 2–10 | Slide 5 trang + đề xuất nhân rộng |

## Điều kiện dừng/pivot (kiểm tra cuối tuần 3 và 6)
- Tuần 3: nếu không join được scan GPS ↔ đơn với ≥ 70% đơn → thiếu ground truth → đề xuất sửa app bưu tá (nút "ghim vị trí") trước khi làm tiếp.
- Tuần 6: nếu accuracy@200m < baseline 1.0 → dừng mở rộng, tập trung parser/alias 2 tuần.

## Sau 90 ngày (phác thảo)
- Tháng 4–6: nhân rộng 10 tỉnh (chủ yếu thêm dữ liệu + retrain tagger, không thêm code), HN/HCM cuối.
- Tháng 7–9: LTR model cho autocomplete, zone auto-generation từ delivery_points, tích hợp phân tuyến.
- Tháng 10–12: toàn quốc, tắt Google trừ fallback, báo cáo tiết kiệm năm.