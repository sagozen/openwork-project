# 05 — KPI thay thế "90% so Google"

## 1. Nguyên tắc
Đo bằng **kết quả vận hành** (giao được không, tốn bao nhiêu tiền), không đo bằng khoảng cách tới Google.
Mọi KPI phải tính tự động hàng ngày từ `eval_daily` + Prometheus, không ai nhập tay.

## 2. Bảng KPI
| # | KPI | Định nghĩa | Baseline (tuần 1) | Mục tiêu T+90 | Nguồn |
|---|---|---|---|---|---|
| 1 | **Geocode accuracy@200m** | % địa chỉ golden có kết quả cách GPS phát thực ≤ 200m | đo | ≥ 90% tỉnh pilot | eval_daily |
| 2 | Geocode accuracy@50m | như trên, ≤ 50m (tương đương ROOFTOP) | đo | ≥ 70% | eval_daily |
| 3 | **Internal coverage** | % request có `conf ≥ 0.7` không cần external | 0% | ≥ 80% | Prometheus |
| 4 | **Cost/1M request** | (hạ tầng + LLM + external) / request | Google: Geocoding $5/1k · Autocomplete (mới) theo session ≈ $17/1k session (legacy per-request $2.83/1k) · Distance Matrix $5/1k element | < 5% Google | Prometheus + hóa đơn |
| 5 | Tiền tiết kiệm lũy kế | external_calls tránh được × đơn giá Google | 0 | báo cáo số thực | weekly-report |
| 6 | **Autocomplete top-3 hit** | % session chọn 1 trong 3 gợi ý đầu | đo (~60% theo slide) | ≥ 85% | session log |
| 7 | Thời gian tạo đơn | median giây từ gõ ký tự đầu → chọn địa chỉ | đo | giảm ≥ 30% | session log |
| 8 | **Tỉ lệ phát thất bại do sai địa chỉ** | mã lý do "sai địa chỉ/không tìm thấy" / tổng phát, tỉnh pilot | đo | giảm ≥ 20% tương đối | hệ thống phát |
| 9 | Matrix sai lệch | % cặp lệch ≤ 20% so thực tế (GPS trace) hoặc Google mẫu | đo | ≥ 85% | shadow-benchmark |
| 10 | p95 latency | theo 02-architecture §7 | — | đạt | Prometheus |
| 11 | Tốc độ tự cải thiện | Δ accuracy@200m / tuần, không có can thiệp thủ công | — | > 0 liên tục 8 tuần | eval_daily |
| 12 | PR cải thiện parser (tagger/rule) do agent đề xuất được merge | số PR/tuần từ parser-retrain | 0 | ≥ 5 | git |

## 3. Cách trình bày với lãnh đạo (1 slide)
- Trái: đường accuracy@200m theo ngày (nội bộ vs Google mẫu vs 1.0) — chứng minh "tự tốt lên".
- Phải trên: tiền tiết kiệm lũy kế + cost/1M.
- Phải dưới: tỉ lệ phát thất bại do sai địa chỉ trước/sau.
- Footer: "0 đồng mua dữ liệu, 0 tuyển mới, X PR do agent đề xuất đã merge".

## 4. SQL mẫu tính KPI 1 (agent mở rộng)
```sql
SELECT date_trunc('day', g.ts) d,
       avg((ST_DistanceSphere(g.result_geom, s.gps_geom) <= 200)::int) acc200,
       avg((ST_DistanceSphere(g.result_geom, s.gps_geom) <= 50)::int)  acc50,
       count(*) n
FROM geocode_log g JOIN delivery_scans s USING (order_id)
WHERE s.status = 'SUCCESS' AND g.ts > now() - interval '30 days'
GROUP BY 1 ORDER BY 1;