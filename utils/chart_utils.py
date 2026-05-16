import json
import html
from typing import Any, List, Optional, Tuple

import plotly
import plotly.graph_objects as go
import pandas as pd

from utils.data_process import get_numeric_columns

COLOR_THEMES = {
    "light": {
        "bg": "white", "grid": "#f3f4f6", "text": "#111827",
        "pie": ["#2563eb", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6"]
    },
    "dark": {
        "bg": "#1f2937", "grid": "#374151", "text": "#f9fafb",
        "pie": ["#0ea5e9", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6"]
    }
}

def _raw_data_column_order(df: pd.DataFrame, mapped_columns: Optional[List[Any]]) -> List[Tuple[str, bool]]:
    """返回 (列名, 是否显示) 列表；顺序与列管理弹窗一致，含已隐藏列。"""
    if df is None or df.empty:
        return []
    if not mapped_columns:
        return [(str(c), True) for c in df.columns]
    seen = set()
    out: List[Tuple[str, bool]] = []
    for item in mapped_columns:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        if name is None or name not in df.columns or name in seen:
            continue
        seen.add(name)
        out.append((str(name), bool(item.get("visible", True))))
    for c in df.columns:
        if c not in seen:
            out.append((str(c), True))
    return out


def generate_raw_data_table(df: pd.DataFrame, mapped_columns: Optional[List[Any]] = None):
    """
    底部「原始数据」表格 HTML。
    若传入 mapped_columns（与 GLOBAL_DATA 一致），则按其中顺序输出全部列：
    隐藏列仍占位表头与单元格（—），以便与未隐藏时列位置对齐。
    """
    if df is None or df.empty:
        return '<p class="text-muted small mb-0">暂无数据</p>'

    view = df.head(50)
    order_vis = _raw_data_column_order(view, mapped_columns)

    if not mapped_columns:
        return view.to_html(
            index=False,
            classes="table table-sm table-bordered raw-data-table mb-0 align-middle",
            escape=True,
        )

    if not order_vis:
        return view.to_html(
            index=False,
            classes="table table-sm table-bordered raw-data-table mb-0 align-middle",
            escape=True,
        )

    th_parts = []
    for name, vis in order_vis:
        esc = html.escape(name, quote=False)
        th_cls = "raw-data-th text-nowrap" + (" raw-data-th--hidden" if not vis else "")
        title_attr = html.escape(
            "此列已隐藏，不在分析视图中显示" if not vis else str(name), quote=True
        )
        th_parts.append(f'<th scope="col" class="{th_cls}" title="{title_attr}">{esc}</th>')

    body_rows = []
    for _, row in view.iterrows():
        tds = []
        for name, vis in order_vis:
            if not vis:
                tds.append(
                    '<td class="raw-data-td raw-data-td--hidden text-muted text-center">—</td>'
                )
                continue
            v = row[name]
            if v is None or (isinstance(v, float) and pd.isna(v)):
                disp = ""
            else:
                disp = str(v)
            esc = html.escape(disp, quote=False)
            num_cls = ""
            try:
                if pd.api.types.is_numeric_dtype(view[name].dtype):
                    num_cls = " text-end raw-data-td-num"
            except Exception:
                pass
            tds.append(f'<td class="raw-data-td{num_cls}">{esc}</td>')
        body_rows.append("<tr>" + "".join(tds) + "</tr>")

    return (
        '<table class="table table-sm table-bordered raw-data-table mb-0 align-middle">'
        f'<thead><tr>{"".join(th_parts)}</tr></thead>'
        f'<tbody>{"".join(body_rows)}</tbody></table>'
    )


def aggregate_for_chart(df: pd.DataFrame, x_col: str, y_cols: list):
    """
    与 generate_chart 一致的分组/聚合逻辑。
    返回 (聚合后的 DataFrame, 实际用作 X 的列名)。
    """
    df = df.copy()
    if isinstance(y_cols, str):
        y_cols = [y_cols]

    for y in y_cols:
        if y not in df.columns:
            continue
        if df[y].dtype == object:
            df[y] = (
                df[y]
                .astype(str)
                .str.replace(",", "")
                .str.replace("¥", "")
                .str.replace("$", "")
                .str.strip()
            )
        df[y] = pd.to_numeric(df[y], errors="coerce")

    try:
        date_series = pd.to_datetime(df[x_col], errors="coerce")
        is_date = date_series.notna().any()
    except Exception:
        is_date = False

    if is_date:
        df[x_col] = pd.to_datetime(df[x_col], errors="coerce")
        df = df.dropna(subset=[x_col] + y_cols)
        if df.empty:
            return df, x_col
        df["_month"] = df[x_col].dt.to_period("M").astype(str)
        df = df.groupby("_month", as_index=False)[y_cols].sum()
        df = df.sort_values("_month")
        return df, "_month"

    df = df.dropna(subset=[x_col] + y_cols)
    if df.empty:
        return df, x_col
    df = df.groupby(x_col, as_index=False)[y_cols].sum()
    df = df.sort_values(x_col)
    return df, x_col


def aggregation_has_high_spike(df_agg: pd.DataFrame, y_col: str, ratio: float = 1.35) -> bool:
    """聚合序列中若最大值显著高于均值，用于简单异常提醒。"""
    if df_agg is None or df_agg.empty or y_col not in df_agg.columns:
        return False
    s = pd.to_numeric(df_agg[y_col], errors="coerce").dropna()
    if len(s) < 3:
        return False
    mean_v = float(s.mean())
    max_v = float(s.max())
    if mean_v <= 0:
        return max_v > 0 and max_v > abs(mean_v) * ratio + 1e-9
    return max_v > mean_v * ratio


def _chart_layout_title_text(
    x_eff: str,
    y_cols: list,
    mapped_date_col: Optional[str],
    mapped_dim_col: Optional[str],
) -> str:
    y0 = str(y_cols[0]) if y_cols else ""
    xs = str(x_eff)
    if mapped_date_col and xs == str(mapped_date_col):
        return f"{y0}趋势" if y0 else "销售趋势"
    if mapped_dim_col and xs == str(mapped_dim_col):
        return f"{mapped_dim_col}销售分布"
    if y0:
        return f"{xs} · {y0}"
    return xs


def generate_chart(
    df,
    chart_type,
    x_col,
    y_cols,
    theme,
    show_anomaly_hint=True,
    mapped_date_col: Optional[str] = None,
    mapped_dim_col: Optional[str] = None,
):
    df = df.copy()

    if isinstance(y_cols, str):
        y_cols = [y_cols]

    df_agg, x_eff = aggregate_for_chart(df, x_col, y_cols)

    print("\n" + "=" * 60)
    print(f"[DEBUG] chart_type={chart_type}, y_cols={y_cols}, x_col={x_eff}")
    print(f"[DEBUG] Aggregated data:\n{df_agg.to_string()}")
    print("=" * 60)

    theme_cfg = COLOR_THEMES[theme]
    colors = theme_cfg["pie"]

    if df_agg.empty:
        fig = go.Figure()
        fig.add_annotation(
            text="筛选后无可用数据",
            xref="paper",
            yref="paper",
            x=0.5,
            y=0.5,
            showarrow=False,
            font=dict(size=14, color=theme_cfg["text"]),
        )
        fig.update_layout(
            paper_bgcolor=theme_cfg["bg"],
            plot_bgcolor=theme_cfg["bg"],
            font_color=theme_cfg["text"],
            margin=dict(l=20, r=20, t=30, b=20),
        )
        return json.dumps(fig, cls=plotly.utils.PlotlyJSONEncoder)

    x_vals = df_agg[x_eff].tolist()
    y_vals = {y: df_agg[y].tolist() for y in y_cols}

    fig = go.Figure()

    if chart_type == "bar":
        for i, y in enumerate(y_cols):
            fig.add_trace(
                go.Bar(
                    x=x_vals,
                    y=y_vals[y],
                    marker_color=colors[i % len(colors)],
                    name=y,
                )
            )
    elif chart_type == "line":
        for i, y in enumerate(y_cols):
            fig.add_trace(
                go.Scatter(
                    x=x_vals,
                    y=y_vals[y],
                    mode="lines+markers",
                    line=dict(color=colors[i % len(colors)], shape="linear"),
                    name=y,
                )
            )
    elif chart_type == "area":
        for i, y in enumerate(y_cols):
            fig.add_trace(
                go.Scatter(
                    x=x_vals,
                    y=y_vals[y],
                    fill="tozeroy",
                    mode="lines",
                    line=dict(color=colors[i % len(colors)], shape="linear"),
                    name=y,
                )
            )
    elif chart_type == "pie":
        fig.add_trace(
            go.Pie(
                labels=x_vals,
                values=y_vals[y_cols[0]],
                marker_colors=colors[: len(df_agg)],
            )
        )

    title_text = _chart_layout_title_text(x_eff, y_cols, mapped_date_col, mapped_dim_col)
    layout_updates = dict(
        paper_bgcolor=theme_cfg["bg"],
        plot_bgcolor=theme_cfg["bg"],
        font_color=theme_cfg["text"],
        margin=dict(l=20, r=20, t=52, b=20),
        title=dict(
            text=title_text,
            x=0.5,
            xanchor="center",
            y=0.98,
            yanchor="top",
            font=dict(size=14, color=theme_cfg["text"]),
        ),
    )

    if show_anomaly_hint and y_cols and aggregation_has_high_spike(
        df_agg, y_cols[0]
    ):
        accent = "#d97706" if theme == "light" else "#fbbf24"
        layout_updates["annotations"] = [
            dict(
                text="异常提醒：当前序列峰值明显高于均值，请留意波动",
                xref="paper",
                yref="paper",
                x=0.98,
                y=1.05,
                xanchor="right",
                yanchor="bottom",
                showarrow=False,
                font=dict(size=11, color=accent),
                bgcolor="rgba(255,247,237,0.92)" if theme == "light" else "rgba(30,41,59,0.92)",
                borderpad=4,
            )
        ]

    fig.update_layout(**layout_updates)

    return json.dumps(fig, cls=plotly.utils.PlotlyJSONEncoder)


# ================= 资产负债表 =================

def classify_columns(df):
    categories = {
        "asset": [],
        "liability": [],
        "equity": []
    }

    for col in df.columns:
        name = col.lower()

        if any(k in name for k in ["资产", "现金", "存货", "应收"]):
            categories["asset"].append(col)

        elif any(k in name for k in ["负债", "应付", "借款"]):
            categories["liability"].append(col)

        elif any(k in name for k in ["利润", "权益", "净利"]):
            categories["equity"].append(col)

    return categories


def calculate_totals(df, categories):
    result = {"asset": 0, "liability": 0, "equity": 0}

    for key in categories:
        for col in categories[key]:
            vals = pd.to_numeric(df[col], errors='coerce')
            result[key] += vals.sum()

    return result

def generate_balance_sheet(df):
    df['日期'] = pd.to_datetime(df['日期'])

    latest_date = df['日期'].max()
    df_latest = df[df['日期'] == latest_date]

    assets = (df_latest["流动资产"] + df_latest["固定资产"]).sum()
    liabilities = (df_latest["短期借款"] + df_latest["应付账款"]).sum()

    equity = assets - liabilities

    diff = assets - liabilities - equity

    return f"""
    <table class="data-table">
        <tr><td>资产合计</td><td>{assets:.0f}</td></tr>
        <tr><td>负债合计</td><td>{liabilities:.0f}</td></tr>
        <tr><td>所有者权益</td><td>{equity:.0f}</td></tr>
        <tr><td>差额</td><td>{diff:.0f}</td></tr>
    </table>
    """
def generate_insight(df, x_col, y_cols):
    try:
        if not x_col or not y_cols:
            return []

        y = y_cols[0]

        # 🧠 判断是不是时间列
        if pd.api.types.is_datetime64_any_dtype(df[x_col]) or "month" in x_col:
            # ===== 时间分析 =====
            df = df.sort_values(x_col)

            df["prev"] = df[y].shift(1)
            df["growth"] = df[y] - df["prev"]

            latest = df.iloc[-1]
            prev = df.iloc[-2] if len(df) > 1 else None

            insights = []

            if prev is not None:
                diff = latest[y] - prev[y]
                insights.append(f"{x_col} 最新较上期变化 {diff:.0f}")

            insights.append(f"最大值为 {df[y].max():.0f}")
            insights.append(f"最小值为 {df[y].min():.0f}")

            return insights

        else:
            # ===== 分类分析（区域）=====
            grouped = df.groupby(x_col)[y].sum().reset_index()

            max_row = grouped.loc[grouped[y].idxmax()]
            min_row = grouped.loc[grouped[y].idxmin()]

            insights = [
                f"{x_col}中最高的是 {max_row[x_col]}（{max_row[y]:.0f}）",
                f"{x_col}中最低的是 {min_row[x_col]}（{min_row[y]:.0f}）"
            ]

            return insights

    except Exception as e:
        print("Insight error:", e)
        return []


_SALES_NAME_KEYS = (
    "销售额",
    "销售金额",
    "营业额",
    "营收",
    "收入",
    "总额",
    "revenue",
    "sales",
    "amount",
    "金额",
)
_REGION_NAME_KEYS = (
    "省份",
    "省",
    "区域",
    "城市",
    "地区",
    "大区",
    "province",
    "region",
)
_ORDER_NAME_KEYS = ("订单号", "订单", "order_id", "orderid", "单号")
_DATE_NAME_KEYS = ("日期", "时间", "date", "datetime", "月份")


def _column_match_keywords(columns, keywords):
    for c in columns:
        cs = str(c)
        sl = cs.lower()
        for k in keywords:
            if k in cs or k in sl:
                return c
    return None


def _pick_sales_column(df: pd.DataFrame):
    num_cols = get_numeric_columns(df)
    for c in num_cols:
        cs = str(c)
        sl = cs.lower()
        for k in _SALES_NAME_KEYS:
            if k in cs or k in sl:
                return c
    skip = {"id", "序号", "编号"}
    for c in num_cols:
        if str(c).lower() in skip or str(c).lower().endswith("_id"):
            continue
        return c
    return None


def _pick_datetime_column(df: pd.DataFrame):
    if "日期" in df.columns:
        return "日期"
    name_hit = _column_match_keywords(df.columns, _DATE_NAME_KEYS)
    if name_hit:
        return name_hit
    for c in df.columns:
        if pd.api.types.is_datetime64_any_dtype(df[c]):
            return c
    return None


def _pick_region_column(df: pd.DataFrame):
    return _column_match_keywords(df.columns, _REGION_NAME_KEYS)


def _pick_order_column(df: pd.DataFrame):
    return _column_match_keywords(df.columns, _ORDER_NAME_KEYS)


def infer_bi_metrics_columns(df: pd.DataFrame) -> dict:
    """从 DataFrame 推断日期 / 销售额类 / 区域类列名，供 GLOBAL_DATA 映射与手动映射预留。"""
    return {
        "date_col": _pick_datetime_column(df),
        "sales_col": _pick_sales_column(df),
        "region_col": _pick_region_column(df),
    }


def compute_bi_dashboard_metrics(
    df: pd.DataFrame,
    date_col: Optional[str] = None,
    sales_col: Optional[str] = None,
    region_col: Optional[str] = None,
) -> dict:
    """
    顶部 KPI 与右侧「省份/区域」排行：基于列名启发式，适配常见销售类 Excel。
    """
    empty = {
        "total_sales": 0.0,
        "mom_growth_pct": None,
        "order_count": 0,
        "warning_count": 0,
        "province_ranking": [],
        "multi_dim_summary": [],
        "meta": {"sales_col": None, "region_col": None, "date_col": None},
    }
    if df is None or df.empty:
        return empty

    if not (sales_col and sales_col in df.columns):
        sales_col = _pick_sales_column(df)
    if not (region_col and region_col in df.columns):
        region_col = _pick_region_column(df)
    if not (date_col and date_col in df.columns):
        date_col = _pick_datetime_column(df)
    order_col = _pick_order_column(df)

    meta = {"sales_col": sales_col, "region_col": region_col, "date_col": date_col}

    total_sales = 0.0
    if sales_col and sales_col in df.columns:
        total_sales = float(pd.to_numeric(df[sales_col], errors="coerce").fillna(0).sum())

    if order_col and order_col in df.columns:
        order_count = int(df[order_col].nunique())
    else:
        order_count = int(len(df))

    mom_growth_pct = None
    if sales_col and date_col and date_col in df.columns:
        dfc = df[[date_col, sales_col]].copy()
        dfc[date_col] = pd.to_datetime(dfc[date_col], errors="coerce")
        dfc[sales_col] = pd.to_numeric(dfc[sales_col], errors="coerce").fillna(0)
        dfc = dfc.dropna(subset=[date_col])
        if not dfc.empty:
            dfc["_m"] = dfc[date_col].dt.to_period("M")
            monthly = dfc.groupby("_m", as_index=False)[sales_col].sum().sort_values("_m")
            if len(monthly) >= 2:
                last = float(monthly.iloc[-1][sales_col])
                prev = float(monthly.iloc[-2][sales_col])
                if abs(prev) > 1e-9:
                    mom_growth_pct = (last - prev) / prev * 100.0

    warning_count = 0
    if sales_col and sales_col in df.columns:
        vals = pd.to_numeric(df[sales_col], errors="coerce")
        warning_count += int((vals < 0).sum())
        valid = vals.dropna()
        if len(valid) >= 5:
            q1 = float(valid.quantile(0.25))
            q3 = float(valid.quantile(0.75))
            iqr = q3 - q1
            if iqr > 1e-9:
                hi = q3 + 2.5 * iqr
                lo = q1 - 2.5 * iqr
                warning_count += int((((vals > hi) | (vals < lo)).fillna(False)).sum())
        if date_col and date_col in df.columns and sales_col in df.columns:
            dfc2 = df[[date_col, sales_col]].copy()
            dfc2[date_col] = pd.to_datetime(dfc2[date_col], errors="coerce")
            dfc2[sales_col] = pd.to_numeric(dfc2[sales_col], errors="coerce").fillna(0)
            dfc2 = dfc2.dropna(subset=[date_col])
            if not dfc2.empty:
                dfc2["_m"] = dfc2[date_col].dt.to_period("M")
                monthly2 = dfc2.groupby("_m")[sales_col].sum().sort_index()
                if len(monthly2) >= 3:
                    ma = monthly2.reset_index()
                    ma.columns = ["_period", "_yval"]
                    if aggregation_has_high_spike(ma, "_yval"):
                        warning_count += 1

    province_ranking = []
    multi_dim_summary: List[dict] = []
    if sales_col and region_col and region_col in df.columns and sales_col in df.columns:
        sub = df[[region_col, sales_col]].copy()
        sub[sales_col] = pd.to_numeric(sub[sales_col], errors="coerce").fillna(0)
        sub[region_col] = sub[region_col].astype(str).str.strip()
        sub = sub[sub[region_col].ne("") & sub[region_col].ne("nan")]
        if not sub.empty:
            agg = sub.groupby(region_col, as_index=False).agg(
                total_sales=(sales_col, "sum"),
                avg_sales=(sales_col, "mean"),
                row_count=(sales_col, "count"),
            ).sort_values("total_sales", ascending=False)
            multi_dim_summary = [
                {
                    "name": str(r[region_col]),
                    "total_sales": float(r["total_sales"]),
                    "avg_sales": float(r["avg_sales"]),
                    "row_count": int(r["row_count"]),
                }
                for _, r in agg.iterrows()
            ]
            top20 = agg.head(20)
            province_ranking = [
                {"name": str(r[region_col]), "sales": float(r["total_sales"])}
                for _, r in top20.iterrows()
            ]

    if mom_growth_pct is not None and pd.isna(mom_growth_pct):
        mom_growth_pct = None

    return {
        "total_sales": total_sales,
        "mom_growth_pct": mom_growth_pct,
        "order_count": order_count,
        "warning_count": int(min(warning_count, 9999)),
        "province_ranking": province_ranking,
        "multi_dim_summary": multi_dim_summary,
        "meta": meta,
    }