import pandas as pd
import numpy as np

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in {'xlsx', 'xls', 'csv'}

def read_excel_or_csv(file_path):
    """读取 Excel 或 CSV 文件，自动识别格式"""
    try:
        if file_path.endswith('.csv'):
            return pd.read_csv(file_path)
        else:
            return pd.read_excel(file_path)
    except Exception as e:
        raise ValueError(f"文件读取失败：{str(e)}")

def handle_null_values(df):
    """处理空值：数值列用0填充，字符串列用空字符串填充"""
    # 数值列
    num_cols = df.select_dtypes(include=[np.number]).columns
    df[num_cols] = df[num_cols].fillna(0)
    # 字符串列
    str_cols = df.select_dtypes(include=['object']).columns
    df[str_cols] = df[str_cols].fillna('')
    return df

def get_all_columns(df):
    """获取所有列名"""
    return df.columns.tolist()

def get_numeric_columns(df):
    """获取数值类型列名（用于Y轴）"""
    return df.select_dtypes(include=[np.number]).columns.tolist()