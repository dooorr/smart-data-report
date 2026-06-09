from flask import Flask, render_template, request, jsonify, session, send_file, redirect, url_for
from flask_cors import CORS
from flask_login import LoginManager, UserMixin, login_user, logout_user, login_required, current_user
from werkzeug.exceptions import HTTPException
from werkzeug.security import generate_password_hash, check_password_hash
import sqlite3
import io
import json
import numpy as np
import pandas as pd
import os
import traceback
from utils.data_process import allowed_file, read_excel_or_csv, handle_null_values, get_numeric_columns, get_all_columns
from utils.chart_utils import (
    aggregate_for_chart,
    aggregation_has_high_spike,
    compute_bi_dashboard_metrics,
    infer_bi_metrics_columns,
    generate_balance_sheet,
    generate_chart,
    generate_insight,
    generate_raw_data_table,
)
from utils.session_export import (
    build_export_dataframe,
    dataframe_to_csv_bytes,
    dataframe_to_excel_bytes,
    dataframe_to_pdf_bytes,
    sanitize_export_basename,
)
from utils.smart_table import (
    apply_category_dimension_filter,
    apply_currency_only,
    apply_date_feature_filter,
    compute_visible_leaves,
    ensure_datetime_date_column,
    list_report_templates,
    load_template,
    render_smart_table_html,
)
from utils.anomaly_detector import detect_anomalies
from utils.pressure_mock import build_lookup_dataframe, build_main_dataframe
import random
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

import copy

app = Flask(__name__)
CORS(app)
REPORT_TEMPLATES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "report_templates")
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "dev-secret-key-change-me")
app.config["UPLOAD_FOLDER"] = "uploads"
os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)

# ---------- User Auth Setup (Flask-Login + SQLite) ----------
login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = "login_page"

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "users.db")

def init_user_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    conn.commit()
    conn.close()

init_user_db()

class User(UserMixin):
    def __init__(self, id, username):
        self.id = id
        self.username = username

    @staticmethod
    def get(user_id):
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("SELECT id, username FROM users WHERE id=?", (user_id,))
        row = c.fetchone()
        conn.close()
        if row:
            return User(row[0], row[1])
        return None

    @staticmethod
    def find_by_username(username):
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("SELECT id, username FROM users WHERE username=?", (username,))
        row = c.fetchone()
        conn.close()
        if row:
            return User(row[0], row[1])
        return None

@login_manager.user_loader
def load_user(user_id):
    return User.get(user_id)


def json_error(msg, code=500):
    """统一错误 JSON，与各路由中的 status/msg 约定一致。"""
    resp = jsonify({"status": "error", "msg": msg})
    resp.status_code = code
    return resp


@app.errorhandler(HTTPException)
def handle_http_exception(exc):
    msg = exc.description if exc.description else str(exc)
    return json_error(msg, exc.code)


@app.errorhandler(Exception)
def handle_unexpected_exception(exc):
    traceback.print_exc()
    detail = str(exc) if app.debug else "服务器内部错误，请稍后重试"
    return json_error(detail, 500)


current_theme = "light"

dashboard_state = {
    "charts": []
}

# 主表 / 参考表等大体积数据仅存服务端内存，避免写入浏览器 Cookie Session 超限
GLOBAL_DATA = {}


def get_session_dataframe_full():
    """主表全量列（含已标记隐藏但仍保留在存储中的列），不做可见性裁剪。"""
    if "data" not in GLOBAL_DATA:
        return None
    df = pd.DataFrame(GLOBAL_DATA["data"])
    if df.empty:
        return df
    return ensure_datetime_date_column(df)


def mapped_columns_meta_from_df(df: Optional[pd.DataFrame]) -> List[Dict[str, Any]]:
    """与前端列映射列表一致：顺序 + 默认全部显示。"""
    if df is None or df.empty:
        return []
    return [{"name": str(c), "visible": True} for c in df.columns]


def normalize_mapped_columns_meta(df: pd.DataFrame, mapped_columns: List[Any]) -> List[Dict[str, Any]]:
    """
    合并用户拖拽顺序与开关，产出覆盖 df 全部列的 mapped_columns（含 visible:false）。
    未出现在用户列表中的列按其在 df 中的顺序追加，默认 visible=True。
    """
    if df is None or df.empty:
        return []
    if not mapped_columns:
        return mapped_columns_meta_from_df(df)

    seen: set = set()
    out: List[Dict[str, Any]] = []
    for item in mapped_columns:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        if name is None or name not in df.columns or name in seen:
            continue
        seen.add(name)
        out.append({"name": str(name), "visible": bool(item.get("visible", True))})

    for c in df.columns:
        if c not in seen:
            out.append({"name": str(c), "visible": True})
    return out


def dataframe_visible_subset(df: Optional[pd.DataFrame], layout: Optional[List]) -> Optional[pd.DataFrame]:
    """按 mapped_columns 仅保留 visible 列，列顺序与布局中可见项一致。"""
    if df is None:
        return None
    if df.empty:
        return df.copy()
    if not layout:
        return df.copy()

    visible_ordered: List[str] = []
    seen: set = set()
    for item in layout:
        if not isinstance(item, dict):
            continue
        n = item.get("name")
        if n is None or n not in df.columns or n in seen:
            continue
        seen.add(n)
        if item.get("visible", True):
            visible_ordered.append(str(n))

    for c in df.columns:
        if c not in seen:
            visible_ordered.append(str(c))

    if not visible_ordered:
        return df.iloc[0:0].copy()
    return df[visible_ordered].copy()


def get_session_dataframe():
    """从 GLOBAL_DATA 构建 DataFrame；按 mapped_columns 裁剪隐藏列（存储仍保留全量列）。"""
    df = get_session_dataframe_full()
    if df is None:
        return None
    layout = GLOBAL_DATA.get("mapped_columns")
    return dataframe_visible_subset(df, layout)


def sync_global_column_mapping(df: Optional[pd.DataFrame]):
    """
    将推断的日期 / 指标 / 维度列写入 GLOBAL_DATA，供仪表盘与智能表格洞察统一使用
    （后续可改为用户手动映射覆盖）。
    """
    if df is None or df.empty:
        GLOBAL_DATA.pop("mapped_date_col", None)
        GLOBAL_DATA.pop("mapped_value_col", None)
        GLOBAL_DATA.pop("mapped_dim_col", None)
        GLOBAL_DATA.pop("mapped_columns", None)
        return
    m = infer_bi_metrics_columns(df)
    GLOBAL_DATA["mapped_date_col"] = m["date_col"]
    GLOBAL_DATA["mapped_value_col"] = m["sales_col"]
    GLOBAL_DATA["mapped_dim_col"] = m["region_col"]


# ---------- GLOBAL_DATA 持久化（data/data_store.json）----------
_PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_STORE_DIR = os.path.join(_PROJECT_ROOT, "data")
DATA_STORE_FILE = os.path.join(DATA_STORE_DIR, "data_store.json")

# ---------- Per-User Data Isolation (必须在 DATA_STORE_DIR 之后定义) ----------
USER_DATA_DIR = os.path.join(DATA_STORE_DIR, "users")
os.makedirs(USER_DATA_DIR, exist_ok=True)

def get_current_user_data_file():
    """返回当前登录用户的独立 data_store 文件路径；未登录时返回 None（启动时不加载任何用户数据）。"""
    try:
        if current_user and current_user.is_authenticated:
            return os.path.join(USER_DATA_DIR, f"user_{current_user.id}_store.json")
    except Exception:
        pass
    return None

def _save_user_data_store(user_file: str, payload: dict):
    """保存到指定用户的 JSON 文件。"""
    try:
        os.makedirs(os.path.dirname(user_file), exist_ok=True)
        with open(user_file, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2, allow_nan=False)
    except Exception as e:
        print(f"[ERROR] 保存用户数据失败 {user_file}: {e}")

def _load_user_data_store(user_file: str):
    """从用户文件加载到 GLOBAL_DATA / dashboard_state。"""
    if not os.path.isfile(user_file):
        return
    try:
        with open(user_file, "r", encoding="utf-8") as f:
            stored = json.load(f)
        if not isinstance(stored, dict):
            return
        charts = stored.pop("dashboard_charts", None)
        stored = clean_special_chars(stored)
        GLOBAL_DATA.clear()
        for key in _DATA_STORE_KEYS:
            if key in stored:
                GLOBAL_DATA[key] = stored[key]
        if isinstance(charts, list):
            dashboard_state["charts"] = charts
        else:
            dashboard_state["charts"] = []
        print(f"[INFO] 已加载用户数据: {os.path.basename(user_file)}")
    except Exception as e:
        print(f"[ERROR] 加载用户数据失败: {e}")


# 与 Smart Report 一致：仅持久化这些键，避免混入临时字段
_DATA_STORE_KEYS = (
    "data",
    "filename",
    "filesize",
    "data_source",
    "mapped_columns",
    "mapped_date_col",
    "mapped_value_col",
    "mapped_dim_col",
    "lookup_data",
    "lookup_filename",
)


def clean_special_chars(data):
    """清理数据中的特殊字符（与 Smart Report 同源逻辑）。"""
    if isinstance(data, dict):
        return {clean_special_chars(k): clean_special_chars(v) for k, v in data.items()}
    if isinstance(data, list):
        return [clean_special_chars(item) for item in data]
    if isinstance(data, str):
        import re

        cleaned = "".join(char for char in data if char.isprintable() or char in "\n\t\r")
        cleaned = re.sub(
            r"[^\u4e00-\u9fff\u0020-\u007e\u00a1-\u00ff\u3000-\u303f\uff00-\uffef]",
            "",
            cleaned,
        )
        return cleaned
    return data


def _json_cell_for_store(v):
    """将单元格值转为可 json 序列化形式（含 numpy、pandas 时间）。"""
    if v is None:
        return None
    if isinstance(v, (pd.Timestamp, datetime)):
        try:
            return v.isoformat(sep=" ")
        except TypeError:
            return v.isoformat()
    if hasattr(v, "isoformat") and callable(getattr(v, "isoformat")) and not isinstance(v, (str, bytes)):
        try:
            return v.isoformat()
        except Exception:
            pass
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating,)):
        x = float(v)
        return None if pd.isna(x) or np.isnan(x) else x
    if isinstance(v, np.bool_):
        return bool(v)
    if isinstance(v, float):
        return None if pd.isna(v) or np.isnan(v) else v
    if isinstance(v, (bytes, bytearray)):
        return bytes(v).decode("utf-8", errors="replace")
    return v


def _rows_for_json_dump(rows):
    if not rows:
        return rows
    out = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        processed = {}
        for k, v in row.items():
            processed[str(k)] = _json_cell_for_store(v)
        out.append(processed)
    return out


def _sanitize_for_json(obj: Any) -> Any:
    """递归去除 NaN/Inf、numpy 标量等，保证 json.dump(allow_nan=False) 可用。"""
    if obj is None:
        return None
    if isinstance(obj, (float, np.floating)):
        x = float(obj)
        if not np.isfinite(x) or pd.isna(x):
            return None
        return x
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, np.bool_):
        return bool(obj)
    if isinstance(obj, (pd.Timestamp, datetime)):
        try:
            return obj.isoformat(sep=" ")
        except TypeError:
            return obj.isoformat()
    if isinstance(obj, dict):
        return {str(k): _sanitize_for_json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_sanitize_for_json(v) for v in obj]
    if isinstance(obj, str):
        return obj
    if isinstance(obj, (bytes, bytearray)):
        return bytes(obj).decode("utf-8", errors="replace")
    return obj


def save_global_data_store():
    """将 GLOBAL_DATA 与仪表盘图表列表写入当前用户的独立 JSON 文件。未登录时跳过保存。"""
    user_file = get_current_user_data_file()
    if not user_file:
        return
    try:
        save_data: Dict[str, Any] = {}
        for key in _DATA_STORE_KEYS:
            if key not in GLOBAL_DATA:
                continue
            value = GLOBAL_DATA[key]
            if key in ("data", "lookup_data") and value is not None:
                save_data[key] = _rows_for_json_dump(value)
            else:
                save_data[key] = copy.deepcopy(value)
        save_data["dashboard_charts"] = copy.deepcopy(dashboard_state.get("charts", []))
        save_data = _sanitize_for_json(save_data)
        save_data = clean_special_chars(save_data)
        _save_user_data_store(user_file, save_data)
        print(f"[INFO] 已保存到用户数据文件: {os.path.basename(user_file)}")
    except Exception as e:
        print(f"[ERROR] 保存用户数据失败: {e}")
        traceback.print_exc()


def load_global_data_store():
    """登录后加载当前用户的独立数据文件。启动时无用户登录则跳过。"""
    user_file = get_current_user_data_file()
    if not user_file or not os.path.isfile(user_file):
        # 启动时或未登录：不清空 GLOBAL_DATA，保持干净状态
        return
    try:
        with open(user_file, "r", encoding="utf-8") as f:
            stored = json.load(f)
        if not isinstance(stored, dict):
            return
        charts = stored.pop("dashboard_charts", None)
        raw_stored = dict(stored)
        stored = clean_special_chars(stored)
        GLOBAL_DATA.clear()
        for key in _DATA_STORE_KEYS:
            if key in stored:
                GLOBAL_DATA[key] = stored[key]
        if isinstance(charts, list):
            dashboard_state["charts"] = charts
        else:
            dashboard_state["charts"] = []
        fn = GLOBAL_DATA.get("filename")
        print(f"[INFO] 已从用户文件恢复: {os.path.basename(user_file)}，文件: {fn!r}")
        rows = GLOBAL_DATA.get("data")
        if rows and isinstance(rows, list) and len(rows) > 0:
            df = pd.DataFrame(rows)
            if not df.empty:
                has_persisted_mapping = all(
                    k in raw_stored for k in ("mapped_date_col", "mapped_value_col", "mapped_dim_col")
                )
                if not has_persisted_mapping:
                    sync_global_column_mapping(df)
    except Exception as e:
        print(f"[ERROR] 加载用户数据失败: {e}")
        traceback.print_exc()


def _resolve_template_json_path(template_id: str):
    """按文件名或模板内 id 解析 report_templates 下的 JSON 路径。"""
    path = os.path.join(REPORT_TEMPLATES_DIR, f"{template_id}.json")
    if os.path.isfile(path):
        return path
    if not os.path.isdir(REPORT_TEMPLATES_DIR):
        return None
    for name in os.listdir(REPORT_TEMPLATES_DIR):
        if not name.endswith(".json"):
            continue
        fp = os.path.join(REPORT_TEMPLATES_DIR, name)
        try:
            t = load_template(fp)
            if t.get("id") == template_id:
                return fp
        except Exception:
            continue
    return None


def _fallback_embedded_rows_for_template(template: dict) -> list:
    """
    模板未提供 embedded_rows 时的标准示例：资产负债表按 column_order；
    其余按销售多级表头所需字段（日期、销售额、地区 等），与 refreshDashboardMetrics 口径一致。
    """
    tid = template.get("id") or ""
    if tid == "balance_multi":
        return [
            {
                "日期": "2026-01-01",
                "流动资产": 1200000,
                "固定资产": 800000,
                "短期借款": 300000,
                "应付账款": 250000,
            },
            {
                "日期": "2026-01-15",
                "流动资产": 1180000,
                "固定资产": 805000,
                "短期借款": 290000,
                "应付账款": 248000,
            },
            {
                "日期": "2026-02-01",
                "流动资产": 1250000,
                "固定资产": 802000,
                "短期借款": 280000,
                "应付账款": 260000,
            },
            {
                "日期": "2026-02-15",
                "流动资产": 1220000,
                "固定资产": 810000,
                "短期借款": 275000,
                "应付账款": 255000,
            },
        ]
    regions = ["华东", "华北", "华南", "西南"]
    products = ["电子产品", "家居用品", "批发", "零售"]
    subjects = ["6001 主营业务收入", "6401 主营业务成本"]
    rows = []
    base = datetime(2026, 1, 1)
    for i in range(12):
        d = (base + timedelta(days=i * 5)).strftime("%Y-%m-%d")
        rows.append(
            {
                "日期": d,
                "地区": regions[i % len(regions)],
                "产品类型": products[i % len(products)],
                "科目": subjects[i % 2],
                "销售额": round(5000 + i * 3200 + (i % 3) * 800, 2),
                "利润": round(400 + i * 220, 2),
                "销量": 20 + i * 6,
                "备注": "示例数据" if i % 2 == 0 else "",
            }
        )
    return rows


def filter_session_dataframe(filter_config):
    """应用日期特征过滤，并可选叠加图表点击的分类维度（与星期/区间 AND）。"""
    df = get_session_dataframe()
    if df is None:
        return None, {}
    raw = filter_config if isinstance(filter_config, dict) else {}
    raw = dict(raw)
    cat = raw.pop("category_dimension", None)
    fc_date = raw if raw else None
    df, meta = apply_date_feature_filter(df, fc_date)
    meta = dict(meta)
    meta["category_dimension"] = None
    if isinstance(cat, dict):
        col = cat.get("column")
        val = cat.get("value")
        df, cat_meta = apply_category_dimension_filter(df, col, val)
        meta["category_dimension"] = cat_meta
    return df, meta


def resolve_insight_x_column(df: pd.DataFrame, x_col: str):
    """与 add-chart 一致：X 为映射的日期列（或「日期」）时用按月字符串列做洞察。"""
    mapped = GLOBAL_DATA.get("mapped_date_col")
    for date_key in (mapped, "日期"):
        if not date_key:
            continue
        if x_col == date_key and df is not None and date_key in df.columns:
            out = df.copy()
            out["_month"] = (
                pd.to_datetime(out[date_key], errors="coerce").dt.to_period("M").astype(str)
            )
            return out, "_month"
    return df, x_col


def _clear_session_and_dashboard():
    """清空 GLOBAL_DATA 中的主表/参考表、会话中的画布布局与服务端仪表盘。"""
    global dashboard_state
    dashboard_state["charts"] = []
    GLOBAL_DATA.clear()
    session.pop("chart_layout", None)
    session.modified = True
    save_global_data_store()


def get_font(size):
    try:
        return ImageFont.truetype("simhei.ttf", size)
    except:
        return ImageFont.load_default()

@app.route('/')
def index():
    if not current_user.is_authenticated:
        return redirect(url_for('login_page'))
    return render_template('index.html')

@app.route('/login', methods=['GET'])
def login_page():
    if os.path.exists(os.path.join('templates', 'login.html')):
        return render_template('login.html')
    # 内联登录页（JS fetch + 成功跳转）
    return '''
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>登录 - Smart Data Report</title>
  <style>body{font-family:sans-serif;margin:40px}input,button{padding:8px;margin:4px}</style>
</head>
<body>
  <h2>登录</h2>
  <form id="loginForm">
    <input name="username" placeholder="用户名" required><br>
    <input type="password" name="password" placeholder="密码" required><br>
    <button type="submit">登录</button>
  </form>
  <p id="msg" style="color:red"></p>
  <p>没有账号？<a href="/register">注册</a></p>

  <script>
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const res = await fetch('/api/login', { method: 'POST', body: fd });
      const data = await res.json();
      if (data.status === 'success') {
        window.location.href = '/';
      } else {
        document.getElementById('msg').textContent = data.msg || '登录失败';
      }
    });
  </script>
</body>
</html>
    '''

@app.route('/register', methods=['GET'])
def register_page():
    return '''
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>注册 - Smart Data Report</title>
  <style>body{font-family:sans-serif;margin:40px}input,button{padding:8px;margin:4px}</style>
</head>
<body>
  <h2>注册</h2>
  <form id="regForm">
    <input name="username" placeholder="用户名" required><br>
    <input type="password" name="password" placeholder="密码（至少6位）" required><br>
    <button type="submit">注册</button>
  </form>
  <p id="msg" style="color:red"></p>
  <p>已有账号？<a href="/login">登录</a></p>

  <script>
    document.getElementById('regForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const res = await fetch('/api/register', { method: 'POST', body: fd });
      const data = await res.json();
      if (data.status === 'success') {
        window.location.href = '/';
      } else {
        document.getElementById('msg').textContent = data.msg || '注册失败';
      }
    });
  </script>
</body>
</html>
    '''

@app.route('/api/register', methods=['POST'])
def api_register():
    username = request.form.get('username') or (request.json or {}).get('username')
    password = request.form.get('password') or (request.json or {}).get('password')
    if not username or not password:
        return jsonify({"status": "error", "msg": "用户名和密码必填"}), 400
    if len(password) < 6:
        return jsonify({"status": "error", "msg": "密码至少6位"}), 400
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    try:
        c.execute("INSERT INTO users (username, password_hash) VALUES (?, ?)",
                  (username, generate_password_hash(password)))
        conn.commit()
        user_id = c.lastrowid
        user = User(user_id, username)
        login_user(user)
        return jsonify({"status": "success", "msg": "注册成功，已自动登录"})
    except sqlite3.IntegrityError:
        return jsonify({"status": "error", "msg": "用户名已存在"}), 400
    finally:
        conn.close()

@app.route('/api/login', methods=['POST'])
def api_login():
    username = request.form.get('username') or (request.json or {}).get('username')
    password = request.form.get('password') or (request.json or {}).get('password')
    user = User.find_by_username(username)
    if user:
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute("SELECT password_hash FROM users WHERE id=?", (user.id,))
        row = c.fetchone()
        conn.close()
        if row and check_password_hash(row[0], password):
            # 先保存当前会话（如果有）
            if GLOBAL_DATA.get("data"):
                save_global_data_store()
            login_user(user)
            # 加载该用户的专属数据
            load_global_data_store()
            return jsonify({"status": "success", "msg": "登录成功", "username": user.username})
    return jsonify({"status": "error", "msg": "用户名或密码错误"}), 401

@app.route('/api/logout', methods=['POST'])
@login_required
def api_logout():
    if GLOBAL_DATA.get("data"):
        save_global_data_store()
    _clear_session_and_dashboard()
    logout_user()
    return jsonify({"status": "success", "msg": "已登出"})

@app.route('/api/me', methods=['GET'])
def api_me():
    if current_user.is_authenticated:
        return jsonify({"status": "success", "authenticated": True, "username": current_user.username})
    return jsonify({"status": "success", "authenticated": False})

@app.route('/upload', methods=['POST'])
@login_required
def upload_file():
    if 'file' not in request.files:
        return jsonify({"status": "error", "msg": "请选择文件"})

    file = request.files['file']
    if file.filename == '':
        return jsonify({"status": "error", "msg": "文件名为空"})

    if not allowed_file(file.filename):
        return jsonify({"status": "error", "msg": "仅支持 .xlsx/.xls/.csv 格式文件"})

    file_path = os.path.join(app.config["UPLOAD_FOLDER"], file.filename)
    file.save(file_path)

    try:
        # 读取文件
        df = read_excel_or_csv(file_path)
        # 处理空值
        df = handle_null_values(df)

        if "日期" in df.columns:
            df["日期"] = pd.to_datetime(df["日期"], errors='coerce')

        # 修复：只对数字列进行转换，不修改字符串列（日期、地区/区域、产品类型等）
        num_cols = get_numeric_columns(df)
        for col in num_cols:
            if col != "日期":
                df[col] = pd.to_numeric(df[col], errors='coerce')

        # 重置仪表盘图表（重要！）
        global dashboard_state
        dashboard_state["charts"] = []

        # 新主表会废弃上一份参考表，避免键不一致
        GLOBAL_DATA.pop("lookup_data", None)
        GLOBAL_DATA.pop("lookup_filename", None)
        GLOBAL_DATA["data"] = df.to_dict("records")
        GLOBAL_DATA["filename"] = file.filename
        GLOBAL_DATA["filesize"] = round(os.path.getsize(file_path) / 1024, 1)
        GLOBAL_DATA["data_source"] = "upload"
        GLOBAL_DATA["mapped_columns"] = mapped_columns_meta_from_df(df)
        sync_global_column_mapping(df)

        # 生成表格HTML
        raw_data_html = generate_raw_data_table(df, GLOBAL_DATA.get("mapped_columns"))
        all_cols = get_all_columns(df)
        num_cols = get_numeric_columns(df)
        sugg = infer_bi_metrics_columns(df)

        save_global_data_store()
        return jsonify({
            "status": "success",
            "all_columns": all_cols,
            "numeric_columns": num_cols,
            "raw_data_html": raw_data_html,
            "filename": file.filename,
            "filesize": round(os.path.getsize(file_path) / 1024, 1),
            "column_mapping_suggestion": {
                "mapped_date_col": sugg["date_col"],
                "mapped_value_col": sugg["sales_col"],
                "mapped_dim_col": sugg["region_col"],
            },
            "mapped_columns": GLOBAL_DATA.get("mapped_columns") or [],
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"status": "error", "msg": f"上传失败：{str(e)}"})
    finally:
        if os.path.exists(file_path):
            os.remove(file_path)


@app.route("/api/generate-demo-dataset", methods=["POST"])
@login_required
def api_generate_demo_dataset():
    """写入与 `generate_mock_data.py` / `TestData` 一致的内置主表及可选参考表，语义对齐上传后的会话。"""
    payload = request.get_json(silent=True) or {}
    try:
        n_rows = int(payload.get("n_rows", 1000))
        seed = int(payload.get("seed", 42))
    except (TypeError, ValueError):
        return jsonify({"status": "error", "msg": "n_rows 或 seed 参数无效"}), 400

    include_lookup = bool(payload.get("include_lookup", True))
    n_rows = max(10, min(n_rows, 10_000))
    seed = seed % (2**31)

    try:
        df = build_main_dataframe(n_rows=n_rows, seed=seed)
        if "日期" in df.columns:
            df["日期"] = pd.to_datetime(df["日期"], errors="coerce")
        for col in get_numeric_columns(df):
            if col != "日期":
                df[col] = pd.to_numeric(df[col], errors="coerce")
        df = ensure_datetime_date_column(df)
    except Exception as e:
        traceback.print_exc()
        return jsonify({"status": "error", "msg": f"生成失败：{str(e)}"}), 500

    global dashboard_state
    dashboard_state["charts"] = []

    GLOBAL_DATA["data"] = df.to_dict("records")
    GLOBAL_DATA["filename"] = f"(内置测试数据 · {n_rows} 行)"
    GLOBAL_DATA["filesize"] = round(max(1.0, n_rows * 0.06), 1)
    GLOBAL_DATA["data_source"] = "demo_generated"
    GLOBAL_DATA["mapped_columns"] = mapped_columns_meta_from_df(df)
    sync_global_column_mapping(df)

    if include_lookup:
        lkdf = build_lookup_dataframe()
        for col in get_numeric_columns(lkdf):
            if col != "日期":
                lkdf[col] = pd.to_numeric(lkdf[col], errors="coerce")
        GLOBAL_DATA["lookup_data"] = lkdf.to_dict("records")
        GLOBAL_DATA["lookup_filename"] = "(内置参考表 · test_lookup)"
    else:
        GLOBAL_DATA.pop("lookup_data", None)
        GLOBAL_DATA.pop("lookup_filename", None)

    raw_data_html = generate_raw_data_table(df, GLOBAL_DATA.get("mapped_columns"))
    all_cols = get_all_columns(df)
    num_cols_out = get_numeric_columns(df)
    sugg = infer_bi_metrics_columns(df)

    save_global_data_store()

    resp: Dict[str, Any] = {
        "status": "success",
        "msg": f"已生成测试主表 {n_rows} 条" + ("，并已载入参考表" if include_lookup else ""),
        "all_columns": all_cols,
        "numeric_columns": num_cols_out,
        "raw_data_html": raw_data_html,
        "filename": GLOBAL_DATA["filename"],
        "filesize": GLOBAL_DATA["filesize"],
        "column_mapping_suggestion": {
            "mapped_date_col": sugg["date_col"],
            "mapped_value_col": sugg["sales_col"],
            "mapped_dim_col": sugg["region_col"],
        },
        "mapped_columns": GLOBAL_DATA.get("mapped_columns") or [],
    }
    if include_lookup and GLOBAL_DATA.get("lookup_data"):
        lkdf2 = build_lookup_dataframe()
        resp["lookup_all_columns"] = get_all_columns(lkdf2)
        resp["lookup_numeric_columns"] = get_numeric_columns(lkdf2)
        resp["lookup_filename"] = GLOBAL_DATA.get("lookup_filename")
    return jsonify(resp)


@app.route("/upload-lookup", methods=["POST"])
@login_required
def upload_lookup():
    """上传关联参考表，存入 GLOBAL_DATA['lookup_data']（需已有主表）。"""
    if "data" not in GLOBAL_DATA:
        return jsonify({"status": "error", "msg": "请先上传主表数据"})

    if "file" not in request.files:
        return jsonify({"status": "error", "msg": "请选择参考表文件"})

    file = request.files["file"]
    if file.filename == "":
        return jsonify({"status": "error", "msg": "文件名为空"})

    if not allowed_file(file.filename):
        return jsonify({"status": "error", "msg": "仅支持 .xlsx/.xls/.csv 格式文件"})

    file_path = os.path.join(app.config["UPLOAD_FOLDER"], file.filename)
    file.save(file_path)

    try:
        df = read_excel_or_csv(file_path)
        df = handle_null_values(df)

        if "日期" in df.columns:
            df["日期"] = pd.to_datetime(df["日期"], errors="coerce")

        num_cols = get_numeric_columns(df)
        for col in num_cols:
            if col != "日期":
                df[col] = pd.to_numeric(df[col], errors="coerce")

        GLOBAL_DATA["lookup_data"] = df.to_dict("records")
        GLOBAL_DATA["lookup_filename"] = file.filename

        all_cols = get_all_columns(df)
        num_cols = get_numeric_columns(df)

        save_global_data_store()
        return jsonify(
            {
                "status": "success",
                "lookup_all_columns": all_cols,
                "lookup_numeric_columns": num_cols,
                "filename": file.filename,
                "msg": "参考表已上传",
            }
        )
    except Exception as e:
        traceback.print_exc()
        return jsonify({"status": "error", "msg": f"参考表解析失败：{str(e)}"})
    finally:
        if os.path.exists(file_path):
            os.remove(file_path)


@app.route("/apply-lookup", methods=["POST"])
@login_required
def apply_lookup():
    """左连接参考表，新增「计算结果」= 数量列 * 单价列，未匹配数值按 0 处理。"""
    if "data" not in GLOBAL_DATA:
        return jsonify({"status": "error", "msg": "请先上传主表数据"})
    if "lookup_data" not in GLOBAL_DATA:
        return jsonify({"status": "error", "msg": "请先上传关联参考表"})

    payload = request.get_json(silent=True) or {}
    main_key = payload.get("main_key")
    lookup_key = payload.get("lookup_key")
    qty_col = payload.get("qty_col")
    price_col = payload.get("price_col")

    if not all([main_key, lookup_key, qty_col, price_col]):
        return jsonify({"status": "error", "msg": "请完整选择主表关联键、参考表关联键、数量列与单价列"})

    try:
        left_df = pd.DataFrame(GLOBAL_DATA["data"])
        left_df = ensure_datetime_date_column(left_df)
        lookup_df = pd.DataFrame(GLOBAL_DATA["lookup_data"])

        for name, col in [
            ("主表关联键", main_key),
            ("数量列", qty_col),
        ]:
            if col not in left_df.columns:
                return jsonify({"status": "error", "msg": f"「{name}」列「{col}」不在主表中"})

        if lookup_key not in lookup_df.columns or price_col not in lookup_df.columns:
            return jsonify(
                {"status": "error", "msg": "参考表中不存在所选关联键或单价列，请重新选择"}
            )

        right_sub = lookup_df[[lookup_key, price_col]].copy()
        right_sub = right_sub.drop_duplicates(subset=[lookup_key], keep="last")

        price_alias = "__vlookup_unit_price"
        right_sub = right_sub.rename(columns={price_col: price_alias})
        out_price_name = f"{price_col}_参考"

        left_m = left_df.copy()
        if out_price_name in left_m.columns:
            left_m = left_m.drop(columns=[out_price_name])
        if "计算结果" in left_m.columns:
            left_m = left_m.drop(columns=["计算结果"])

        right_m = right_sub.copy()
        left_m[main_key] = left_m[main_key].astype(str).str.strip()
        right_m[lookup_key] = right_m[lookup_key].astype(str).str.strip()

        merged = pd.merge(
            left_m,
            right_m,
            how="left",
            left_on=main_key,
            right_on=lookup_key,
            suffixes=("", "_lkdup"),
        )

        if lookup_key != main_key and lookup_key in merged.columns:
            merged = merged.drop(columns=[lookup_key])

        unit = pd.to_numeric(merged[price_alias], errors="coerce").fillna(0)
        qty = pd.to_numeric(merged[qty_col], errors="coerce").fillna(0)
        merged[price_alias] = unit

        merged["计算结果"] = qty * unit
        merged = merged.rename(columns={price_alias: out_price_name})

        if "日期" in merged.columns:
            merged["日期"] = pd.to_datetime(merged["日期"], errors="coerce")

        num_cols = get_numeric_columns(merged)
        for col in num_cols:
            if col != "日期":
                merged[col] = pd.to_numeric(merged[col], errors="coerce")

        GLOBAL_DATA["data"] = merged.to_dict("records")
        GLOBAL_DATA["mapped_columns"] = mapped_columns_meta_from_df(merged)
        sync_global_column_mapping(merged)

        raw_data_html = generate_raw_data_table(merged, GLOBAL_DATA.get("mapped_columns"))
        all_cols = get_all_columns(merged)
        num_cols = get_numeric_columns(merged)

        save_global_data_store()
        return jsonify(
            {
                "status": "success",
                "all_columns": all_cols,
                "numeric_columns": num_cols,
                "raw_data_html": raw_data_html,
                "filename": GLOBAL_DATA.get("filename"),
                "filesize": GLOBAL_DATA.get("filesize"),
                "msg": "关联完成：已更新「计算结果」列",
                "mapped_columns": GLOBAL_DATA.get("mapped_columns") or [],
            }
        )
    except Exception as e:
        traceback.print_exc()
        return jsonify({"status": "error", "msg": f"关联失败：{str(e)}"})


@app.route("/clear-lookup", methods=["POST"])
def clear_lookup():
    GLOBAL_DATA.pop("lookup_data", None)
    GLOBAL_DATA.pop("lookup_filename", None)
    save_global_data_store()
    return jsonify({"status": "success"})


@app.route('/create-chart', methods=['POST'])
@login_required
def create_chart():
    data = request.json
    chart_type = data.get('type')
    x_col = data.get('x')
    y_cols = data.get('yList')  # 修复：支持多Y列
    theme = data.get('theme', current_theme)

    if "data" not in GLOBAL_DATA:
        return jsonify({"status": "error", "msg": "请先上传数据"})
    if not all([chart_type, x_col, y_cols]):
        return jsonify({"status": "error", "msg": "参数不完整"})

    try:
        df = get_session_dataframe()
        if df is None:
            return jsonify({"status": "error", "msg": "请先上传数据"})
        df, _ = filter_session_dataframe(data.get("filter_config"))
        # 兼容旧版传参
        if isinstance(y_cols, str):
            y_cols = [y_cols]

        chart_json = generate_chart(
            df,
            chart_type,
            x_col,
            y_cols,
            theme,
            mapped_date_col=GLOBAL_DATA.get("mapped_date_col"),
            mapped_dim_col=GLOBAL_DATA.get("mapped_dim_col"),
        )
        return jsonify({
            "status": "success",
            "chart": chart_json,
            "msg": "图表生成成功"
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({"status": "error", "msg": f"生成图表失败：{str(e)}"})

@app.route('/add-chart', methods=['POST'])
@login_required
def add_chart():
    global dashboard_state

    data = request.json
    print(f"[DEBUG] add-chart received: {data}") 

    if "data" not in GLOBAL_DATA:
        return jsonify({"status": "error", "msg": "请先上传数据"})

    # ✅ 先取参数
    chart_type = data.get("type")
    x_col = data.get("x")
    y_cols = data.get("yList") or [data.get("y")]

    if not all([chart_type, x_col, y_cols]):
        return jsonify({"status": "error", "msg": "参数不完整"})

    # ✅ 再建 df + 日期特征过滤
    df, filter_meta = filter_session_dataframe(data.get("filter_config"))

    # ✅ 统一时间列（与洞察分析口径一致）
    df, x_for_insight = resolve_insight_x_column(df, x_col)

    # ✅ 生成图表
    theme = data.get("theme", current_theme)
    chart_json = generate_chart(
        df,
        chart_type,
        x_col,
        y_cols,
        theme,
        mapped_date_col=GLOBAL_DATA.get("mapped_date_col"),
        mapped_dim_col=GLOBAL_DATA.get("mapped_dim_col"),
    )

    # ✅ 生成分析（用统一后的列）
    insights = generate_insight(df, x_for_insight, y_cols)

    # ✅ 存储
    chart_id = f"chart_{len(dashboard_state['charts']) + 1}"

    chart_item = {
        "id": chart_id,
        "type": chart_type,
        "x": x_col,
        "y": y_cols,
        "chart": chart_json,
        "insights": insights,
        "pos": data.get("pos", {"x": 0, "y": 0, "w": 6, "h": 4}),
        "filter_meta": filter_meta,
    }

    dashboard_state["charts"].append(chart_item)

    save_global_data_store()
    return jsonify({
        "status": "success",
        "chart": chart_item,
        "insights": insights,
        "filter_meta": filter_meta,
    })


@app.route('/get-dashboard', methods=['GET'])
def get_dashboard():
    if not dashboard_state.get("charts"):
        return jsonify({"charts": []})
    return jsonify(dashboard_state)


@app.route("/api/session-restore", methods=["GET"])
@login_required
def api_session_restore():
    """供前端首屏拉取：若磁盘上已恢复 GLOBAL_DATA，则返回与上传成功类似的载荷以便还原 UI。"""
    if "data" not in GLOBAL_DATA or not GLOBAL_DATA.get("data"):
        return jsonify({"status": "success", "has_data": False})
    df_full = get_session_dataframe_full()
    if df_full is None or df_full.empty:
        return jsonify({"status": "success", "has_data": False})
    sugg = infer_bi_metrics_columns(df_full)
    raw_data_html = generate_raw_data_table(df_full, GLOBAL_DATA.get("mapped_columns"))
    out: Dict[str, Any] = {
        "status": "success",
        "has_data": True,
        "all_columns": get_all_columns(df_full),
        "numeric_columns": get_numeric_columns(df_full),
        "raw_data_html": raw_data_html,
        "filename": GLOBAL_DATA.get("filename"),
        "filesize": GLOBAL_DATA.get("filesize"),
        "data_source": GLOBAL_DATA.get("data_source"),
        "mapped_columns": GLOBAL_DATA.get("mapped_columns") or [],
        "column_mapping_suggestion": {
            "mapped_date_col": GLOBAL_DATA.get("mapped_date_col") or sugg["date_col"],
            "mapped_value_col": GLOBAL_DATA.get("mapped_value_col") or sugg["sales_col"],
            "mapped_dim_col": GLOBAL_DATA.get("mapped_dim_col") or sugg["region_col"],
        },
    }
    if GLOBAL_DATA.get("lookup_data"):
        try:
            lk = pd.DataFrame(GLOBAL_DATA["lookup_data"])
            if not lk.empty:
                out["lookup_all_columns"] = get_all_columns(lk)
                out["lookup_numeric_columns"] = get_numeric_columns(lk)
                out["lookup_filename"] = GLOBAL_DATA.get("lookup_filename")
        except Exception:
            pass
    return jsonify(out)


@app.route("/api/dashboard-metrics", methods=["POST"])
@login_required
def api_dashboard_metrics():
    """顶部 KPI + 省份/区域排行（与日期筛选、图表穿透筛选口径一致）。"""
    empty = {
        "status": "success",
        "total_sales": 0.0,
        "mom_growth_pct": None,
        "order_count": 0,
        "warning_count": 0,
        "province_ranking": [],
        "multi_dim_summary": [],
        "meta": {"sales_col": None, "region_col": None, "date_col": None},
    }
    if "data" not in GLOBAL_DATA:
        return jsonify(empty)
    payload = request.get_json(silent=True) or {}

    layout_payload = payload.get("mapped_columns")
    layout_applied = False
    store_dirty = False
    if isinstance(layout_payload, list) and len(layout_payload) > 0:
        df_full = get_session_dataframe_full()
        if df_full is not None and not df_full.empty:
            meta = normalize_mapped_columns_meta(df_full, layout_payload)
            vis = [x["name"] for x in meta if x.get("visible") and x["name"] in df_full.columns]
            if len(vis) == 0:
                return jsonify({"status": "error", "msg": "请至少保留一列处于显示状态"}), 400
            md_chk = payload.get("mapped_date_col")
            mv_chk = payload.get("mapped_value_col")
            mdm_chk = payload.get("mapped_dim_col")
            if md_chk and mv_chk and mdm_chk:
                for col, label in (
                    (md_chk, "日期"),
                    (mv_chk, "数值"),
                    (mdm_chk, "维度"),
                ):
                    if col not in vis:
                        return jsonify(
                            {
                                "status": "error",
                                "msg": f"「{label}」字段「{col}」未处于显示状态，请开启该列或调整映射。",
                            }
                        ), 400
            GLOBAL_DATA["mapped_columns"] = meta
            layout_applied = True
            store_dirty = True

    md = payload.get("mapped_date_col")
    mv = payload.get("mapped_value_col")
    mdm = payload.get("mapped_dim_col")
    if md and mv and mdm:
        df_base = get_session_dataframe()
        if df_base is not None and not df_base.empty:
            cols = set(df_base.columns)
            if md in cols and mv in cols and mdm in cols:
                GLOBAL_DATA["mapped_date_col"] = md
                GLOBAL_DATA["mapped_value_col"] = mv
                GLOBAL_DATA["mapped_dim_col"] = mdm
                store_dirty = True

    df, _ = filter_session_dataframe(payload.get("filter_config"))
    if df is None or df.empty:
        if store_dirty:
            save_global_data_store()
        return jsonify(empty)
    m = compute_bi_dashboard_metrics(
        df,
        date_col=GLOBAL_DATA.get("mapped_date_col"),
        sales_col=GLOBAL_DATA.get("mapped_value_col"),
        region_col=GLOBAL_DATA.get("mapped_dim_col"),
    )
    out = {"status": "success", **m}
    if layout_applied:
        df_full = get_session_dataframe_full()
        if df_full is not None and not df_full.empty:
            out["all_columns"] = get_all_columns(df_full)
            out["numeric_columns"] = get_numeric_columns(df_full)
            out["raw_data_html"] = generate_raw_data_table(
                df_full, GLOBAL_DATA.get("mapped_columns")
            )
            out["mapped_columns"] = GLOBAL_DATA.get("mapped_columns") or []
    if store_dirty:
        save_global_data_store()
    return jsonify(out)


@app.route("/api/column-mapping-state", methods=["GET"])
def api_column_mapping_state():
    """供「管理字段」入口拉取当前 mapped_columns（含隐藏列）与映射下拉选项。"""
    if "data" not in GLOBAL_DATA:
        return jsonify({"status": "error", "msg": "请先上传或载入数据"}), 400
    df = get_session_dataframe_full()
    if df is None or df.empty:
        return jsonify({"status": "error", "msg": "当前没有主表数据"}), 400
    raw_meta = GLOBAL_DATA.get("mapped_columns")
    if not raw_meta:
        meta = mapped_columns_meta_from_df(df)
    else:
        meta = normalize_mapped_columns_meta(df, raw_meta)
    GLOBAL_DATA["mapped_columns"] = meta
    save_global_data_store()
    return jsonify(
        {
            "status": "success",
            "mapped_columns": meta,
            "all_columns": get_all_columns(df),
            "numeric_columns": get_numeric_columns(df),
            "mapped_date_col": GLOBAL_DATA.get("mapped_date_col"),
            "mapped_value_col": GLOBAL_DATA.get("mapped_value_col"),
            "mapped_dim_col": GLOBAL_DATA.get("mapped_dim_col"),
            "filename": GLOBAL_DATA.get("filename"),
            "filesize": GLOBAL_DATA.get("filesize"),
        }
    )


@app.route("/api/detect-anomalies", methods=["POST"])
def api_detect_anomalies():
    """对当前主表全量数据做离群与质量类异常检测（utils.anomaly_detector）。"""
    if "data" not in GLOBAL_DATA:
        return jsonify({"status": "error", "msg": "请先上传或载入数据"}), 400
    df = get_session_dataframe_full()
    if df is None or df.empty:
        return jsonify({"status": "error", "msg": "没有可分析的数据"}), 400
    try:
        report = detect_anomalies(df)
        safe = json.loads(json.dumps(report, default=str, ensure_ascii=False))
        return jsonify({"status": "success", "report": safe})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"status": "error", "msg": str(e)}), 500


@app.route('/reset-dashboard', methods=['POST'])
def reset_dashboard():
    """清空服务端图表列表；不删除 GLOBAL_DATA 中的主表，便于在同一份数据上重新搭画布。"""
    global dashboard_state
    dashboard_state["charts"] = []
    save_global_data_store()
    return jsonify({"status": "success"})


@app.route('/clear-upload', methods=['POST'])
def clear_upload():
    """移除文件时清空 GLOBAL_DATA、会话布局与仪表盘，需重新上传。"""
    _clear_session_and_dashboard()
    return jsonify({"status": "success"})


@app.route("/api/clear-session", methods=["POST"])
def api_clear_session():
    """清除 GLOBAL_DATA 与仪表盘等状态（与移除文件一致，供工具栏/显式清理使用）。"""
    _clear_session_and_dashboard()
    return jsonify({"status": "success", "msg": "会话已清除"})

@app.route('/update-layout', methods=['POST'])
def update_layout():
    global dashboard_state

    layout = request.json.get("layout", [])

    for item in dashboard_state["charts"]:
        for l in layout:
            if item["id"] == l["id"]:
                item["pos"] = l

    save_global_data_store()
    return jsonify({"status": "success"})

@app.route('/toggle-theme', methods=['POST'])
def toggle_theme():
    global current_theme
    current_theme = "dark" if current_theme == "light" else "light"
    return jsonify({"theme": current_theme})

@app.route('/download-report', methods=['GET'])
def download_report():
    img = Image.new('RGB', (1200, 800), color=(255, 255, 255))
    draw = ImageDraw.Draw(img)
    font_large = get_font(40)
    font_small = get_font(24)
    draw.text((50, 50), "Smart Data Report Project — Dashboard", fill=(0, 0, 0), font=font_large)

    y_offset = 120
    for chart in dashboard_state.get("charts", []):
        text = f"{chart['type']} | X:{chart['x']} | Y:{', '.join(chart['y'])}"
        draw.text((50, y_offset), text, fill=(0, 0, 0), font=font_small)
        y_offset += 40
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    buf.seek(0)
    return send_file(buf, mimetype='image/png', as_attachment=True, download_name="report.png")


@app.route("/api/export", methods=["GET"])
@login_required
def api_export():
    """
    导出当前主表：使用 get_session_dataframe_full() 全量行，
    按 GLOBAL_DATA['mapped_columns'] 的显隐与顺序筛选/重排，
    日期/数值/维度三列使用「日期」「数值」「维度」表头（或单项 display_name）。
    """
    fmt = (request.args.get("format") or "excel").lower()
    if fmt == "xlsx":
        fmt = "excel"
    if fmt not in {"excel", "pdf", "csv"}:
        return jsonify({"status": "error", "msg": "不支持的格式，请使用 format=excel|pdf|csv"}), 400
    if "data" not in GLOBAL_DATA:
        return jsonify({"status": "error", "msg": "请先上传或载入数据"}), 400
    df_full = get_session_dataframe_full()
    if df_full is None or df_full.empty:
        return jsonify({"status": "error", "msg": "没有可导出的数据"}), 400

    meta = normalize_mapped_columns_meta(df_full, GLOBAL_DATA.get("mapped_columns") or [])
    try:
        df_out = build_export_dataframe(
            df_full,
            meta,
            GLOBAL_DATA.get("mapped_date_col"),
            GLOBAL_DATA.get("mapped_value_col"),
            GLOBAL_DATA.get("mapped_dim_col"),
        )
    except ValueError as e:
        return jsonify({"status": "error", "msg": str(e)}), 400

    fn = GLOBAL_DATA.get("filename") or "export"
    stem = fn.rsplit(".", 1)[0] if "." in fn else fn
    base = sanitize_export_basename(stem)

    try:
        if fmt == "excel":
            payload = dataframe_to_excel_bytes(df_out)
            return send_file(
                io.BytesIO(payload),
                mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                as_attachment=True,
                download_name=f"{base}_数据.xlsx",
            )
        if fmt == "csv":
            payload = dataframe_to_csv_bytes(df_out)
            return send_file(
                io.BytesIO(payload),
                mimetype="text/csv; charset=utf-8",
                as_attachment=True,
                download_name=f"{base}_数据.csv",
            )
        payload, font_fallback = dataframe_to_pdf_bytes(df_out)
        resp = send_file(
            io.BytesIO(payload),
            mimetype="application/pdf",
            as_attachment=True,
            download_name=f"{base}_数据.pdf",
        )
        if font_fallback:
            resp.headers["X-Export-Pdf-Font"] = "fallback"
        return resp
    except ImportError as e:
        traceback.print_exc()
        return jsonify({"status": "error", "msg": f"导出依赖未安装：{e}"}), 500
    except Exception as e:
        traceback.print_exc()
        return jsonify({"status": "error", "msg": f"导出失败：{e}"}), 500


@app.route('/save-layout', methods=['POST'])
def save_layout():
    session['chart_layout'] = request.json.get('layout')
    return jsonify({"status": "success"})

@app.route('/get-layout', methods=['GET'])
def get_layout():
    return jsonify({"layout": session.get('chart_layout', [])})

@app.route("/balance-sheet")
def balance_sheet():
    df = get_session_dataframe()
    if df is None:
        return jsonify({"status": "error", "msg": "没有数据，请先上传文件"})

    html = generate_balance_sheet(df)

    insights = generate_insight(df, "日期", ["流动资产"])

    return jsonify({
        "status": "success",
        "html": html,
        "insights": insights
    })


@app.route("/api/templates", methods=["GET"])
def api_templates():
    return jsonify({"status": "success", "templates": list_report_templates(REPORT_TEMPLATES_DIR)})


@app.route("/api/mock-rates", methods=["GET"])
def api_mock_rates():
    return jsonify({"status": "success", "rates_to_cny": get_mock_rates()})


@app.route("/api/insights", methods=["POST"])
def api_insights():
    """按 filter_config 过滤后生成洞察文案（与图表联动口径一致）。"""
    if "data" not in GLOBAL_DATA:
        return jsonify({"status": "error", "msg": "请先上传数据"})
    payload = request.get_json(silent=True) or {}
    x_col = payload.get("x_col")
    y_cols = payload.get("yList") or payload.get("y_cols") or []
    if isinstance(y_cols, str):
        y_cols = [y_cols]
    if not y_cols and payload.get("y"):
        y_cols = [payload.get("y")]
    if not x_col or not y_cols:
        return jsonify({"status": "error", "msg": "参数不完整：需要 x_col 与 y_cols / yList"})

    try:
        df, filter_meta = filter_session_dataframe(payload.get("filter_config"))
        df, x_for_insight = resolve_insight_x_column(df, x_col)
        insights = generate_insight(df, x_for_insight, y_cols)
        return jsonify(
            {
                "status": "success",
                "insights": insights,
                "filter_meta": filter_meta,
            }
        )
    except Exception as e:
        traceback.print_exc()
        return jsonify({"status": "error", "msg": str(e)})


@app.route("/api/get-details", methods=["POST"])
def api_get_details():
    """返回与当前筛选（星期/区间 + 图表分类下钻）一致的明细行，供弹窗表格展示。"""
    if "data" not in GLOBAL_DATA:
        return jsonify({"status": "error", "msg": "请先上传数据"})
    payload = request.get_json(silent=True) or {}
    try:
        df, filter_meta = filter_session_dataframe(payload.get("filter_config"))
        if df is None:
            return jsonify({"status": "error", "msg": "无数据"})
        cols = list(df.columns)
        records = json.loads(df.to_json(orient="records", date_format="iso"))
        return jsonify(
            {
                "status": "success",
                "columns": cols,
                "rows": records,
                "row_count": len(records),
                "filter_meta": filter_meta,
            }
        )
    except Exception as e:
        traceback.print_exc()
        return jsonify({"status": "error", "msg": str(e)})


@app.route("/api/chart-render", methods=["POST"])
def api_chart_render():
    """仅渲染图表 JSON + 洞察，不写入 dashboard_state；供日期筛选实时刷新。"""
    if "data" not in GLOBAL_DATA:
        return jsonify({"status": "error", "msg": "请先上传数据"})
    payload = request.get_json(silent=True) or {}
    chart_type = payload.get("type")
    x_col = payload.get("x")
    y_cols = payload.get("yList") or [payload.get("y")]
    theme = payload.get("theme", current_theme)
    if not all([chart_type, x_col, y_cols]):
        return jsonify({"status": "error", "msg": "参数不完整"})

    try:
        if isinstance(y_cols, str):
            y_cols = [y_cols]
        df, filter_meta = filter_session_dataframe(payload.get("filter_config"))
        chart_json = generate_chart(
            df,
            chart_type,
            x_col,
            y_cols,
            theme,
            mapped_date_col=GLOBAL_DATA.get("mapped_date_col"),
            mapped_dim_col=GLOBAL_DATA.get("mapped_dim_col"),
        )
        df_ins, x_for_insight = resolve_insight_x_column(df, x_col)
        insights = generate_insight(df_ins, x_for_insight, y_cols)
        df_agg, _xeff = aggregate_for_chart(df, x_col, y_cols)
        anomaly = bool(
            y_cols
            and aggregation_has_high_spike(df_agg, y_cols[0])
        )
        return jsonify(
            {
                "status": "success",
                "chart": chart_json,
                "insights": insights,
                "filter_meta": filter_meta,
                "anomaly": anomaly,
            }
        )
    except Exception as e:
        traceback.print_exc()
        return jsonify({"status": "error", "msg": str(e)})


@app.route("/api/template-column-tree", methods=["GET"])
def api_template_column_tree():
    """返回模板中的 column_tree，供前端树形勾选。"""
    template_id = request.args.get("template_id")
    if not template_id:
        return jsonify({"status": "error", "msg": "缺少 template_id"})

    path = os.path.join(REPORT_TEMPLATES_DIR, f"{template_id}.json")
    if not os.path.isfile(path):
        for name in os.listdir(REPORT_TEMPLATES_DIR):
            if not name.endswith(".json"):
                continue
            try:
                t = load_template(os.path.join(REPORT_TEMPLATES_DIR, name))
                if t.get("id") == template_id:
                    path = os.path.join(REPORT_TEMPLATES_DIR, name)
                    break
            except Exception:
                continue
        else:
            return jsonify({"status": "error", "msg": f"未找到模板：{template_id}"})

    template = load_template(path)
    tree = template.get("column_tree") or []
    return jsonify({
        "status": "success",
        "template_id": template.get("id"),
        "column_tree": tree,
    })


@app.route("/smart-table", methods=["POST"])
def smart_table():
    """多级表头 + 币种折算 + 嵌套 JSON 单元格；模板定义见 report_templates/*.json"""
    if "data" not in GLOBAL_DATA:
        return jsonify({"status": "error", "msg": "没有数据，请先上传文件或使用模板/手动载入"})

    payload = request.get_json(silent=True) or {}
    template_id = payload.get("template_id") or payload.get("id")
    if not template_id:
        return jsonify({"status": "error", "msg": "缺少 template_id"})

    path = os.path.join(REPORT_TEMPLATES_DIR, f"{template_id}.json")
    if not os.path.isfile(path):
        path_alt = None
        for name in os.listdir(REPORT_TEMPLATES_DIR):
            if name.endswith(".json"):
                try:
                    t = load_template(os.path.join(REPORT_TEMPLATES_DIR, name))
                    if t.get("id") == template_id:
                        path_alt = os.path.join(REPORT_TEMPLATES_DIR, name)
                        break
                except Exception:
                    continue
        if not path_alt:
            return jsonify({"status": "error", "msg": f"未找到模板：{template_id}"})
        path = path_alt

    template = load_template(path)
    df, filter_meta = filter_session_dataframe(payload.get("filter_config"))

    column_visibility = payload.get("column_visibility")
    if column_visibility is not None and not isinstance(column_visibility, dict):
        column_visibility = None

    display_currency = payload.get("display_currency")

    html = render_smart_table_html(
        df,
        template,
        column_visibility=column_visibility,
        display_currency=display_currency,
    )

    leaf = compute_visible_leaves(template, df, column_visibility)

    insights = []
    try:
        df_insight = apply_currency_only(df, template, leaf)
        md = GLOBAL_DATA.get("mapped_date_col")
        m_dim = GLOBAL_DATA.get("mapped_dim_col")
        if md and md in df_insight.columns:
            x_col = md
        elif "日期" in df_insight.columns:
            x_col = "日期"
        elif m_dim and m_dim in df_insight.columns:
            x_col = m_dim
        elif leaf:
            x_col = leaf[0]
        elif len(df_insight.columns) > 0:
            x_col = df_insight.columns[0]
        else:
            x_col = None
        num_candidates = [
            c for c in (leaf or [])
            if c in df_insight.columns and pd.api.types.is_numeric_dtype(df_insight[c])
        ]
        if not num_candidates:
            num_candidates = [
                c for c in df_insight.columns if pd.api.types.is_numeric_dtype(df_insight[c])
            ]
        if num_candidates and x_col:
            insights = generate_insight(df_insight, x_col, [num_candidates[0]])
    except Exception:
        insights = []

    meta_tgt = template.get("target_ccy", "CNY")
    meta_disp = display_currency or meta_tgt

    return jsonify({
        "status": "success",
        "html": html,
        "insights": insights,
        "template_id": template.get("id"),
        "filter_meta": filter_meta,
        "meta": {
            "target_ccy": meta_tgt,
            "display_currency": meta_disp,
        },
    })

@app.route("/api/session-manual", methods=["POST"])
def session_manual():
    """手动粘贴或模拟外部集成数据写入 GLOBAL_DATA"""
    payload = request.get_json(silent=True) or {}
    label = payload.get("label", "")
    
    # --- 智能模拟数据生成逻辑 ---
    if "银行" in label or "支付宝" in label or "微信" in label:
        # 定义模拟的财务科目
        categories = ['餐饮美食', '交通出行', '销售收入', '办公用品', '技术服务费', '房租物业', '市场推广']
        descriptions = {
            '餐饮美食': ['美团外卖', '商务午餐', '星巴克'],
            '交通出行': ['滴滴打车', '加油站', '高铁票'],
            '销售收入': ['项目回款', '产品销售', '咨询服务费'],
            '办公用品': ['京东采购', '文具消耗', '打印机碳粉'],
            '技术服务费': ['云服务器续费', 'API接口费'],
            '房租物业': ['办公室租金', '电费缴纳'],
            '市场推广': ['朋友圈广告', '搜索引擎优化']
        }
        
        rows = []
        base_date = datetime.now()
        
        for i in range(50):
            cat = random.choice(categories)
            # 只有销售收入是加钱，其他都是支出
            is_income = (cat == '销售收入')
            
            if is_income:
                amount = round(random.uniform(1000, 8000), 2)
            else:
                amount = -round(random.uniform(50, 1500), 2)
            
            random_days = random.randint(0, 30)
            row_date = (base_date - timedelta(days=random_days)).strftime('%Y-%m-%d')
            
            # --- 核心修复：对齐智能表格模板的 Key ---
            rows.append({
                "日期": row_date,
                "地区": random.choice(['华东', '华北', '华南', '西南']),
                "产品类型": random.choice(['硬件', '软件', '服务']),
                "科目": cat,
                "销量": random.randint(1, 100) if is_income else 0,
                "销售额": abs(amount) if is_income else 0,
                "金额": amount, # 兼容旧逻辑
                "利润": round(amount * 0.25, 2) if is_income else 0,
                "描述": random.choice(descriptions[cat]),
                "备注": "系统自动对账" if is_income else "日常报销",
                "交易流水号": f"TXN{random.randint(100000, 999999)}"
            })
            
        rows.sort(key=lambda x: x['日期'], reverse=True)
    else:
        rows = payload.get("rows")

    if not isinstance(rows, list) or not rows:
        return jsonify({"status": "error", "msg": "数据格式错误或为空"})

    GLOBAL_DATA.pop("lookup_data", None)
    GLOBAL_DATA.pop("lookup_filename", None)
    GLOBAL_DATA["data"] = rows
    GLOBAL_DATA["data_source"] = "manual"
    GLOBAL_DATA["filename"] = label or "(手动录入)"

    df = pd.DataFrame(rows)
    try:
        df = ensure_datetime_date_column(df)
    except Exception:
        pass
    try:
        ac = list(df.columns)
        nc = df.select_dtypes(include=["number"]).columns.tolist()
    except Exception:
        ac, nc = [], []
    sync_global_column_mapping(df if df is not None and not df.empty else None)

    GLOBAL_DATA["mapped_columns"] = mapped_columns_meta_from_df(df)
    raw_data_html = generate_raw_data_table(df, GLOBAL_DATA.get("mapped_columns"))

    save_global_data_store()
    return jsonify({
        "status": "success",
        "msg": f"已成功同步 {len(rows)} 条{label}数据",
        "all_columns": ac,
        "numeric_columns": nc,
        "data_source": "manual",
        "raw_data_html": raw_data_html,
        "mapped_columns": GLOBAL_DATA.get("mapped_columns") or [],
    })


@app.route("/api/load-template-data", methods=["POST"])
def load_template_data():
    """使用模板 embedded_rows 或内置标准示例写入 GLOBAL_DATA（与 V3 布局及仪表盘指标口径一致）。"""
    payload = request.get_json(silent=True) or {}
    template_id = payload.get("template_id") or payload.get("id")
    if not template_id:
        return jsonify({"status": "error", "msg": "缺少 template_id"})

    path = _resolve_template_json_path(template_id)
    if not path:
        return jsonify({"status": "error", "msg": f"未找到模板：{template_id}"})

    template = load_template(path)
    rows = template.get("embedded_rows")
    if not isinstance(rows, list) or not rows:
        rows = _fallback_embedded_rows_for_template(template)
    if not rows:
        return jsonify({"status": "error", "msg": "无法生成示例数据"})

    GLOBAL_DATA.pop("lookup_data", None)
    GLOBAL_DATA.pop("lookup_filename", None)
    GLOBAL_DATA["data_source"] = "template"
    GLOBAL_DATA["filename"] = template.get("name", template_id)
    GLOBAL_DATA["filesize"] = None

    df = pd.DataFrame(rows)
    df = ensure_datetime_date_column(df)
    sync_global_column_mapping(df)
    GLOBAL_DATA["data"] = df.to_dict("records")
    GLOBAL_DATA["mapped_columns"] = mapped_columns_meta_from_df(df)

    ac = list(df.columns)
    nc = df.select_dtypes(include=["number"]).columns.tolist()

    raw_data_html = generate_raw_data_table(df, GLOBAL_DATA.get("mapped_columns"))

    save_global_data_store()
    return jsonify({
        "status": "success",
        "msg": "已载入模板示例数据",
        "all_columns": ac,
        "numeric_columns": nc,
        "data_source": "template",
        "template_id": template.get("id"),
        "raw_data_html": raw_data_html,
        "mapped_columns": GLOBAL_DATA.get("mapped_columns") or [],
    })


load_global_data_store()


if __name__ == '__main__':
    app.run(debug=True)