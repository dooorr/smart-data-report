"""
内置压力/演示用主表与参考表生成（与上传列名、VLOOKUP 联调场景一致）。

原逻辑自项目根目录 `generate_mock_data.py` 迁入，供 CLI 写盘与 HTTP 接口写会话复用。
"""
from __future__ import annotations

import random
from datetime import date, timedelta
from typing import Any, Dict, List

import pandas as pd

PRODUCT_TYPES = ["电子产品", "家居用品", "办公用品"]
REGIONS = ["华东", "华北", "华南", "西南", "西北", "东北", "华中"]

LOOKUP_ROWS: List[Dict[str, Any]] = [
    {
        "产品类型": "电子产品",
        "负责人": "张明",
        "售后政策": "7天无理由退换，整机保修1年",
        "标准单价": 128.5,
    },
    {
        "产品类型": "家居用品",
        "负责人": "李华",
        "售后政策": "30天质量问题换货，大件上门安装",
        "标准单价": 86.0,
    },
    {
        "产品类型": "办公用品",
        "负责人": "王芳",
        "售后政策": "15天质量问题退换，耗材不在保修范围",
        "标准单价": 15.75,
    },
]


def random_date_2025(rng: random.Random) -> date:
    start = date(2025, 1, 1)
    end = date(2025, 12, 31)
    delta = (end - start).days
    return start + timedelta(days=rng.randint(0, delta))


def build_main_dataframe(n_rows: int = 1000, seed: int = 42) -> pd.DataFrame:
    rng = random.Random(seed)
    rows = []
    for _ in range(n_rows):
        sales = round(rng.uniform(500, 50000), 2)
        cost = round(sales * rng.uniform(0.35, 0.82), 2)
        qty = rng.randint(10, 500)
        rows.append(
            {
                "日期": random_date_2025(rng),
                "区域": rng.choice(REGIONS),
                "产品类型": rng.choice(PRODUCT_TYPES),
                "销售额": sales,
                "成本": cost,
                "销量": qty,
            }
        )
    df = pd.DataFrame(rows)
    return df[["日期", "区域", "产品类型", "销售额", "成本", "销量"]]


def build_lookup_dataframe() -> pd.DataFrame:
    return pd.DataFrame(LOOKUP_ROWS)
