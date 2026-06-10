"""快照 API 集成测试"""

from conftest import load_demo, login_test_user

from utils import session_versions


class TestSnapshotApi:
    def test_list_empty(self, client, app_module, tmp_path):
        login_test_user(client)
        app_module.USER_DATA_DIR = str(tmp_path / "users")
        resp = client.get("/api/snapshots")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["status"] == "success"
        assert data["snapshots"] == []

    def test_auto_snapshot_after_demo(self, client, app_module, tmp_path):
        login_test_user(client)
        app_module.USER_DATA_DIR = str(tmp_path / "users")

        load_demo(client, n_rows=25)
        resp = client.get("/api/snapshots")
        items = resp.get_json()["snapshots"]
        assert len(items) >= 1
        assert items[0]["row_count"] == 25

    def test_manual_create_and_restore(self, client, app_module, tmp_path):
        login_test_user(client)
        user_dir = str(tmp_path / "users")
        app_module.USER_DATA_DIR = user_dir

        load_demo(client, n_rows=15)
        snap_resp = client.post("/api/snapshots", json={"label": "手动备份"})
        assert snap_resp.get_json()["status"] == "success"
        snap_id = snap_resp.get_json()["snapshot"]["id"]

        load_demo(client, n_rows=40)
        restore_resp = client.post(f"/api/snapshots/{snap_id}/restore")
        data = restore_resp.get_json()
        assert data["status"] == "success"
        assert data["has_data"] is True

        items = session_versions.list_snapshots(1, user_dir)
        assert any(x.get("reason") == "pre_restore" for x in items)
