"""session_versions 单元测试"""

import json

import pytest

from utils.session_versions import (
    MAX_SNAPSHOTS,
    create_snapshot,
    delete_snapshot,
    list_snapshots,
    load_snapshot_payload,
)


def _payload(n: int = 3) -> dict:
    return {
        "data": [{"日期": "2024-01-01", "销售额": i} for i in range(n)],
        "filename": "demo.xlsx",
        "dashboard_charts": [],
    }


class TestSessionVersions:
    def test_create_and_list(self, tmp_path):
        user_dir = str(tmp_path / "users")
        meta = create_snapshot(1, user_dir, _payload(), label="测试 v1", reason="upload")
        assert meta["label"] == "测试 v1"
        assert meta["row_count"] == 3
        items = list_snapshots(1, user_dir)
        assert len(items) == 1
        assert items[0]["id"] == meta["id"]

    def test_load_snapshot_payload(self, tmp_path):
        user_dir = str(tmp_path / "users")
        meta = create_snapshot(2, user_dir, _payload(5), label="v2")
        loaded = load_snapshot_payload(2, user_dir, meta["id"])
        assert len(loaded["data"]) == 5

    def test_prune_old_snapshots(self, tmp_path):
        user_dir = str(tmp_path / "users")
        ids = []
        for i in range(MAX_SNAPSHOTS + 3):
            meta = create_snapshot(3, user_dir, _payload(1), label=f"s{i}")
            ids.append(meta["id"])
        items = list_snapshots(3, user_dir)
        assert len(items) == MAX_SNAPSHOTS
        assert items[0]["label"] == f"s{MAX_SNAPSHOTS + 2}"
        with pytest.raises(FileNotFoundError):
            load_snapshot_payload(3, user_dir, ids[0])

    def test_delete_snapshot(self, tmp_path):
        user_dir = str(tmp_path / "users")
        meta = create_snapshot(4, user_dir, _payload(), label="del")
        delete_snapshot(4, user_dir, meta["id"])
        assert list_snapshots(4, user_dir) == []
        with pytest.raises(FileNotFoundError):
            load_snapshot_payload(4, user_dir, meta["id"])

    def test_reject_empty_payload(self, tmp_path):
        with pytest.raises(ValueError, match="空数据"):
            create_snapshot(5, str(tmp_path / "users"), {"data": []}, label="empty")
