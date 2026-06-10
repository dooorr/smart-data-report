"""pytest  fixtures：隔离 uploads / data_store，避免污染开发数据。"""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


@pytest.fixture
def app_module(tmp_path, monkeypatch):
    import app as app_module

    data_dir = tmp_path / "data"
    upload_dir = tmp_path / "uploads"
    data_dir.mkdir(parents=True, exist_ok=True)
    upload_dir.mkdir(parents=True, exist_ok=True)
    store_file = data_dir / "data_store.json"
    users_db = tmp_path / "users.db"

    monkeypatch.setattr(app_module, "DATA_STORE_DIR", str(data_dir))
    monkeypatch.setattr(app_module, "DATA_STORE_FILE", str(store_file))
    monkeypatch.setattr(app_module, "DB_PATH", str(users_db))
    app_module.init_user_db()
    app_module.app.config["UPLOAD_FOLDER"] = str(upload_dir)
    app_module.app.config["TESTING"] = True

    app_module.GLOBAL_DATA.clear()
    app_module.dashboard_state["charts"] = []
    if store_file.exists():
        store_file.unlink()

    yield app_module

    app_module.GLOBAL_DATA.clear()
    app_module.dashboard_state["charts"] = []


@pytest.fixture
def client(app_module):
    return app_module.app.test_client()


def load_demo(client, n_rows=50, seed=42):
    """辅助：载入内置演示数据。"""
    return client.post(
        "/api/generate-demo-dataset",
        json={"n_rows": n_rows, "seed": seed, "include_lookup": True},
    )


def login_test_user(client, username="pytest_user", password="pytest1"):
    """注册并登录测试用户（需已配置 TESTING）。"""
    client.post(
        "/api/register",
        json={"username": username, "password": password},
    )
    return client.post(
        "/api/login",
        json={"username": username, "password": password},
    )
