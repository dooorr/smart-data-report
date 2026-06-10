"""
会话数据版本快照：按用户隔离存储，支持列表、恢复与自动裁剪。

存储路径：data/users/user_{id}/snapshots/
  - manifest.json  元数据列表
  - {snapshot_id}.json  完整会话 payload（与 data_store 结构一致）
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

MAX_SNAPSHOTS = 20
_SNAPSHOT_ID_RE = re.compile(r"^\d{8}_\d{6}_\d+$")


def _snapshots_dir(user_data_dir: str, user_id: int) -> Path:
    root = Path(user_data_dir) / f"user_{user_id}" / "snapshots"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _manifest_path(user_data_dir: str, user_id: int) -> Path:
    return _snapshots_dir(user_data_dir, user_id) / "manifest.json"


def _snapshot_file(user_data_dir: str, user_id: int, snapshot_id: str) -> Path:
    return _snapshots_dir(user_data_dir, user_id) / f"{snapshot_id}.json"


def _load_manifest(user_data_dir: str, user_id: int) -> List[Dict[str, Any]]:
    path = _manifest_path(user_data_dir, user_id)
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        items = data.get("snapshots") if isinstance(data, dict) else None
        return list(items) if isinstance(items, list) else []
    except Exception:
        return []


def _save_manifest(user_data_dir: str, user_id: int, items: List[Dict[str, Any]]) -> None:
    path = _manifest_path(user_data_dir, user_id)
    path.write_text(
        json.dumps({"snapshots": items}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _meta_from_payload(payload: Dict[str, Any], label: str, reason: str, snapshot_id: str) -> Dict[str, Any]:
    rows = payload.get("data") or []
    return {
        "id": snapshot_id,
        "label": label,
        "reason": reason,
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "filename": payload.get("filename"),
        "row_count": len(rows) if isinstance(rows, list) else 0,
        "has_lookup": bool(payload.get("lookup_data")),
        "chart_count": len(payload.get("dashboard_charts") or []),
    }


def create_snapshot(
    user_id: int,
    user_data_dir: str,
    payload: Dict[str, Any],
    *,
    label: str = "",
    reason: str = "manual",
) -> Dict[str, Any]:
    """写入快照并更新 manifest，超出上限时删除最旧条目。"""
    if not payload.get("data"):
        raise ValueError("空数据无法创建快照")

    snapshot_id = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    meta = _meta_from_payload(
        payload,
        label.strip() or f"快照 {snapshot_id.replace('_', ' ')}",
        reason,
        snapshot_id,
    )

    snap_path = _snapshot_file(user_data_dir, user_id, snapshot_id)
    snap_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False),
        encoding="utf-8",
    )

    items = _load_manifest(user_data_dir, user_id)
    items.insert(0, meta)
    if len(items) > MAX_SNAPSHOTS:
        for old in items[MAX_SNAPSHOTS:]:
            old_id = old.get("id")
            if isinstance(old_id, str) and _SNAPSHOT_ID_RE.match(old_id):
                old_path = _snapshot_file(user_data_dir, user_id, old_id)
                if old_path.is_file():
                    old_path.unlink(missing_ok=True)
        items = items[:MAX_SNAPSHOTS]

    _save_manifest(user_data_dir, user_id, items)
    return meta


def list_snapshots(user_id: int, user_data_dir: str) -> List[Dict[str, Any]]:
    return _load_manifest(user_data_dir, user_id)


def load_snapshot_payload(user_id: int, user_data_dir: str, snapshot_id: str) -> Dict[str, Any]:
    if not _SNAPSHOT_ID_RE.match(snapshot_id or ""):
        raise ValueError("无效的快照 ID")
    path = _snapshot_file(user_data_dir, user_id, snapshot_id)
    if not path.is_file():
        raise FileNotFoundError("快照不存在")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("快照文件损坏")
    return data


def delete_snapshot(user_id: int, user_data_dir: str, snapshot_id: str) -> bool:
    if not _SNAPSHOT_ID_RE.match(snapshot_id or ""):
        raise ValueError("无效的快照 ID")
    path = _snapshot_file(user_data_dir, user_id, snapshot_id)
    if path.is_file():
        path.unlink()
    items = [x for x in _load_manifest(user_data_dir, user_id) if x.get("id") != snapshot_id]
    _save_manifest(user_data_dir, user_id, items)
    return True
