# PythonAnywhere 部署（无需银行卡）

适合没有 Visa/国际信用卡、无法通过 Render 验证的情况。

- 免费地址：`https://你的用户名.pythonanywhere.com`
- 费用：**$0**，不用绑卡
- 缺点：免费 Web App 约 **每月** 要在 Web 页点一次 **Run until 1 month from today** 续期；性能一般，但作品集 Demo 够用

---

## 第 1 步：注册

1. 打开 [pythonanywhere.com](https://www.pythonanywhere.com)
2. 点 **Pricing** → 选 **Beginner**（免费）
3. 注册账号（邮箱即可，无需银行卡）

记住你的 **用户名**，网址会是 `https://用户名.pythonanywhere.com`。

---

## 第 2 步：把代码弄到服务器上

登录后打开 **Consoles** → **$ Bash**（新开一个 Bash 控制台）。

在控制台执行（把 `YOUR_USERNAME` 换成你的用户名）：

```bash
cd ~
git clone https://github.com/dooorr/smart-data-report.git
cd smart-data-report
```

如果仓库是私有的，先在 **Account** → **API token** 生成 token，或用 GitHub 方式拉取。

安装依赖（免费账号只有 **Python 3.10**，不能用 `requirements.txt` 里的 pandas 3.x）：

```bash
pip3.10 install --user -r requirements-py310.txt
```

若仓库里还没有 `requirements-py310.txt`，可手动安装：

```bash
pip3.10 install --user Flask==3.1.3 flask-cors openpyxl pandas==2.3.3 "numpy>=2.0,<3" plotly reportlab matplotlib flask-login
```

安装可能要 5～10 分钟（pandas、plotly 比较大），等它跑完。

---

## 第 3 步：创建 Web App

1. 顶部菜单 **Web** → **Add a new web app**
2. 选 **Manual configuration**（手动配置，不要选 Quickstart 默认 Flask）
3. Python 版本选 **3.10**
4. 创建完成后进入 Web 配置页

---

## 第 4 步：配置 WSGI

在 Web 页面找到 **Code** 区域的 **WSGI configuration file** 链接，点开。

**删掉文件里全部内容**，换成下面这段（只改 `YOUR_USERNAME`）：

```python
import os
import sys

PROJECT_DIR = "/home/YOUR_USERNAME/smart-data-report"
if PROJECT_DIR not in sys.path:
    sys.path.insert(0, PROJECT_DIR)

os.chdir(PROJECT_DIR)
os.environ["FLASK_SECRET_KEY"] = "这里填一串随机长字符串"

from app import app as application
```

保存（页面右上角 **Save**）。

---

## 第 5 步：设置虚拟环境路径（重要）

回到 **Web** 配置页，找到 **Virtualenv**：

填入（用户名改成你的）：

```
/home/YOUR_USERNAME/.local
```

或者如果上面不行，在 Bash 里执行 `which python3.10`，把路径填进去。

---

## 第 6 步：静态文件（可选，加载更快）

在 Web 页 **Static files** 添加：

| URL | Directory |
|-----|-----------|
| `/static/` | `/home/YOUR_USERNAME/smart-data-report/static` |

---

## 第 7 步：启动

1. Web 页顶部绿色按钮 **Reload 你的用户名.pythonanywhere.com**
2. 浏览器打开 `https://你的用户名.pythonanywhere.com/health`
   - 应看到：`{"status":"ok"}`
3. 打开首页 → 注册 → 登录 → 生成演示数据

---

## 每月续一次（免费账户）

免费 Web App 会定期过期（Web 页会显示 **Best before date**）。到期前点黄色按钮 **Run until 1 month from today** 即可再续 1 个月。

---

## 常见问题

**Q：pip 安装报错 / 内存不足？**  
A：分批安装：`pip3.10 install --user Flask flask-login pandas` 再装其余包。

**Q：打开网站 500 Error？**  
A：Web 页点 **Error log** 看最后一行报错；常见是路径写错或依赖没装全。

**Q：PDF 导出中文方框？**  
A：免费版可忽略；或上传字体到 `fonts/` 目录。

**Q：和 Render 比哪个好？**  
A：Render 体验更好但要卡；PythonAnywhere 不要卡，适合国内学生 Demo。

---

## 简历怎么写

```
在线 Demo：https://dooorr.pythonanywhere.com
开源代码：https://github.com/dooorr/smart-data-report
```
