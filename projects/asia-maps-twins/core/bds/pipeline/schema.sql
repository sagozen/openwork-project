-- Schema `geo`: lớp dữ liệu dẫn xuất từ nguồn mở (vietnamadminunits, OpenStreetMap).
-- Mọi bảng ở đây dựng lại được từ nguồn bằng `make import`; không chứa dữ liệu nghiệp vụ.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE SCHEMA IF NOT EXISTS geo;

-- Đơn vị hành chính 2 cấp (level 1 = tỉnh/thành, level 2 = xã/phường/đặc khu).
CREATE TABLE IF NOT EXISTS geo.admin_unit (
  code text PRIMARY KEY,
  level smallint NOT NULL CHECK (level IN (1, 2)),
  name text NOT NULL,
  name_short text NOT NULL,
  unit_type text,
  name_norm text NOT NULL,
  parent_code text REFERENCES geo.admin_unit(code),
  area_km2 double precision,
  geom geometry(Point, 4326) NOT NULL,
  source text NOT NULL DEFAULT 'vietnamadminunits',
  license text NOT NULL DEFAULT 'MIT'
);
CREATE INDEX IF NOT EXISTS admin_unit_geom ON geo.admin_unit USING gist (geom);
CREATE INDEX IF NOT EXISTS admin_unit_parent ON geo.admin_unit (parent_code);

-- Đoạn đường có tên (OSM highway).
CREATE TABLE IF NOT EXISTS geo.street (
  id bigserial PRIMARY KEY,
  osm_id bigint NOT NULL,
  name text NOT NULL,
  street_key text NOT NULL,
  highway text NOT NULL,
  geom geometry(LineString, 4326) NOT NULL
);

-- Điểm có số nhà (OSM addr:housenumber). holdout = true: để dành đánh giá, resolver không dùng.
CREATE TABLE IF NOT EXISTS geo.address_point (
  id bigserial PRIMARY KEY,
  osm_type char(1) NOT NULL,
  osm_id bigint NOT NULL,
  housenumber text NOT NULL,
  house_num integer,
  street text,
  street_key text,
  addr jsonb NOT NULL DEFAULT '{}',
  holdout boolean NOT NULL,
  geom geometry(Point, 4326) NOT NULL
);

-- Địa danh có tên: thôn/xóm/khu, POI, toà nhà, khu công nghiệp...
CREATE TABLE IF NOT EXISTS geo.place (
  id bigserial PRIMARY KEY,
  osm_type char(1) NOT NULL,
  osm_id bigint NOT NULL,
  kind text NOT NULL,
  name text NOT NULL,
  name_norm text NOT NULL,
  geom geometry(Point, 4326) NOT NULL
);
