# 📚 课程表

一个简洁、实用的前后端分离课程表应用。

本项目主要用于个人学习和日常课程安排，也开源出来供大家使用和参考。

项目采用 **Cloudflare Workers + KV** 部署，课程数据保存在KV数据库中

> 💡 本项目参考了 B 站 UP 主「二叉树树」进行AI Coding

---

## ✨ 功能

- 📅 查看每周课程安排
- ✏️ 修改课程
- 📚 按学期保存课程
- 🏫 支持课程名称、教师、教室等信息
- 🎨 支持自定义课程颜色
- 📱 适配移动端
- 🤖 支持飞书机器人通知

---

## 🖥️ 项目结构

```text
timetable/
├── public/              # 前端页面及静态资源
├── index.js             # Cloudflare Workers 后端 API
├── wrangler.toml        # Cloudflare Workers 配置
└── README.md            # 项目说明
```

---

## ☁️ 部署到 Cloudflare Workers

**Fork** 本项目，并将仓库设置为 **Private**

**如果觉得项目好用，不妨给个 ⭐ Star 支持一下**

### 1. 创建KV空间

**存储和数据库 → Workers KV**

创建一个新的 KV Namespace。

例如可以命名为：

```text
TIMETABLE_DB
```

创建完成后，复制这个 KV Namespace 的 **ID**。

### 2. 修改 `wrangler.toml`

将 `id` 修改为刚刚创建的 KV Namespace ID：

```toml
[[kv_namespaces]]
binding = "TIMETABLE_DB"
id = "你的KV_ID"
```

### 3. 美化

#### `admin.html`

第六行  `<title>Dashboard</title>` #修改标题

第九行  `<link rel="icon" href="" type="image/x-icon">` #修改网站后台头像

第237行  `const ADMIN_PASSWORD = ""; ` #修改后台密码

#### `index.html`

**前台同理**

### 4. 部署

进入：

**Workers & Pages → Create application → Continue With Github**

连接自己的仓库并完成部署即可。

---

## 🤖 飞书通知

项目预留了飞书机器人提前5分钟通知的模板

### 1. 创建Workers脚本

进入：

**Workers & Pages → Create application → Start with Hallo World**

### 2. 绑定KV空间

进入：

**绑定 → 添加绑定→ KV命名空间**

**命名为**`TIMETABLE_DB`与你的KV绑定

### 3. 修改代码(部署脚本)

第六行  `const FEISHU_WEBHOOK_URL = ""; ` #修改机器人链接

第84行  ` let rawData = await kv.get("freshman-1"); ` #修改通知

## 📚 通知学期设置

| 学期          | 对应代码                |
| ------------- | ----------------------- |
| 大一上/大一下 | freshman-1/freshman-2   |
| 大二上/大二下 | sophomore-1/sophomore-2 |
| 大三上/大三下 | junior-1/junior-2       |
| 大四上/大四下 | senior-1/senior-2       |

## 📡 调试与路由接口

部署完成后，可以通过以下路由检查服务状态：

| 路由地址       | 请求方式 | 功能描述                                                     |
| -------------- | -------- | ------------------------------------------------------------ |
| `/`            | `GET`    | 检查 Worker 基础运行状态                                     |
| `/debug`       | `GET`    | 查看当前北京时间、KV 绑定状态、自适应提醒时间表与课程数据预览 |
| `/test-notify` | `GET`    | 手动触发一条默认测试卡片到飞书，验证 Webhook 连通性          |

---

## 🛠️ 技术栈

| 技术                    | 用途                |
| ----------------------- | ------------------- |
| HTML / CSS / JavaScript | 前端页面            |
| Cloudflare Workers      | 后端 API            |
| Cloudflare KV           | 课程数据存储        |
| Wrangler                | Cloudflare 项目部署 |
| GitHub                  | 项目托管            |

---

## 为什么做这个项目？

大学课程比较多之后，仅仅依靠学校提供的课程表查看起来并不是特别方便。

所以做了这个简单的课程表，希望能够：

> **让课程安排变得简单一点。**

这个项目也是我自己学习和实践 AI Coding 的一个小项目。

如果这个项目对你有帮助，欢迎点一个 ⭐ Star。

---

## 📄 开源协议

本项目采用 **MIT License** 开源。

你可以自由使用、修改和二次开发。

---

## 🙏 致谢

感谢 B 站 UP 主 **二叉树树** 的 思路参考。

同时感谢开源社区提供的各种优秀工具和服务。

---

## 📮 反馈

如果你发现了 Bug，或者有新的功能建议，可以直接在 GitHub 提交 Issue。

也欢迎提交 Pull Request，一起完善这个项目。
