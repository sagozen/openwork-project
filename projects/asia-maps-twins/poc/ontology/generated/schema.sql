-- SINH TỰ ĐỘNG từ ontology/bds.yaml bởi generator/gen_postgres.py. Không sửa tay.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE SCHEMA IF NOT EXISTS bds;

-- Registry thực thể: ID ổn định qua mọi phiên bản và mọi nguồn.
CREATE TABLE bds.entity (
  entity_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,
  tenant_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Bridge: mã của từng nguồn (mã nội bộ, OSM id, GERS id...) trỏ về một thực thể.
CREATE TABLE bds.source_ref (
  entity_id uuid NOT NULL REFERENCES bds.entity(entity_id),
  source_system text NOT NULL,
  source_key text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_system, source_key)
);
CREATE INDEX ON bds.source_ref (entity_id);

-- Nhật ký mọi action đã chạy.
CREATE TABLE bds.action_log (
  action_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type text NOT NULL,
  actor text NOT NULL,
  params jsonb NOT NULL,
  affected jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bds.admin_unit (
  version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES bds.entity(entity_id),
  valid_from date NOT NULL,
  valid_to date,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  code text NOT NULL,
  level bigint NOT NULL,
  parent uuid REFERENCES bds.entity(entity_id),
  name text NOT NULL,
  boundary geometry(MultiPolygon,4326),
  source text NOT NULL,
  confidence double precision,
  tenant_id text NOT NULL,
  data_class text NOT NULL,
  license text,
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  EXCLUDE USING gist (entity_id WITH =, daterange(valid_from, valid_to) WITH &&),
  CHECK (level >= 1),
  CHECK (level <= 2),
  CHECK (confidence >= 0),
  CHECK (confidence <= 1),
  CHECK (data_class IN ('public', 'internal', 'personal'))
);
COMMENT ON TABLE bds.admin_unit IS 'Đơn vị hành chính (mô hình 2 cấp).';
CREATE INDEX ON bds.admin_unit USING gist (boundary);
CREATE INDEX ON bds.admin_unit (parent);
CREATE INDEX ON bds.admin_unit (entity_id);
CREATE VIEW bds.admin_unit_current AS SELECT * FROM bds.admin_unit WHERE valid_to IS NULL;
CREATE FUNCTION bds.admin_unit_at(d date) RETURNS SETOF bds.admin_unit LANGUAGE sql STABLE AS $$ SELECT * FROM bds.admin_unit WHERE valid_from <= d AND (valid_to IS NULL OR valid_to > d) $$;

CREATE TABLE bds.organization (
  version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES bds.entity(entity_id),
  valid_from date NOT NULL,
  valid_to date,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  name text NOT NULL,
  org_type text NOT NULL,
  source text NOT NULL,
  confidence double precision,
  tenant_id text NOT NULL,
  data_class text NOT NULL,
  license text,
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  EXCLUDE USING gist (entity_id WITH =, daterange(valid_from, valid_to) WITH &&),
  CHECK (org_type IN ('carrier', 'government', 'community')),
  CHECK (confidence >= 0),
  CHECK (confidence <= 1),
  CHECK (data_class IN ('public', 'internal', 'personal'))
);
COMMENT ON TABLE bds.organization IS 'Tổ chức vận hành hoặc sở hữu điểm mạng lưới (hãng, cơ quan, cộng đồng).';
CREATE INDEX ON bds.organization (entity_id);
CREATE VIEW bds.organization_current AS SELECT * FROM bds.organization WHERE valid_to IS NULL;
CREATE FUNCTION bds.organization_at(d date) RETURNS SETOF bds.organization LANGUAGE sql STABLE AS $$ SELECT * FROM bds.organization WHERE valid_from <= d AND (valid_to IS NULL OR valid_to > d) $$;

CREATE TABLE bds.facility (
  version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES bds.entity(entity_id),
  valid_from date NOT NULL,
  valid_to date,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  facility_type text NOT NULL,
  in_admin_unit uuid NOT NULL REFERENCES bds.entity(entity_id),
  code text NOT NULL,
  name text NOT NULL,
  location geometry(Point,4326),
  operated_by uuid NOT NULL REFERENCES bds.entity(entity_id),
  source text NOT NULL,
  confidence double precision,
  tenant_id text NOT NULL,
  data_class text NOT NULL,
  license text,
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  EXCLUDE USING gist (entity_id WITH =, daterange(valid_from, valid_to) WITH &&),
  CHECK (facility_type IN ('post_office', 'agent', 'hub', 'warehouse', 'pickup_point', 'locker')),
  CHECK (confidence >= 0),
  CHECK (confidence <= 1),
  CHECK (data_class IN ('public', 'internal', 'personal'))
);
COMMENT ON TABLE bds.facility IS 'Bưu cục, đại lý, hub, kho, điểm gửi nhận, tủ khoá.';
CREATE INDEX ON bds.facility USING gist (location);
CREATE INDEX ON bds.facility (in_admin_unit);
CREATE INDEX ON bds.facility (operated_by);
CREATE INDEX ON bds.facility (entity_id);
CREATE VIEW bds.facility_current AS SELECT * FROM bds.facility WHERE valid_to IS NULL;
CREATE FUNCTION bds.facility_at(d date) RETURNS SETOF bds.facility LANGUAGE sql STABLE AS $$ SELECT * FROM bds.facility WHERE valid_from <= d AND (valid_to IS NULL OR valid_to > d) $$;

CREATE TABLE bds.service_zone (
  version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES bds.entity(entity_id),
  valid_from date NOT NULL,
  valid_to date,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  served_by uuid NOT NULL REFERENCES bds.entity(entity_id),
  name text NOT NULL,
  boundary geometry(MultiPolygon,4326),
  source text NOT NULL,
  confidence double precision,
  tenant_id text NOT NULL,
  data_class text NOT NULL,
  license text,
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  EXCLUDE USING gist (entity_id WITH =, daterange(valid_from, valid_to) WITH &&),
  CHECK (confidence >= 0),
  CHECK (confidence <= 1),
  CHECK (data_class IN ('public', 'internal', 'personal'))
);
COMMENT ON TABLE bds.service_zone IS 'Vùng phục vụ của một điểm mạng lưới.';
CREATE INDEX ON bds.service_zone USING gist (boundary);
CREATE INDEX ON bds.service_zone (served_by);
CREATE INDEX ON bds.service_zone (entity_id);
CREATE VIEW bds.service_zone_current AS SELECT * FROM bds.service_zone WHERE valid_to IS NULL;
CREATE FUNCTION bds.service_zone_at(d date) RETURNS SETOF bds.service_zone LANGUAGE sql STABLE AS $$ SELECT * FROM bds.service_zone WHERE valid_from <= d AND (valid_to IS NULL OR valid_to > d) $$;

CREATE TABLE bds.facility_link (
  version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES bds.entity(entity_id),
  valid_from date NOT NULL,
  valid_to date,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  from_facility uuid NOT NULL REFERENCES bds.entity(entity_id),
  to_facility uuid NOT NULL REFERENCES bds.entity(entity_id),
  link_type text NOT NULL,
  source text NOT NULL,
  confidence double precision,
  tenant_id text NOT NULL,
  data_class text NOT NULL,
  license text,
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  EXCLUDE USING gist (entity_id WITH =, daterange(valid_from, valid_to) WITH &&),
  CHECK (link_type IN ('linehaul_to')),
  CHECK (confidence >= 0),
  CHECK (confidence <= 1),
  CHECK (data_class IN ('public', 'internal', 'personal'))
);
COMMENT ON TABLE bds.facility_link IS 'Liên kết giữa hai điểm mạng lưới (ví dụ tuyến trung chuyển).';
CREATE INDEX ON bds.facility_link (from_facility);
CREATE INDEX ON bds.facility_link (to_facility);
CREATE INDEX ON bds.facility_link (entity_id);
CREATE VIEW bds.facility_link_current AS SELECT * FROM bds.facility_link WHERE valid_to IS NULL;
CREATE FUNCTION bds.facility_link_at(d date) RETURNS SETOF bds.facility_link LANGUAGE sql STABLE AS $$ SELECT * FROM bds.facility_link WHERE valid_from <= d AND (valid_to IS NULL OR valid_to > d) $$;

CREATE TABLE bds.shipment_event (
  event_id uuid NOT NULL DEFAULT gen_random_uuid(),
  shipment_ref text NOT NULL,
  event_type text NOT NULL,
  facility uuid NOT NULL REFERENCES bds.entity(entity_id),
  ts timestamptz NOT NULL,
  reason_code text,
  source text NOT NULL,
  tenant_id text NOT NULL,
  data_class text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (event_type IN ('accepted', 'arrived', 'sorted', 'departed', 'out_for_delivery', 'delivered', 'failed', 'returned')),
  CHECK (data_class IN ('public', 'internal', 'personal')),
  PRIMARY KEY (event_id, ts)
) PARTITION BY RANGE (ts);
COMMENT ON TABLE bds.shipment_event IS 'Sự kiện vận hành của một đơn, theo khung GS1 EPCIS rút gọn.';
CREATE INDEX ON bds.shipment_event (facility);
CREATE FUNCTION bds.ensure_shipment_event_partition(d date) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE part text := format('shipment_event_%s', to_char(d, 'YYYYMMDD'));
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS bds.%I PARTITION OF bds.shipment_event FOR VALUES FROM (%L) TO (%L)',
    part, d::timestamptz, (d + 1)::timestamptz);
END $$;
COMMENT ON FUNCTION bds.ensure_shipment_event_partition(date) IS 'Tạo phân vùng ngày cho cột ts.';

CREATE TABLE bds.observation (
  observation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  subject uuid NOT NULL REFERENCES bds.entity(entity_id),
  variable text NOT NULL,
  obs_date date NOT NULL,
  value double precision NOT NULL,
  unit text,
  source text NOT NULL,
  tenant_id text NOT NULL,
  data_class text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (data_class IN ('public', 'internal', 'personal')),
  PRIMARY KEY (observation_id)
);
COMMENT ON TABLE bds.observation IS 'Một giá trị đo của một biến trên một thực thể vào một ngày (kiểu Data Commons).';
CREATE INDEX ON bds.observation (subject);
