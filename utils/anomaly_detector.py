import pandas as pd
import numpy as np
import re

class AnomalyDetector:
    """智能图表异常数据检测器"""
    
    def __init__(self):
        self.anomaly_report = {
            'null_count': 0,
            'null_rows': [],
            'extreme_values': [],
            'negative_values': [],
            'invalid_chars': [],
            'duplicate_dimensions': [],
            'total_anomalies': 0,
            'summary': ''
        }
    
    def detect_null_values(self, df):
        """检测空值类异常"""
        null_count = df.isnull().sum().sum()
        self.anomaly_report['null_count'] = null_count
        
        if null_count > 0:
            null_rows = []
            for idx, row in df.iterrows():
                if row.isnull().any():
                    null_rows.append({
                        'row_index': idx,
                        'columns': [col for col in df.columns if pd.isnull(row[col])]
                    })
            self.anomaly_report['null_rows'] = null_rows[:20]  # 限制数量
    
    def detect_extreme_values(self, df, columns=None):
        """检测极值类异常（使用3倍标准差方法，减少误报）"""
        if columns is None:
            columns = df.select_dtypes(include=[np.number]).columns
        
        extreme_values = []
        for col in columns:
            if col not in df.columns:
                continue
                
            series = df[col].dropna()
            if len(series) < 10:  # 至少需要10个数据点才能计算标准差
                continue
                
            try:
                values = series.astype(float)
                mean = values.mean()
                std = values.std()
                
                # 使用3倍标准差作为阈值
                lower_bound = mean - 3 * std
                upper_bound = mean + 3 * std
                
                # 检测超出范围的值
                for idx, val in values.items():
                    if val < lower_bound or val > upper_bound:
                        extreme_values.append({
                            'row_index': idx,
                            'column': col,
                            'value': val,
                            'type': 'low' if val < lower_bound else 'high',
                            'bound': {'lower': lower_bound, 'upper': upper_bound},
                            'z_score': abs((val - mean) / std)
                        })
            except:
                continue
        
        # 按z-score排序，只保留最极端的20个
        extreme_values.sort(key=lambda x: x.get('z_score', 0), reverse=True)
        self.anomaly_report['extreme_values'] = extreme_values[:20]
    
    def detect_negative_values(self, df, positive_columns=None):
        """
        智能检测负数异常：根据字段名识别优先级最高
        - 允许负数的字段（同比、增长率、变化率、差异、盈亏等）：负数属于正常业务数据，不标记为异常
        - 不允许负数的字段（销售额、收入、订单数、库存、金额、数量等）：出现负数时判定为异常
        - 不确定类型的字段（备注、编码、日期等）：不做负数异常检测，仅做空值、乱码校验
        """
        # 允许负数的字段关键词（业务指标类）
        allow_negative_keywords = [
            '同比', '环比', '增长', '变化', '差异', '差额', '涨跌',
            '盈亏', '亏损', '利润', '收益率', '回报率', '率',
            '百分比', '%', '占比', '比例', '指数', '系数'
        ]
        
        # 不允许负数的字段关键词（数量金额类）
        positive_only_keywords = [
            '收入', '金额', '数量', '资产', '成本', '营收', '销售',
            '采购', '预算', '实际', '总计', '合计', '总额', '净额',
            '订单', '库存', '存货', '余额', '资金', '现金', '存款',
            '应收', '应付', '预收', '预付', '投资', '借款', '负债',
            '费用', '支出', '成本', '价值', '价格', '费用', '税费',
            '股本', '资本', '公积', '盈余', '利息', '股息', '分红'
        ]
        
        # 不确定类型的字段关键词（不做负数检测）
        uncertain_keywords = [
            '备注', '说明', '描述', '摘要', '编码', '编号', '代码',
            '日期', '时间', '时间戳', '序号', 'ID', 'key', 'uuid',
            '名称', '简称', '全称', '类别', '类型', '状态', '等级',
            '地区', '城市', '省份', '国家', '地址', '部门', '人员',
            '客户', '供应商', '产品', '商品', '项目', '合同', '订单号'
        ]
        
        negative_values = []
        
        for col in df.columns:
            col_name = str(col).lower()
            
            # 跳过不确定类型的字段（备注、编码、日期等）
            if any(kw in col_name for kw in uncertain_keywords):
                continue
                
            # 跳过允许负数的字段（同比、增长率等）
            if any(kw in col_name for kw in allow_negative_keywords):
                continue
                
            # 只对不允许负数的字段进行检测
            if positive_columns is not None:
                if col not in positive_columns:
                    continue
            else:
                # 自动识别正向指标
                if not any(kw in col_name for kw in positive_only_keywords):
                    continue
            
            # 执行负数检测
            series = df[col].dropna()
            try:
                values = series.astype(float)
                negatives = values[values < 0]
                for idx, val in negatives.items():
                    negative_values.append({
                        'row_index': idx,
                        'column': col,
                        'value': val
                    })
            except:
                continue
        
        self.anomaly_report['negative_values'] = negative_values[:20]
    
    def detect_invalid_chars(self, df):
        """检测乱码、特殊符号等非法数据"""
        invalid_chars = []
        str_columns = df.select_dtypes(include=['object']).columns
        
        for col in str_columns:
            for idx, val in df[col].items():
                if pd.isna(val):
                    continue
                    
                val_str = str(val)
                # 检测乱码和特殊符号
                if len(val_str) > 0:
                    # 统计不可打印字符比例
                    non_printable = sum(1 for c in val_str if not c.isprintable())
                    if non_printable > len(val_str) * 0.3:
                        invalid_chars.append({
                            'row_index': idx,
                            'column': col,
                            'value': val_str[:50] + '...' if len(val_str) > 50 else val_str,
                            'type': 'unprintable'
                        })
                    
                    # 检测无意义字符模式
                    if re.search(r'[\x00-\x1f\x7f-\xff]', val_str):
                        invalid_chars.append({
                            'row_index': idx,
                            'column': col,
                            'value': val_str[:50] + '...' if len(val_str) > 50 else val_str,
                            'type': 'control_char'
                        })
        
        self.anomaly_report['invalid_chars'] = invalid_chars[:20]
    
    def detect_duplicate_dimensions(self, df, dimension_columns=None):
        """检测重复维度"""
        if dimension_columns is None:
            dimension_keywords = ['日期', '时间', '序号', '编号', '代码', '名称', '类别']
            dimension_columns = [col for col in df.columns 
                               if any(kw in str(col) for kw in dimension_keywords)]
        
        for col in dimension_columns:
            if col not in df.columns:
                continue
                
            duplicates = df[df.duplicated(col, keep=False)]
            if not duplicates.empty:
                for idx, row in duplicates.iterrows():
                    self.anomaly_report['duplicate_dimensions'].append({
                        'row_index': idx,
                        'column': col,
                        'value': row[col]
                    })
        
        self.anomaly_report['duplicate_dimensions'] = self.anomaly_report['duplicate_dimensions'][:20]
    
    def detect_all(self, df):
        """执行所有异常检测"""
        self.detect_null_values(df)
        self.detect_extreme_values(df)
        self.detect_negative_values(df)
        self.detect_invalid_chars(df)
        self.detect_duplicate_dimensions(df)
        
        # 计算总异常数
        total = (len(self.anomaly_report['null_rows']) +
                 len(self.anomaly_report['extreme_values']) +
                 len(self.anomaly_report['negative_values']) +
                 len(self.anomaly_report['invalid_chars']) +
                 len(self.anomaly_report['duplicate_dimensions']))
        self.anomaly_report['total_anomalies'] = total
        
        # 生成摘要
        self._generate_summary()
        
        return self.anomaly_report
    
    def _generate_summary(self):
        """生成异常摘要"""
        parts = []
        
        if self.anomaly_report['null_count'] > 0:
            parts.append(f"空值 {self.anomaly_report['null_count']} 个")
        
        if self.anomaly_report['extreme_values']:
            parts.append(f"极值 {len(self.anomaly_report['extreme_values'])} 个")
        
        if self.anomaly_report['negative_values']:
            parts.append(f"负数异常 {len(self.anomaly_report['negative_values'])} 个")
        
        if self.anomaly_report['invalid_chars']:
            parts.append(f"非法字符 {len(self.anomaly_report['invalid_chars'])} 个")
        
        if self.anomaly_report['duplicate_dimensions']:
            parts.append(f"重复维度 {len(self.anomaly_report['duplicate_dimensions'])} 个")
        
        if parts:
            self.anomaly_report['summary'] = "检测到异常数据: " + "、".join(parts)
        else:
            self.anomaly_report['summary'] = "数据正常，未检测到异常"
    
    def get_anomaly_summary(self):
        """获取异常摘要"""
        return self.anomaly_report['summary']
    
    def has_anomalies(self):
        """判断是否存在异常"""
        return self.anomaly_report['total_anomalies'] > 0


def detect_anomalies(df):
    """便捷函数：检测数据中的异常"""
    detector = AnomalyDetector()
    return detector.detect_all(df)


def clean_and_prepare_data(df, chart_type, x_col, y_cols):
    """
    清理并准备数据用于图表生成
    返回：(清理后的数据, 异常报告)
    """
    df_clean = df.copy()
    anomaly_report = detect_anomalies(df_clean)
    
    # 处理空值：折线图断点，柱状图留空
    for y in y_cols:
        if y not in df_clean.columns:
            continue
        
        if chart_type in ['line', 'area', 'scatter']:
            # 折线图：保留NaN实现断点效果
            pass
        elif chart_type in ['bar']:
            # 柱状图：空值设为None
            df_clean[y] = df_clean[y].apply(lambda x: None if pd.isna(x) else x)
        elif chart_type == 'pie':
            # 饼图：删除空值行
            df_clean = df_clean.dropna(subset=[y])
    
    return df_clean, anomaly_report
