# 公网部署指南（无需购买域名）

平台会免费赠送子域名，例如：

- Render：`https://smart-data-report.onrender.com`
- Railway：`https://smart-data-report.up.railway.app`

**不需要买域名。** 简历里直接写这个免费链接即可。

---

## 推荐：Render 免费套餐（约 10 分钟）

### 前提

- GitHub 仓库已推送最新代码（含 `Procfile`、`render.yaml`、`requirements.txt`）
- 注册 [render.com](https://render.com)（可用 GitHub 登录）

### 方式 A：Blueprint 一键部署

1. Render 控制台 → **New** → **Blueprint**
2. 连接 GitHub 仓库 `dooorr/smart-data-report`
3. Render 会读取根目录 `render.yaml`，自动创建 Web Service
4. 环境变量 `FLASK_SECRET_KEY` 会自动生成（也可手动改成长随机串）
5. 点击 **Apply**，等待 Build + Deploy（首次约 5～10 分钟）
6. 部署成功后访问：`https://<你的服务名>.onrender.com`

### 方式 B：手动创建 Web Service

1. **New** → **Web Service** → 选仓库
2. 配置：
   - **Runtime**: Python 3
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `gunicorn app:app --bind 0.0.0.0:$PORT --workers 2 --threads 4 --timeout 120`
   - **Health Check Path**: `/health`
3. **Environment** 添加：
   - `FLASK_SECRET_KEY` = 随机长字符串（可用 [randomkeygen.com](https://randomkeygen.com/) 生成）
4. **Create Web Service**

### 免费套餐注意

| 现象 | 说明 |
|------|------|
| 冷启动慢 | 15 分钟无访问会休眠，再次打开需等 30～60 秒 |
| 数据不持久 | 免费实例磁盘是临时的，**重新部署后用户账号与上传数据会丢失**（演示够用） |
| HTTPS 自动 | 平台自带证书，无需配置 |

若要长期保留用户数据，需升级付费并挂载持久化磁盘，或改用外部数据库（PostgreSQL 等）。作品集 Demo 用免费版即可。

---

## 备选：Railway

1. 注册 [railway.app](https://railway.app)，用 GitHub 登录
2. **New Project** → **Deploy from GitHub repo** → 选本仓库
3. Railway 自动检测 Python；若无启动命令，在 Settings → Deploy 设置：
   ```
   gunicorn app:app --bind 0.0.0.0:$PORT --workers 2 --threads 4 --timeout 120
   ```
4. Variables 添加 `FLASK_SECRET_KEY`
5. Settings → Networking → **Generate Domain**，得到 `*.up.railway.app` 地址

Railway 免费额度按月计费，用完需绑卡或暂停；Render 免费层更适合长期挂 Demo。

---

## 部署后自测清单

1. 打开 `https://你的地址/health` → 应返回 `{"status":"ok"}`
2. 打开首页 → 跳转登录页
3. 注册新账号 → 登录成功
4. 侧栏「生成内置测试数据」→ 拖拽图表 → 导出 Excel

---

## 简历怎么写

```
项目成果：在线 Demo https://smart-data-report.onrender.com
         （Flask + Gunicorn 部署于 Render，HTTPS + 多用户认证）
```

把 URL 换成你实际的子域名即可。

---

## 常见问题

**Q：要买域名吗？**  
A：不用。免费子域名完全够简历和面试演示。

**Q：域名以后想自定义怎么办？**  
A：可在 Render 绑定自己买的域名（可选，几十元/年），不是必需。

**Q：部署失败 Build Error？**  
A：看日志是否 Python 版本 < 3.10；`runtime.txt` 已指定 3.11.9。

**Q：登录后刷新又退出了？**  
A：检查 `FLASK_SECRET_KEY` 是否已设置且部署后未频繁变更。
