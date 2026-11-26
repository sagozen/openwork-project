# 02 — Kiến trúc: Rule + Cache + AI quyết định + AI sinh, data-first

## 1. Sơ đồ
OMS / App / Web / TMS / Phân tuyến
│
┌───────▼──────────────────────────────────────────┐
│ API Gateway (FastAPI): api_key, rate limit,       │
│ session_token, request_id, audit log              │
└───┬──────────────────┬──────────────────┬────────┘
     │                  │                  │
┌────▼────────┐  ┌──────▼──────────┐  ┌─────▼───────┐
│/autocomplete│  │/geocode         │  │/matrix      │
│ OpenSearch  │  │Parser → Resolver│  │OSRM table   │
│ + rerank    │  │cascade + conf   │  │+ cache cặp  │
└────┬────────┘  └──────┬──────────┘  └─────┬───────┘
     └──────────── Redis L1 cache ───────────┘
┌──────────────────────▼───────────────────────────┐
│ PostGIS (source of truth)                        │
│ admin_units · streets · buildings · pois         │
│ delivery_points · zones · address_alias          │
└──────────────────────▲───────────────────────────┘
┌──────────────────────┴───────────────────────────┐
│ Nightly pipeline (cron + agent)                  │
│ scan GPS ⟷ geocoded → label → delivery_points    │
│ eval golden set → report → parser-retrain PR     │
└──────────────────────────────────────────────────┘

Stack: Python 3.12 + FastAPI, PostgreSQL 16 + PostGIS 3.4, OpenSearch 2.x, Redis 7, OSRM, Docker Compose, Prometheus + Grafana. Tất cả 1 máy 8c/32GB chạy được cho 1 tỉnh pilot; scale ngang sau. LLM batch + tagger + model quyết định (System One) chạy trên **RTX 3090 24GB (PC workstation)** — không nằm trong request path nóng.

## 2. Schema PostGIS (tối thiểu)
```sql
-- Đơn vị hành chính 2 cấp mới + ánh xạ cũ
CREATE TABLE admin_units (
  id serial PRIMARY KEY,
  level smallint,            -- 1=tỉnh, 2=xã/phường (mô hình 2 cấp)
  code text UNIQUE,
  name text, name_norm text, -- không dấu, lowercase
  parent_id int REFERENCES admin_units(id),
  geom geometry(MultiPolygon,4326),
  valid_from date, valid_to date
);
CREATE TABLE admin_alias (          -- tên cũ, viết tắt, ánh xạ 3 cấp → 2 cấp
  alias_norm text, unit_id int REFERENCES admin_units(id), kind text
);
CREATE TABLE streets (
  id bigserial PRIMARY KEY, osm_id bigint,
  name text, name_norm text, unit_id int,
  geom geometry(MultiLineString,4326)
);
CREATE TABLE pois (
  id bigserial PRIMARY KEY, source text, -- osm|overture|internal
  name text, name_norm text, category text, unit_id int,
  geom geometry(Point,4326)
);
-- Scan phát thô (ingest từ VTMan/E2) — nguồn nhãn ground truth
CREATE TABLE delivery_scans (
  order_id text PRIMARY KEY,
  ts timestamptz,
  gps_geom geometry(Point,4326),
  accuracy_m real,             -- độ chính xác GPS thiết bị
  status text,                 -- SUCCESS / FAIL / ...
  post_office_code text,
  courier_id text              -- ẩn danh (hash) nếu cần
);
-- Nhãn vàng từ vận hành
CREATE TABLE delivery_points (
  id bigserial PRIMARY KEY,
  addr_norm text NOT NULL,          -- chuỗi chuẩn hóa (KHÔNG chứa tên/SĐT)
  addr_hash text GENERATED ALWAYS AS (md5(addr_norm)) STORED,
  geom geometry(Point,4326),
  n_success int DEFAULT 0, n_fail int DEFAULT 0,
  last_success_at timestamptz,
  post_office_code text, zone_code text,
  gps_spread_m real,                -- độ phân tán GPS các lần phát
  source text DEFAULT 'delivery',   -- lineage
  valid_from date, valid_to date
);
CREATE INDEX ON delivery_points (addr_hash);
CREATE INDEX ON delivery_points USING gist (geom);
CREATE TABLE zones (code text PRIMARY KEY, post_office_code text, geom geometry(MultiPolygon,4326), valid_from date, valid_to date);
CREATE TABLE geocode_log (          -- phục vụ feedback + eval; giữ 180 ngày
  request_id uuid, ts timestamptz, raw text, addr_norm text,
  result_geom geometry(Point,4326), level text, confidence real,
  source text, order_id text, latency_ms int
);
-- Building footprint (Overture) cho nội suy số nhà (resolver tầng 3)
CREATE TABLE buildings (
  id bigserial PRIMARY KEY, source text,      -- overture
  unit_id int, geom geometry(Polygon,4326),
  house_no text, street_id bigint
);
-- Golden set: tập địa chỉ có toạ độ đúng (≥3 lần phát, GPS hội tụ <50m)
CREATE TABLE golden_set (
  addr_norm text PRIMARY KEY,
  geom geometry(Point,4326),
  unit_id int, source_order_id text
);
-- Đánh giá hàng ngày (KPI từ eval_daily)
CREATE TABLE eval_daily (
  d date, unit_id int, level text,
  n int, acc50 real, acc200 real, acc_ward real
);
```

## 3. Address Parser (normalize rule → sequence tagger → LLM tail)
Pipeline `normalize(raw) → tag(tagger) → components`:

1. **normalize (rule, ổn định):** lowercase, bỏ dấu đúng cách (NFKD + bảng riêng cho đ/Đ — không naive unidecode), bỏ ký tự thừa, chuẩn viết tắt từ `rules/abbrev.yaml`:
   `p: phuong  q: quan  tt: thi tran  tx: thi xa  tp: thanh pho`
   `kdt: khu do thi  kcn: khu cong nghiep  cc: chung cu`
   `ngo|ngach|hem|kiet: alley  to|thon|xom|ap|khu pho: hamlet`
2. **sequence tagger (self-host, retrain đêm — lựa chọn dễ bảo trì):** PhoBERT-base hoặc char-BiLSTM-CRF gán nhãn house_no / alley / street / hamlet / ward / province trên từng token. Thay grammar regex (vốn phình to khó bảo trì). Bootstrap tuần 4 bằng ~50 rule tay để sinh nhãn đầu; từ tuần 5–6 tagger là chính, rule chỉ còn normalize + admin_alias trie.
3. **LLM tail:** chỉ khi tagger `parse_conf` thấp; batch đêm, self-host (Qwen2.5-7B-Instruct, vLLM) hoặc API rẻ; output JSON components → bổ sung vào tập huấn luyện → retrain tagger (không phát sinh nợ regex).
4. Output: `{house_no, alley, street, hamlet, ward_id, province_id, residual, parse_conf}`.

## 4. Geocoding Resolver — cascade có confidence

| Bước | Điều kiện | Level | Conf |
|---|---|---|---|
| 0 | Redis hit `geo:{addr_hash}` | cached | như gốc |
| 1 | delivery_points match addr_hash, n_success ≥ 2, gps_spread_m < 60 | ROOFTOP | 0.95 |
| 2 | delivery_points fuzzy: **model quyết định (System One)** chấm "cùng địa chỉ?" trên N ứng viên cùng ward → xác suất | ROOFTOP | theo xác suất |
| 3 | Số nhà + street: nội suy theo building (Overture) hoặc tuyến tính trên street | RANGE_INTERPOLATED | 0.70–0.80 |
| 4 | Chỉ street/POI/hamlet trong ward | GEOMETRIC_CENTER | 0.50 |
| 5 | Centroid ward | APPROXIMATE | 0.30 |
| 6 | External (Goong) — chỉ khi conf<0.5 và allow_external=true, có đếm cost | EXTERNAL | theo nguồn |

Response mẫu:
```json
{"lat":21.01,"lng":105.84,"level":"ROOFTOP","confidence":0.95,
 "components":{...},"zone":"HNI-CG-03","post_office":"HNI-CG",
 "source":"delivery_points","request_id":"..."}
```

## 5. Autocomplete
- Index OpenSearch `addr_suggest`: docs = delivery_points (dedupe) + streets + pois. Fields: `text` (edge_ngram 2–15, icu_folding), `text_exact`, `ward_id`, `popularity` (= n_success decay theo thời gian), `geom`.
- Query: multi_match + function_score: `popularity_log × 2 + proximity(user_geom) × 1.5 + same_ward × 3`.
- **Chống vòng lặp "phổ biến càng phổ biến":** cộng hệ số khám phá (epsilon-greedy) cho địa chỉ mới/chưa có lịch sử phát.
- Session: `session_token` gửi từ client; log `(session, keystrokes[], chosen_id, order_id)`; join với kết quả phát sau → LTR dataset.
- Mục tiêu: p95 < 80 ms, top-3 hit ≥ 85% tuần 8.

## 6. Distance / Route Matrix
- OSRM `osrm-extract/partition/customize` với `vietnam-latest.osm.pbf`, 2 profile: `motorbike.lua` (vào hẻm, cấm cao tốc), `truck.lua`.
- `/matrix` → OSRM `/table`; cache Redis key `mx:{geohash7_a}:{geohash7_b}:{profile}` TTL 7d.
- Precompute nightly: hub↔hub, bưu cục↔bưu cục **tỉnh pilot** (mở rộng toàn quốc khi nhân rộng).
- Fallback khi OSRM timeout: haversine × k_region — **k học từ GPS bưu tá** (quãng đường thực tế / đường chim bay theo ô lưới); khi chưa đủ GPS, dùng tỉ số OSRM/haversine làm proxy.
- Thời tiết/địa hình/giao thông: backlog, ghi rõ lý do "chưa có dữ liệu thời gian thực đáng tin, ROI thấp".

## 7. Hiệu năng
| Endpoint | p95 mục tiêu | Cách đạt |
|---|---|---|
| /autocomplete | < 80 ms | OpenSearch 1 shard/tỉnh, Redis prefix cache 60s |
| /geocode (miss) | < 150 ms | Index trigram + gist, parser pure python đã compile regex |
| /geocode (hit) | < 10 ms | Redis |
| /matrix 100×100 | < 2 s | OSRM MLD, cache pair |
Load test: k6 script trong `tests/load/`, chạy CI hàng đêm, fail nếu vượt p95 20%.

## 8. Bảo mật & dữ liệu cá nhân
- API key per hệ thống gọi (OMS, TMS, App), rate limit per key, IP allowlist nội bộ.
- Mọi request có request_id, log order_id để truy ngược. Không log SĐT/tên.
- Địa chỉ + SĐT = dữ liệu cá nhân → không gửi raw ra LLM public. Batch parse: self-host, hoặc mask house_no + strip tên/SĐT trước khi gọi API ngoài.
- `delivery_points` chỉ lưu `addr_norm` (không tên/SĐT); nếu cần tách PII nghiêm ngặt hơn, hash bằng **HMAC-SHA256 có khoá** — md5 chỉ để dedup/index, không dùng để bảo vệ PII.
- Secrets qua .env + Vault/SOPS; DB không expose ra ngoài docker network.
- Backup PostGIS hàng ngày pg_dump + giữ 14 bản.

## 9. Observability
Prometheus metrics: `geocode_requests_total{level,source}`, `geocode_latency_seconds`, `cache_hit_ratio`, `external_calls_total` (= tiền), `autocomplete_top3_hit`. Grafana dashboard 1 trang: accuracy hôm nay / cost tiết kiệm / phân bố confidence / tỉnh tụt.

## 10. Repo layout (monorepo, agent dễ làm việc)
```
vtp-maps/
  docs/ adr/ rules/{abbrev,grammar}.yaml
  api/ (fastapi)  parser/  resolver/  search/  routing/
  pipeline/ (ingest, nightly, eval)
  tests/ {unit,golden,load}
  infra/ docker-compose.yml  grafana/  prometheus/
  CLAUDE.md  (hoặc .cursorrules) — quy tắc cho agent
```

> Vận hành AI agent 24/7 (tools, prompt, guardrail): xem **Detail07_agent_ops.md**.
