"""Smart Data Report 核心 API 自动化测试（pytest + Flask test_client）。"""
import io

from conftest import load_demo


class TestHealthAndSession:
    def test_index_returns_html(self, client):
        resp = client.get("/")
        assert resp.status_code == 200
        assert b"html" in resp.data.lower()

    def test_session_restore_empty(self, client):
        resp = client.get("/api/session-restore")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["status"] == "success"
        assert data["has_data"] is False

    def test_get_dashboard_empty(self, client):
        resp = client.get("/get-dashboard")
        assert resp.status_code == 200
        assert resp.get_json()["charts"] == []


class TestUploadValidation:
    def test_upload_missing_file(self, client):
        resp = client.post("/upload")
        assert resp.status_code == 200
        assert resp.get_json()["status"] == "error"
        assert "文件" in resp.get_json()["msg"]

    def test_upload_empty_filename(self, client):
        resp = client.post(
            "/upload",
            data={"file": (io.BytesIO(b"a,b\n1,2"), "")},
            content_type="multipart/form-data",
        )
        assert resp.get_json()["status"] == "error"
        assert "文件名" in resp.get_json()["msg"]

    def test_upload_unsupported_extension(self, client):
        resp = client.post(
            "/upload",
            data={"file": (io.BytesIO(b"not excel"), "bad.txt")},
            content_type="multipart/form-data",
        )
        assert resp.get_json()["status"] == "error"
        assert "xlsx" in resp.get_json()["msg"].lower() or "格式" in resp.get_json()["msg"]


class TestDemoDataset:
    def test_generate_demo_success(self, client):
        resp = load_demo(client, n_rows=50)
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["status"] == "success"
        assert "all_columns" in data
        assert data.get("lookup_all_columns")

    def test_generate_demo_clamps_small_n_rows(self, client):
        resp = client.post(
            "/api/generate-demo-dataset",
            json={"n_rows": 3, "seed": 1},
        )
        assert resp.get_json()["status"] == "success"
        assert "10" in resp.get_json()["msg"] or "测试" in resp.get_json()["msg"]

    def test_generate_demo_invalid_params(self, client):
        resp = client.post(
            "/api/generate-demo-dataset",
            json={"n_rows": "abc", "seed": 1},
        )
        assert resp.status_code == 400
        assert resp.get_json()["status"] == "error"

    def test_session_restore_after_demo(self, client):
        load_demo(client)
        resp = client.get("/api/session-restore")
        data = resp.get_json()
        assert data["has_data"] is True
        assert data["data_source"] == "demo_generated"
        assert len(data["all_columns"]) > 0


class TestDataQuality:
    def test_detect_anomalies_without_data(self, client):
        resp = client.post("/api/detect-anomalies", json={})
        assert resp.status_code == 400
        assert resp.get_json()["status"] == "error"

    def test_detect_anomalies_with_demo_data(self, client):
        load_demo(client)
        resp = client.post("/api/detect-anomalies", json={})
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["status"] == "success"
        assert "report" in data
        assert "total_anomalies" in data["report"]


class TestSessionLifecycle:
    def test_clear_session(self, client, app_module):
        load_demo(client)
        assert "data" in app_module.GLOBAL_DATA

        resp = client.post("/api/clear-session")
        assert resp.status_code == 200
        assert resp.get_json()["status"] == "success"
        assert "data" not in app_module.GLOBAL_DATA

        restore = client.get("/api/session-restore")
        assert restore.get_json()["has_data"] is False

    def test_reset_dashboard_keeps_data(self, client, app_module):
        load_demo(client)
        app_module.dashboard_state["charts"] = [{"id": "c1", "type": "bar"}]

        resp = client.post("/reset-dashboard")
        assert resp.get_json()["status"] == "success"
        assert app_module.dashboard_state["charts"] == []
        assert "data" in app_module.GLOBAL_DATA


class TestTemplatesAndExport:
    def test_list_templates(self, client):
        resp = client.get("/api/templates")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["status"] == "success"
        assert isinstance(data["templates"], list)
        assert len(data["templates"]) >= 1

    def test_export_csv_requires_data(self, client):
        resp = client.get("/api/export?format=csv")
        assert resp.status_code == 400
        assert resp.get_json()["status"] == "error"

    def test_export_csv_with_data(self, client):
        load_demo(client, n_rows=20)
        resp = client.get("/api/export?format=csv")
        assert resp.status_code == 200
        assert "text/csv" in resp.content_type or resp.data
