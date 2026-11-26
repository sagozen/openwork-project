"""Cấu hình đọc từ biến môi trường tiền tố BDS_."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="BDS_")

    pg_dsn: str = "postgresql://postgres:bds@127.0.0.1:55433/bds"
    valhalla_url: str = "http://127.0.0.1:8002"
    valhalla_timeout_s: float = 5.0
    osrm_url: str = "http://127.0.0.1:5005"
    osrm_timeout_s: float = 5.0
    osm_pbf: str = "data/osm/vietnam-latest.osm.pbf"
    # Key theo hệ thống gọi: "oms:AIza...,app:AIza...". Để trống thì không kiểm tra key (chỉ dùng cho dev).
    api_keys: str = ""
    rate_limit_rps: float = 100.0   # mỗi hệ thống gọi; 0 = không giới hạn
    # Phương tiện dùng khi client gửi mode=driving (mặc định giống Google: ô tô).
    google_driving_vehicle: str = "car"
    cors_origins: str = "*"
    # LLM tự host (Ollama, vLLM...) cho vòng tự học ngoài luồng; để trống thì bỏ qua bước LLM.
    llm_url: str = ""
    llm_model: str = ""
    llm_timeout_s: float = 60.0
    models_dir: str = "data/models"


@lru_cache
def settings() -> Settings:
    return Settings()
