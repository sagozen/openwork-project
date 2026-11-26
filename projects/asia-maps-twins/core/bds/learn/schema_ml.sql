-- Schema `ml`: nhãn ngoài dữ liệu tổng hợp và sổ đăng ký mô hình (vòng tự học, ADR-0007).
-- Không dựng lại được từ nguồn: sao lưu cùng `ops`.
CREATE SCHEMA IF NOT EXISTS ml;

-- Nhãn từng từ do LLM hoặc người gán. status: accepted (dùng để huấn luyện) | review (chờ người duyệt) | rejected.
CREATE TABLE IF NOT EXISTS ml.label (
  id bigserial PRIMARY KEY,
  raw text NOT NULL,
  tokens text[] NOT NULL,
  labels text[] NOT NULL,
  source text NOT NULL,              -- llm | human
  status text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (raw, source)
);

-- Mỗi lần huấn luyện là một phiên bản; chỉ phiên bản qua cổng chất lượng mới được promoted (đưa vào dùng).
CREATE TABLE IF NOT EXISTS ml.model (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,                -- tagger | decision
  version text NOT NULL UNIQUE,
  path text NOT NULL,
  metrics jsonb NOT NULL,
  promoted boolean NOT NULL DEFAULT false,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS model_kind_promoted ON ml.model (kind, created_at DESC) WHERE promoted;
