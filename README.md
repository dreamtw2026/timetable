# 📚 课程表 (my-timetable)

基于 **Cloudflare Workers + KV** 的轻量级大学课程表应用：课表展示页 + 后台管理页 + 课程 CRUD API，全部跑在一个 Worker 上，无需服务器、无需数据库。

---

## ✨ 功能特性

- 🗓️ **周次支持**：课程可配置上课周次（如 `1-16`、`5`、`1-8,10-16`），同一时段的单双周课在同一格堆叠展示，非本周课程自动弱化
- 📍 **当前周推算**：后台设置开学日期后，自动推算当前是第几周，配合周次进度条、实时时钟和"正在上课"状态展示
- 👀 **只看本周**：一键隐藏本周以外的课程，偏好本地记忆
- 🔔 **飞书课前提醒**（可选）：每节课开始前自动推送飞书卡片，自动锁定当前学期、当前周有课的课程，精确 cron 触发无空转
- 🌗 **明暗主题**：全站统一的设计语言，主题选择本地记忆，并适配系统"减少动态效果"偏好
- 📱 **响应式**：PC 端为时段分组网格（上午/下午/晚上），手机端自动切换为按天列表
- ⚡ **一次请求加载**：首页单个聚合接口带回全部学期数据，切换学期零请求
- 🛠️ **后台管理**：密码锁 + 课程的添加/编辑/删除 + 每学期开学日期设置

---

## 📁 项目结构

| 文件 | 说明 |
| --- | --- |
| `index.js` | Worker 后端：课程 CRUD、聚合查询、开学日期接口 |
| `wrangler.toml` | 部署配置：Worker 名称、KV 绑定、静态资源目录 |
| `public/index.html` | 课表展示页（首页） |
| `public/admin.html` | 后台管理页（含密码锁） |

---

## 💻 本地开发

```bash
npx wrangler dev
```

打开 <http://localhost:8787> 即可预览。本地使用模拟 KV，数据存在项目下的 `.wrangler/state` 目录，删除该目录即可重置本地数据。

> `wrangler.toml` 中的 KV id 允许使用本地占位值，本地开发不校验。

---

## 🚀 部署到 Cloudflare

### 1. 准备工作

- 一个 [Cloudflare](https://dash.cloudflare.com/) 账号
- 本机安装 [Node.js](https://nodejs.org/)（自带 `npx`）

### 2. 创建 KV 数据库

1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/)，进入 **Workers 和 Pages → KV**
2. 点击 **创建命名空间**，名称填写 `timetable`（随意），创建后**复制分配的 ID**

### 3. 填写 KV ID

编辑 `wrangler.toml`，把复制的 ID 填入：

```toml
[[kv_namespaces]]
binding = "TIMETABLE_DB"
id = "你的真实KV命名空间ID"   # 替换掉本地占位值
```

### 4. 部署

```bash
npx wrangler login      # 首次使用，浏览器授权登录
npx wrangler deploy     # 部署 Worker + 静态资源 + KV 绑定
```

部署成功后会输出访问地址，形如 `https://my-timetable.<你的子域>.workers.dev`。

### 5. 初始化配置

1. **修改后台密码**：编辑 `public/admin.html` 顶部的 `ADMIN_PASSWORD`（默认为空，务必在公开使用前设置），改完重新 `wrangler deploy`
2. 访问 `/admin.html`，输入密码进入后台
3. 在左上角设置**本学期开学日期**（第 1 周周一），这是周次推算的基准
4. 添加课程

### 6. 后续更新

修改代码后重新执行 `npx wrangler deploy` 即可。首页数据有 60 秒边缘缓存，改完课程后首页最多延迟一分钟同步。

---

## 🔔 飞书课前提醒（可选）

每节课开始前 5 分钟自动向飞书群推送提醒卡片。通知范围自动收敛为：

- **当前学期**：开学日期已设置、且当前正处于其上课周内（多学期重叠时取开学最晚的）；
- **当前周有课**：课程的 `weeks` 包含本周（单双周课自动区分）；
- **今天有这节课**：仅周一至周五，周末与假期不推送；
- **手动暂停**：法定节假日调休、考试周等场景，后台一键暂停/恢复提醒。

### 开启步骤

1. 飞书群聊 → 设置 → 群机器人 → 添加机器人 → **自定义机器人**，复制 Webhook 地址
2. 配置为 Worker 密钥（不要写进代码）：
   ```bash
   npx wrangler secret put FEISHU_WEBHOOK_URL
   ```
   按提示粘贴 Webhook 地址，secret 直接作用于已部署的 Worker
3. 访问 `https://你的地址/test-notify`，飞书群收到测试卡片即连通

### 定时触发说明

`wrangler.toml` 已配置 3 条精确 cron（Cloudflare 按 UTC 运行，已换算），每周仅触发 36 次，不再每分钟轮询：

| cron（UTC） | 对应北京时间 | 覆盖提醒点 |
| --- | --- | --- |
| `55 23,1,9 * * *` | 每天 07:55 / 09:55 / 17:55 | 1-2 节、3-4 节、9-10 节 |
| `15 5,7 * * *` | 每天 13:15 / 15:15 | 5-6 节、7-8 节 |
| `45 11 * * *` | 每天 19:45 | 第 11 节 |

> ⚠️ 修改 `index.js` 的 `PERIODS`（上课时间）或 `REMIND_MINUTES_BEFORE`（提醒提前量）后，必须按"**北京时间 − 8 小时**"同步更新这些表达式，否则对应课程收不到提醒。

### 本地调试

项目根目录创建 `.dev.vars` 文件（不要提交）写入 `FEISHU_WEBHOOK_URL=你的地址`，然后：

```bash
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=45+11+*+*+*"   # 手动触发一次定时逻辑
```

---

## ⚙️ 配置调整

| 配置项 | 位置 | 说明 |
| --- | --- | --- |
| 后台管理密码 | `public/admin.html` 顶部 `ADMIN_PASSWORD` | 空字符串 = 无需密码 |
| 上课时间表 | `public/index.html` 的 `periods` 数组 | 同步修改 `admin.html` 里节次下拉框的文案 |
| 时段分组 | `public/index.html` 的 `slotGroups` | 哪些节次属于上午/下午/晚上 |
| 提醒提前量 / 上课时间 | `index.js` 的 `REMIND_MINUTES_BEFORE` / `PERIODS` | 改后需同步 `wrangler.toml` 的 crons（北京时间 − 8 小时） |
| 学年范围 | `index.js` / `index.html` / `admin.html` 三处的 `ACADEMIC_YEARS` 数组 | 三处保持一致，每学年自动生成 2 个学期 |

---

## 📦 数据格式

KV 中的键：

- `2026-2027-1` ~ `2029-2030-2`：各学期（学年-序号）的课程 JSON 数组，共 4 个学年 × 2 学期
- `term_starts`：各学期开学日期，格式 `{"2026-2027-1": "2026-08-31"}`
- 旧版年级制键名（`freshman-1` ~ `senior-2`）的数据会在首次读取时自动迁移到新键名，无需手动处理

课程对象示例：

```json
[
  {
    "id": "1784602834435",
    "name": "高等数学",
    "day": 1,
    "period": 2,
    "weeks": "1-16",
    "room": "教二 201",
    "teacher": "张老师",
    "color": "#3b82f6"
  }
]
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `day` | 星期几（1-5，1 代表周一） |
| `period` | 节次（对应 `periods` 数组的 id，如 2 代表 3-4 节） |
| `weeks` | 上课周次，支持 `1-16`（区间）、`5`（单周）、`1-8,10-16`（组合），留空默认 `1-16` |

---

## 📡 API 一览

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/api/timetable` | GET | 聚合接口：一次返回全部学期的课程与开学日期（首页使用） |
| `/api/courses?term=X` | GET | 获取某学期课程列表 |
| `/api/courses?term=X` | POST | 添加课程（body 为课程对象，无需 id） |
| `/api/courses?term=X&id=ID` | PUT | 修改课程 |
| `/api/courses?term=X&id=ID` | DELETE | 删除课程 |
| `/api/meta?term=X` | GET | 获取开学日期，返回 `{ "startDate": "YYYY-MM-DD" \| null }` |
| `/api/meta?term=X` | PUT | 设置开学日期，body 为 `{ "startDate": "YYYY-MM-DD" }`，传 `null` 清除 |
| `/api/notify` | GET | 查询飞书提醒是否已暂停，返回 `{ "paused": bool }` |
| `/api/notify` | PUT | 暂停/恢复提醒，body 为 `{ "paused": true \| false }` |
| `/test-notify` | GET | 手动向飞书群发一张测试卡片（需已配置 Webhook） |

周次不合法时（允许 `数字`、`数字-数字`、逗号组合），POST/PUT 会返回 400。

---

## ⚠️ 安全说明

- 后台密码锁是**前端校验**，Worker API 本身没有鉴权且 CORS 全开——知道地址的人可以直接调用 API 修改数据。适合个人自用；如需公开服务，建议在 Worker 端加鉴权（如 `ADMIN_PASSWORD` 环境变量 + 请求头校验）。

---

## 📄 开源协议

[MIT License](https://opensource.org/licenses/MIT)
