"""
生成压力测试用 Excel：输出到项目根目录下 TestData/ 文件夹。

主表 test_main_1000.xlsx、参考表 test_lookup.xlsx。

列名与项目上传/图表下钻一致；生成逻辑见 utils.pressure_mock。
"""
from __future__ import annotations

from pathlib import Path

from utils.pressure_mock import build_lookup_dataframe, build_main_dataframe

ROOT = Path(__file__).resolve().parent
OUTPUT_DIR = ROOT / "TestData"


def main() -> None:
    main_df = build_main_dataframe(1000, seed=42)
    lookup_df = build_lookup_dataframe()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    main_path = OUTPUT_DIR / "test_main_1000.xlsx"
    lookup_path = OUTPUT_DIR / "test_lookup.xlsx"

    main_df.to_excel(main_path, index=False, engine="openpyxl")
    lookup_df.to_excel(lookup_path, index=False, engine="openpyxl")

    print(f"已写入: {main_path}")
    print(f"已写入: {lookup_path}")


if __name__ == "__main__":
    main()
