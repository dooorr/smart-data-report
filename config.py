# 基础配置
import os

# 项目根路径
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# 上传文件存储路径
UPLOAD_FOLDER = os.path.join(BASE_DIR, 'uploads')
# 允许上传的文件类型
ALLOWED_EXTENSIONS = {'csv', 'xlsx'}
# Flask密钥
SECRET_KEY = 'smart_report_tool_2025'