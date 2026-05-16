# -*- coding: utf-8 -*-
import html as html_lib
import json
from typing import Any, Dict, List, Optional, Tuple, Union

import pandas as pd

from utils.currency_mock import convert_amount, display_symbol

CellSpec = Union[str, Dict[str, Any]]


def _cell_spec(spec: CellSpec) -> Dict[str, Any]:
    if isinstance(spec, str):
        return {"text": spec, "colspan": 1, "rowspan": 1}
    return {
        "text": spec.get("text", ""),
        "colspan": int(spec.get("colspan", 1)),
        "rowspan": int(spec.get("rowspan", 1)),
    }


def extract_leaf_columns(thead_rows: List[List[CellSpec]]) -> List[str]:
    if not thead_rows:
        return []
    last = thead_rows[-1]
    return [_cell_spec(c)["text"] for c in last]


def build_thead_html(thead_rows: List[List[CellSpec]]) -> str:
    parts = []
    for row in thead_rows:
        parts.append("<tr>")
        for c in row:
            cs = _cell_spec(c)
            parts.append(
                f'<th colspan="{cs["colspan"]}" rowspan="{cs["rowspan"]}">'
                f'{html_lib.escape(cs["text"])}</th>'
            )
        parts.append("</tr>")
    return "".join(parts)


def collect_amount_columns(template: Dict[str, Any]) -> set:
    names = set((template.get("currency_columns") or {}).keys())
    names.update(template.get("amount_columns") or [])
    return names


def collect_quantity_columns(template: Dict[str, Any]) -> set:
    return set(template.get("quantity_columns") or [])


# 模板列名 -> 数据中可能出现的别名（匹配不区分大小写）
TEMPLATE_COLUMN_ALIASES: Dict[str, List[str]] = {
    "销售额": ["金额", "Amount", "Price"],
    "销量": ["数量", "Quantity", "Qty"],
    "备注": ["描述", "Description", "Note"],
    "地区": ["区域", "大区", "省份", "省", "城市"],
}


def _norm_col_key(name: Any) -> str:
    return str(name).strip().lower()


def _df_column_index(columns) -> Dict[str, str]:
    """小写列名 -> DataFrame 中实际列名（先到先得）。"""
    idx: Dict[str, str] = {}
    for c in columns:
        k = _norm_col_key(c)
        if k not in idx:
            idx[k] = c
    return idx


def resolve_data_column_for_template_leaf(
    df: pd.DataFrame, template_col: str
) -> Optional[str]:
    """
    若模板叶列 template_col 在 df 中不存在，则按 TEMPLATE_COLUMN_ALIASES 尝试别名。
    返回 df 中存在的源列名；找不到则返回 None。
    """
    tc = str(template_col)
    if tc in df.columns:
        return tc
    idx = _df_column_index(df.columns)
    nk = _norm_col_key(tc)
    if nk in idx:
        return idx[nk]
    for alias in TEMPLATE_COLUMN_ALIASES.get(tc, []):
        ak = _norm_col_key(alias)
        if ak in idx:
            return idx[ak]
    return None


def materialize_leaf_columns_from_aliases(
    df: pd.DataFrame, leaf_cols: List[str]
) -> pd.DataFrame:
    """
    为模板要求的叶列补齐 DataFrame：缺列时从别名列拷贝数据，便于后续币种与渲染统一按模板列名处理。
    """
    work = df.copy()
    for leaf in leaf_cols:
        if leaf in work.columns:
            continue
        src = resolve_data_column_for_template_leaf(df, leaf)
        if src is not None:
            work[leaf] = df[src]
        else:
            work[leaf] = None
    return work


def is_subject_drill_column(col_name: str, template: Dict[str, Any]) -> bool:
    """列名含「科目」或在模板 drill_subject_columns 中声明时，支持穿透到底部原始数据表。"""
    extra = template.get("drill_subject_columns") or []
    if col_name in extra:
        return True
    s = str(col_name)
    return "科目" in s


def _drill_td(col_name: str, display_text: str, raw_value: str) -> str:
    """可点击穿透：data-drill-column / data-drill-value 供前端筛选原始数据。"""
    col_esc = html_lib.escape(col_name, quote=True)
    val_esc = html_lib.escape(raw_value.strip(), quote=True)
    txt = html_lib.escape(display_text)
    return (
        f'<td class="td-text smart-drill-cell" data-drill-column={col_esc} '
        f"data-drill-value={val_esc} "
        f'title="点击查看原始数据中该科目的明细">'
        f"{txt}</td>"
    )


def format_cell_for_table(
    val: Any,
    col_name: str,
    template: Dict[str, Any],
    target_ccy: str,
    display_ccy: str,
) -> str:

    """单元格 HTML（含 td），金额列右对齐+符号+千分位；数量列右对齐。"""
    tgt = (target_ccy or "CNY").upper()
    dpy = (display_ccy or tgt).upper()
    amounts = collect_amount_columns(template)
    quantities = collect_quantity_columns(template)

    if val is None or (isinstance(val, float) and pd.isna(val)):
        return '<td class="td-empty"></td>'
    if isinstance(val, (dict, list)):
        dumped = json.dumps(val, ensure_ascii=False, indent=2)
        inner = f'<pre class="json-cell">{html_lib.escape(dumped)}</pre>'
        return f'<td class="td-json">{inner}</td>'
    if isinstance(val, bool):
        return f'<td class="td-text">{"是" if val else "否"}</td>'

    if hasattr(val, "item"):
        try:
            val = val.item()
        except Exception:
            pass

    # 科目穿透：优先于金额/数量解析（支持文本或数字型科目编码）
    if is_subject_drill_column(col_name, template):
        raw_str = "" if val is None or (isinstance(val, float) and pd.isna(val)) else str(val).strip()
        if not raw_str:
            return '<td class="td-empty"></td>'
        return _drill_td(col_name, raw_str, raw_str)

    try:
        num = float(val)
    except (TypeError, ValueError):
        return f'<td class="td-text">{html_lib.escape(str(val))}</td>'

    if col_name in amounts:
        conv = convert_amount(num, tgt, dpy)
        sym = display_symbol(dpy)
        txt = f"{sym}{conv:,.2f}"
        return f'<td class="td-money">{html_lib.escape(txt)}</td>'

    if col_name in quantities:
        if abs(num - round(num)) < 1e-9:
            fmt = f"{int(round(num)):,.0f}"
        else:
            fmt = f"{num:,.2f}"
        return f'<td class="td-num">{html_lib.escape(fmt)}</td>'

    if abs(num - round(num)) < 1e-9:
        return f'<td class="td-num">{int(round(num)):,.0f}</td>'
    return f'<td class="td-num">{num:,.2f}</td>'


def resolve_leaf_columns(df: pd.DataFrame, template: Dict[str, Any]) -> List[str]:
    thead_rows = template.get("thead") or []
    leaf_cols = template.get("column_order") or extract_leaf_columns(thead_rows)
    if not leaf_cols:
        leaf_cols = [c for c in df.columns if str(c) != "_currency_note"]
    return leaf_cols


def compute_visible_leaves(
    template: Dict[str, Any],
    df: pd.DataFrame,
    column_visibility: Optional[Dict[str, bool]],
) -> List[str]:
    """
    根据前置 column_visibility（列名 -> 是否显示）得到最终可见叶列顺序。
    未出现的列默认 True；若全部被勾掉则回退为全列避免空白表。
    """
    full = resolve_leaf_columns(df, template)

    def is_on(col: str) -> bool:
        if column_visibility is None or len(column_visibility) == 0:
            return True
        return bool(column_visibility.get(col, True))

    tree = template.get("column_tree")
    if tree:
        out: List[str] = []
        for grp in tree:
            for ch in grp.get("children") or []:
                col = ch.get("column")
                if col and is_on(col):
                    out.append(col)
        return out if out else full

    out = [c for c in full if is_on(c)]
    return out if out else full


def build_thead_html_from_column_tree(
    column_tree: List[Dict[str, Any]],
    visible_ordered_leaves: List[str],
) -> str:
    """按分组生成多级表头；支持分组上的 rowspan_leaf（单列表头上下合并）。"""
    visible_set = set(visible_ordered_leaves)
    row0: List[str] = []
    row1: List[str] = []

    for grp in column_tree:
        raw_children = grp.get("children") or []
        children_ordered: List[Dict[str, Any]] = []
        for col in visible_ordered_leaves:
            for ch in raw_children:
                if ch.get("column") == col:
                    children_ordered.append(ch)
                    break
        children_ordered = [ch for ch in children_ordered if ch.get("column") in visible_set]
        if not children_ordered:
            continue

        label = grp.get("label", grp.get("id", ""))
        if grp.get("rowspan_leaf") and len(children_ordered) == 1:
            ch = children_ordered[0]
            txt = ch.get("label", ch.get("column", ""))
            row0.append(
                '<th class="hierarchical-th hierarchical-th--group hierarchical-th--rowspan" '
                f'rowspan="2">{html_lib.escape(str(txt))}</th>'
            )
            continue

        row0.append(
            f'<th class="hierarchical-th hierarchical-th--group" colspan="{len(children_ordered)}">'
            f"{html_lib.escape(str(label))}</th>"
        )
        for ch in children_ordered:
            lab = ch.get("label", ch.get("column", ""))
            row1.append(
                f'<th class="hierarchical-th hierarchical-th--leaf">{html_lib.escape(str(lab))}</th>'
            )

    if row1:
        return f"<tr>{''.join(row0)}</tr><tr>{''.join(row1)}</tr>"
    return f"<tr>{''.join(row0)}</tr>"


def apply_currency_only(
    df: pd.DataFrame,
    template: Dict[str, Any],
    leaf_cols: Optional[List[str]] = None,
) -> pd.DataFrame:
    """Apply template currency rules only (numeric columns); keeps dtypes suitable for insights."""
    if leaf_cols is None:
        leaf_cols = resolve_leaf_columns(df, template)
    target_ccy = (template.get("target_ccy") or "CNY").upper()
    currency_map = template.get("currency_columns") or {}
    work = materialize_leaf_columns_from_aliases(df, leaf_cols)
    for col in leaf_cols:
        if col in currency_map:
            work[col] = work[col].apply(
                lambda v, c=col: apply_currency_to_value(
                    v, c, currency_map, target_ccy
                )
            )
    return work


def _format_dates_for_display(work: pd.DataFrame, leaf_cols: List[str]) -> pd.DataFrame:
    out = work.copy()
    for col in leaf_cols:
        if col not in out.columns:
            continue
        if pd.api.types.is_datetime64_any_dtype(out[col]):
            out[col] = out[col].dt.strftime("%Y-%m-%d")
        elif col in ("日期",) or "日期" in str(col):
            try:
                dt = pd.to_datetime(out[col], errors="coerce")
                if dt.notna().any():
                    out[col] = dt.dt.strftime("%Y-%m-%d")
            except Exception:
                pass
    return out


def apply_currency_to_value(
    val: Any,
    col_name: str,
    currency_map: Optional[Dict[str, Any]],
    target_ccy: str,
):
    """
    currency_map example:
      {"销售额": {"from": "USD", "to": "CNY"}, ...}
    or shorthand per-column source currency:
      {"销售额": "USD"}  => to target_ccy
    """
    if currency_map is None or col_name not in currency_map:
        return val
    rule = currency_map[col_name]
    if isinstance(rule, str):
        from_ccy, to_ccy = rule, target_ccy
    else:
        from_ccy = rule.get("from", "CNY")
        to_ccy = rule.get("to", target_ccy)
    if isinstance(val, (dict, list)):
        return val
    try:
        num = float(val)
    except (TypeError, ValueError):
        return val
    return convert_amount(num, from_ccy, to_ccy)


def render_smart_table_html(
    df: pd.DataFrame,
    template: Dict[str, Any],
    max_rows: int = 200,
    column_visibility: Optional[Dict[str, bool]] = None,
    display_currency: Optional[str] = None,
) -> str:
    """
    template keys:
      thead: [[cell specs], ...]  — multi-row header
      column_tree: 可选，用于分组表头；与 column_visibility 联动过滤列
      target_ccy: str (default CNY)
      currency_columns: optional column -> from CCY or {from,to}
      column_order: optional override leaf order (defaults to thead last row)

    column_visibility: 列名 -> 是否显示；未列出的列默认显示。
    display_currency: 全局展示币种（与模板 target_ccy 不同则按 mock 汇率折算）。
    叶列若不在数据中，会按 TEMPLATE_COLUMN_ALIASES 尝试别名（如 销售额→金额/Amount/Price）。
    """
    thead_rows = template.get("thead") or []
    leaf_cols = compute_visible_leaves(template, df, column_visibility)
    column_tree = template.get("column_tree")
    target_ccy = (template.get("target_ccy") or "CNY").upper()
    display_ccy = (display_currency or target_ccy).upper()
    currency_map = template.get("currency_columns") or {}

    work = apply_currency_only(df, template, leaf_cols)
    work = _format_dates_for_display(work, leaf_cols)

    if column_tree:
        thead_html = build_thead_html_from_column_tree(column_tree, leaf_cols)
    else:
        thead_html = build_thead_html(thead_rows) if thead_rows else ""
        if not thead_html:
            thead_html = "<tr>" + "".join(
                f'<th class="hierarchical-th hierarchical-th--leaf">{html_lib.escape(c)}</th>'
                for c in leaf_cols
            ) + "</tr>"

    body_parts = []
    subset = work.head(max_rows)
    render_row_count = len(subset)
    for row_idx, row in subset.iterrows():
        body_parts.append("<tr>")
        for col in leaf_cols:
            val = row[col] if col in row.index else None
            body_parts.append(
                format_cell_for_table(val, col, template, target_ccy, display_ccy)
            )
        body_parts.append("</tr>")

    note = template.get("footnote_html") or ""
    sym = display_symbol(display_ccy)
    note = (
        f'<div class="table-footnote">展示币种：<strong>{display_ccy}</strong> ({sym}) · '
        f"模板折算基准：<strong>{target_ccy}</strong>（mock 汇率桥接折算）</div>"
    ) + note

    return f"""
<table class="data-table hierarchical-table finance-table">
<thead>{thead_html}</thead>
<tbody>{"".join(body_parts)}</tbody>
</table>
{note}
"""


def list_report_templates(templates_dir: str) -> List[Dict[str, str]]:
    import os

    out = []
    if not os.path.isdir(templates_dir):
        return out
    for name in sorted(os.listdir(templates_dir)):
        if not name.endswith(".json"):
            continue
        path = os.path.join(templates_dir, name)
        try:
            with open(path, "r", encoding="utf-8") as f:
                meta = json.load(f)
            out.append(
                {
                    "id": meta.get("id", name[:-5]),
                    "name": meta.get("name", name),
                    "description": meta.get("description", ""),
                    "file": name,
                }
            )
        except Exception:
            continue
    return out


def load_template(path: str) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


# ----- 日期列规范化与多维日期筛选（仪表盘 filter_config） -----


def resolve_date_column_name(df: pd.DataFrame) -> Optional[str]:
    """优先「日期」列，否则取列名含「日期」的第一列。"""
    if df is None or df.empty:
        return None
    if "日期" in df.columns:
        return "日期"
    for c in df.columns:
        if "日期" in str(c):
            return str(c)
    return None


def ensure_datetime_date_column(
    df: pd.DataFrame, date_col: Optional[str] = None
) -> pd.DataFrame:
    """将主日期列转为 datetime64，便于 dt.weekday / 区间切片。"""
    if df is None or df.empty:
        return df
    out = df.copy()
    col = date_col or resolve_date_column_name(out)
    if col is None or col not in out.columns:
        return out
    out[col] = pd.to_datetime(out[col], errors="coerce").dt.tz_localize(None)
    return out


def apply_date_feature_filter(
    df: pd.DataFrame,
    filter_config: Optional[Dict[str, Any]],
    date_col: Optional[str] = None,
) -> Tuple[pd.DataFrame, Dict[str, Any]]:
    """
    按 filter_config 过滤行（AND）。支持：
      - weekdays / weekday: 0=周一 … 6=周日（与 pandas Series.dt.weekday 一致）
      - date_range: { start|from, end|to } 字符串，含端点（按日历日）
      - dates: 指定日期列表（与行日期「日历日」匹配）

    若 weekdays 含全部 7 天或未传，则不按星期过滤。
    若无可用日期列，返回原表副本。
    """
    meta: Dict[str, Any] = {
        "applied": False,
        "date_column": None,
        "row_before": len(df) if df is not None else 0,
        "row_after": len(df) if df is not None else 0,
    }
    if df is None or df.empty or not filter_config:
        meta["row_after"] = len(df) if df is not None else 0
        return df.copy() if df is not None else pd.DataFrame(), meta

    col = date_col or resolve_date_column_name(df)
    if col is None:
        return df.copy(), meta

    work = ensure_datetime_date_column(df, col)
    meta["date_column"] = col
    sub = work[work[col].notna()].copy()
    meta["row_before"] = len(sub)

    weekdays = filter_config.get("weekdays")
    if weekdays is None:
        weekdays = filter_config.get("weekday")
    if isinstance(weekdays, (list, tuple)):
        ws_set: set = set()
        for x in weekdays:
            if x is None or (isinstance(x, str) and not str(x).strip()):
                continue
            try:
                ws_set.add(int(x))
            except (TypeError, ValueError):
                continue
        ws = sorted(ws_set)
        if ws and len(ws) < 7:
            sub = sub[sub[col].dt.weekday.isin(ws)]
            meta["applied"] = True

    dr = filter_config.get("date_range") or {}
    start_raw = dr.get("start") or dr.get("from")
    end_raw = dr.get("end") or dr.get("to")
    if start_raw:
        start_dt = pd.to_datetime(start_raw, errors="coerce")
        if pd.notna(start_dt):
            sub = sub[sub[col] >= start_dt.normalize()]
            meta["applied"] = True
    if end_raw:
        end_dt = pd.to_datetime(end_raw, errors="coerce")
        if pd.notna(end_dt):
            end_day = end_dt.normalize() + pd.Timedelta(days=1)
            sub = sub[sub[col] < end_day]
            meta["applied"] = True

    dates_list = filter_config.get("dates")
    if isinstance(dates_list, (list, tuple)) and len(dates_list) > 0:
        want = pd.to_datetime(pd.Series(list(dates_list)), errors="coerce").dropna()
        if len(want) > 0:
            want_norm = pd.DatetimeIndex(want.dt.normalize().unique())
            sub = sub[sub[col].dt.normalize().isin(want_norm)]
            meta["applied"] = True

    meta["row_after"] = len(sub)
    return sub, meta


def apply_category_dimension_filter(
    df: pd.DataFrame,
    column: Optional[str],
    value: Any,
) -> Tuple[pd.DataFrame, Dict[str, Any]]:
    """
    按图表 X 轴分类列与点击取值过滤行（在日期特征过滤之后使用）。
    value 与单元格比较：优先直接相等；若无匹配则尝试字符串化后比较；
    日期列则对两侧做 to_datetime 再比日历日。
    """
    meta: Dict[str, Any] = {
        "applied": False,
        "column": column,
        "value_repr": None,
        "row_before": len(df) if df is not None else 0,
        "row_after": 0,
    }
    if df is None or df.empty or not column or str(column).strip() == "":
        meta["row_after"] = len(df) if df is not None else 0
        return df.copy() if df is not None else pd.DataFrame(), meta
    if column not in df.columns:
        meta["row_after"] = len(df)
        return df.copy(), meta

    meta["row_before"] = len(df)
    meta["value_repr"] = value

    ser = df[column]
    mask = pd.Series(False, index=df.index)

    if pd.api.types.is_datetime64_any_dtype(ser):
        left = pd.to_datetime(ser, errors="coerce")
        right = pd.to_datetime(value, errors="coerce")
        if pd.notna(right):
            rnorm = right.normalize() if hasattr(right, "normalize") else right
            mask = left.dt.normalize() == rnorm
        else:
            mask = ser == value
    else:
        mask = ser == value
        if not bool(mask.any()):
            try:
                mask = ser.astype(str) == ("" if value is None else str(value))
            except Exception:
                mask = pd.Series(False, index=df.index)

    out = df.loc[mask].copy()
    meta["applied"] = bool(mask.any())
    meta["row_after"] = len(out)
    return out, meta
