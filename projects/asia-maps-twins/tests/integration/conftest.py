import httpx
import psycopg
import pytest
from psycopg.rows import dict_row

from bds.config import settings


@pytest.fixture(scope="session")
def conn():
    try:
        c = psycopg.connect(settings().pg_dsn, row_factory=dict_row, autocommit=True, connect_timeout=3)
    except psycopg.OperationalError:
        pytest.skip("PostGIS chưa chạy (make up)")
    if not c.execute("SELECT to_regclass('geo.suggest_entry') t").fetchone()["t"]:
        pytest.skip("chưa nạp dữ liệu (make import)")
    yield c
    c.close()


@pytest.fixture(scope="session")
def valhalla_up():
    try:
        httpx.get(settings().valhalla_url + "/status", timeout=3).raise_for_status()
    except httpx.HTTPError:
        pytest.skip("Valhalla chưa sẵn sàng")
