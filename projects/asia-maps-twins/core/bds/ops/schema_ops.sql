-- Schema `ops`: dữ liệu vận hành của base (log yêu cầu, so sánh shadow).
-- KHÁC schema `geo`: đây không phải dữ liệu dẫn xuất, không dựng lại được, phải sao lưu (make backup).
-- Không lưu tên, số điện thoại khách; số điện thoại lẫn trong chuỗi địa chỉ được che trước khi ghi.
-- Giữ 180 ngày (make ops-retention).
CREATE SCHEMA IF NOT EXISTS ops;

-- Mỗi lần phân giải địa chỉ. order_id dùng để đối chiếu với GPS phát thành công sau này.
CREATE TABLE IF NOT EXISTS ops.geocode_log (
  request_id uuid PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  client text NOT NULL,
  api text NOT NULL,                 -- v1 | google
  order_id text,
  query text NOT NULL,
  lat double precision,
  lon double precision,
  level text NOT NULL,
  confidence real NOT NULL,
  source text,
  admin_source text,
  ward_code text,
  province_code text,
  latency_ms real NOT NULL
);
CREATE INDEX IF NOT EXISTS geocode_log_ts ON ops.geocode_log USING brin (ts);
CREATE INDEX IF NOT EXISTS geocode_log_order ON ops.geocode_log (order_id) WHERE order_id IS NOT NULL;

-- Mỗi lần gợi ý: danh sách place_id đã trả theo thứ tự, để tính tỉ lệ chọn trong top-3.
CREATE TABLE IF NOT EXISTS ops.suggest_log (
  request_id uuid PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  client text NOT NULL,
  api text NOT NULL,
  session_token text,
  query text NOT NULL,
  place_ids text[] NOT NULL,
  latency_ms real NOT NULL
);
CREATE INDEX IF NOT EXISTS suggest_log_ts ON ops.suggest_log USING brin (ts);
CREATE INDEX IF NOT EXISTS suggest_log_session ON ops.suggest_log (session_token) WHERE session_token IS NOT NULL;

-- Mục người dùng chọn (gọi Place Details trong cùng phiên gợi ý).
CREATE TABLE IF NOT EXISTS ops.place_select_log (
  request_id uuid PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  client text NOT NULL,
  session_token text,
  place_id text NOT NULL
);
CREATE INDEX IF NOT EXISTS place_select_session ON ops.place_select_log (session_token) WHERE session_token IS NOT NULL;

-- Mỗi lần tính tuyến đường / ma trận.
CREATE TABLE IF NOT EXISTS ops.route_log (
  request_id uuid PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  client text NOT NULL,
  api text NOT NULL,
  kind text NOT NULL,                -- route | matrix
  vehicle text NOT NULL,
  n_sources integer NOT NULL,
  n_targets integer NOT NULL,
  fallback_cells integer NOT NULL,
  latency_ms real NOT NULL
);
CREATE INDEX IF NOT EXISTS route_log_ts ON ops.route_log USING brin (ts);

-- So sánh shadow với một nguồn tham chiếu (vd. Google): CHỈ lưu khoảng cách, không lưu toạ độ của nguồn
-- tham chiếu (điều khoản Google cấm lưu kết quả quá 30 ngày và cấm dựng CSDL từ kết quả của họ).
CREATE TABLE IF NOT EXISTS ops.shadow_compare (
  request_id uuid PRIMARY KEY,      -- trùng request_id của ops.geocode_log
  ts timestamptz NOT NULL DEFAULT now(),
  client text NOT NULL,
  reference text NOT NULL,           -- google | goong | ...
  reference_location_type text,
  distance_m real NOT NULL
);
