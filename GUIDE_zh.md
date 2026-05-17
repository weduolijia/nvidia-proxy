# NVIDIA Proxy 完整部署流程

[English](GUIDE.md)

## 项目简介

将 NVIDIA API 的请求通过 Cloudflare Workers 反向代理，自动管理多个 API Key 的轮换、自适应限流、速率统计和故障转移。

```
用户请求 → Cloudflare Worker → NV_B (Durable Object)
                                ├── 每 Key 限流 (38 RPM) + 速率统计
                                ├── Key1 令牌桶 + 速率统计
                                ├── Key2 令牌桶 + 速率统计
                                ├── Key3 令牌桶 + 速率统计
                                └── 转发 → integrate.api.nvidia.com
```

### v3 新特性

| 特性 | 说明 |
|------|------|
| **自适应限流** | 根据 Key 数量自动计算队列上限，增删 Key 即刻生效 |
| **速率统计** | 60 秒滑动窗口实时统计每 Key 的 RPM（请求速率） |
| **理论速率** | 面板展示 `Key 数 × 38 RPM` 的理论上限，一目了然 |
| **利用率监控** | 当前速率 / 理论速率 × 100%，>80% 黄色预警 |
| **累计请求** | 记录自 DO 启动以来的总请求数 |
| **每 Key RPM** | 管理面板中每个 Key 旁显示其实时 RPM |

### 用到了 Cloudflare 哪些存储/状态能力？

本项目使用了 Cloudflare 的两种**持久化存储**：

| 能力 | 用途 | 说明 |
|------|------|------|
| **Durable Objects（DO）** | 限流 + 速率统计 | 全局单例，精确控制每 Key 限流。搭配滑动窗口计数器实现实时 RPM 统计。DO 有状态，不会因 Worker 冷启动丢失数据 |
| **KV（Key-Value）** | 存储 API Key | 所有 NVIDIA API Key 保存在 KV 里，通过管理面板或 API 增删改查，Worker 重启后 Key 不丢失 |

**为什么需要 DO？**
- Worker 本身是**无状态**的，每次请求可能分配到不同的机器
- 如果用 Worker 本地变量计数，限流就不准了（多实例间不共享）
- DO 提供了一个**全局单例**，所有请求都找同一个 DO 处理限流和速率统计
- 搭配 Cron 触发器每 5 分钟发一次保活请求，防止 DO 因闲置被回收

**为什么需要 KV？**
- 存储 API Key 列表，支持动态增删，无需修改代码
- 相比硬编码在代码里，KV 可以在线管理，部署后也能随时加减 Key

---

## 一、前置条件

| 条件 | 说明 |
|------|------|
| Cloudflare 账号 | 需要开通 Workers 功能 |
| Node.js >= 18 | 用于 wrangler CLI 部署 |
| NVIDIA API Key | 至少一个，可从 NVIDIA 开发者平台获取 |

---

## 二、部署步骤

### 2.1 安装依赖

> 如果你不熟悉命令行操作，下面每一步都有详细说明。

#### ① 打开终端（命令行）

- **Windows**：在项目文件夹内，按住 `Shift` 键 + 鼠标右键 → 选择「在此处打开 PowerShell 窗口」或「打开终端」
- **macOS**：打开「终端」应用，输入 `cd `（注意后面有空格），然后把项目文件夹拖进去，按回车
- 或者直接用 VS Code：在项目文件夹上右键 →「通过 Code 打开」→ 顶部菜单「终端 → 新建终端」

#### ② 确认已安装 Node.js

在终端中输入以下命令检查：

```bash
node --version
```

如果显示版本号（如 `v18.0.0` 或更高），说明已安装，跳到第 ③ 步。

如果提示「未找到命令」或「不是内部或外部命令」，说明还没装 Node.js，需要先安装：

- 访问 https://nodejs.org/
- 下载左侧 **LTS（长期支持版）** 安装包
- 双击安装，一路点「下一步」直到完成
- **安装完成后关闭并重新打开终端**，再运行 `node --version` 确认

#### ③ 进入项目目录

```bash
cd nvidia-proxy
```

> 这条命令的意思是「进入 nvidia-proxy 文件夹」。如果你在 VS Code 里打开了项目文件夹，这一步可以跳过。

#### ④ 安装依赖

```bash
npm install
```

等待执行完成，终端会显示类似这样的输出：

```
added 1 package in 2s
```

> 如果看到 `npm install` 跑完了但没有报错红色文字，就是成功了。
> 如果遇到权限报错（Mac/Linux），尝试在前面加 `sudo`：`sudo npm install`

### 2.2 配置 KV 命名空间

> **KV（Key-Value）** 是 Cloudflare 的键值存储服务，用于持久化保存数据。
> 本项目用它来存储你添加的 API Key，即使 Worker 重启或更新，Key 也不会丢失。

在终端中运行以下命令，创建一个 KV 命名空间：

```bash
npx wrangler kv:namespace create NVIDIA_KV
```

输出示例：
```
🌀 Creating namespace with title "nvidia-proxy-NVIDIA_KV"
✨ Success!
Add the following to your wrangler.toml:

[[kv_namespaces]]
binding = "NVIDIA_KV"
id = "abc123def456..."
```

将返回的 `id` 复制到 `wrangler.toml` 中：

```toml
[[kv_namespaces]]
binding = "NVIDIA_KV"
id = "abc123def456..."   # ← 替换为你的 ID
```

### 2.3 配置环境变量

编辑 `wrangler.toml`，按需设置以下变量：

```toml
[vars]
# 管理面板访问路径（强烈建议设置）
# 不设则 / 和 /admin 可直接访问管理面板
ADMIN_PATH = "你的密码"

# API 鉴权 Token（可选）
# 设置后，所有代理请求必须带 Authorization: Bearer <token>
# 不设则跳过鉴权，任何人都能调用你的代理
AUTH_TOKEN = "你的token"
```

### 2.4 部署

```bash
npx wrangler deploy
```

部署成功后输出示例：
```
✨  Deployment complete! Take a peek over at https://你的域名.workers.dev
```

---

## 三、首次使用

### 3.1 添加 API Key

打开管理面板（根据你的配置）：

```
# 如果设置了 ADMIN_PATH
https://你的域名/你的密码

# 如果没有设置
https://你的域名/admin
```

在输入框中粘贴你的 NVIDIA API Key，点击「添加」。

> API Key 格式示例：`nvapi-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

### 3.2 验证代理是否正常

> 如果设置了 `AUTH_TOKEN`，下面请求需要加上 `-H "Authorization: Bearer 你的token"`
> 没设置则直接请求即可，不需要鉴权。

```bash
curl https://你的域名/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer 你的token" \
  -d '{
    "model": "meta/llama-3.1-8b-instruct",
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

> 注意：请求中不需要带 NVIDIA API Key，Worker 会自动管理。
> 如果收到 401 错误，说明需要设置 `Authorization` 头或检查 Token 是否正确。

---

## 四、API 接口说明

### 4.1 代理转发

所有非管理路径的请求都会被转发到 `integrate.api.nvidia.com`。

```
POST https://你的域名/v1/chat/completions
POST https://你的域名/v1/images/generations
GET  https://你的域名/v1/models
```

### 4.2 管理接口

所有管理接口在 `ADMIN_PATH` 路径下：

| 接口 | 方法 | 说明 |
|------|------|------|
| `/{path}` | GET | 管理面板页面 |
| `/{path}/__debug` | GET | 查看完整状态（限流、速率、利用率） |
| `/{path}/__ping` | GET | 健康检查 |
| `/{path}/__addkey?key=xxx` | GET | 添加 API Key |
| `/{path}/__delkey?key=xxx` | GET | 删除 API Key |
| `/{path}/__listkeys` | GET | 列出所有 Key 及状态 |
| `/{path}/__clearkeys` | GET | 清空所有 Key |

### 4.3 `__debug` 返回字段

```json
{
  "keyCount": 3,
  "queueSize": 5,
  "queueLimit": 90,
  "globalTokens": 85,
  "globalNextMs": 0,
  "perKeyRPM": 38,
  "theoreticalRPM": 114,
  "currentRPM": 42,
  "utilization": 36.8,
  "totalRequests": 1234,
  "keys": [
    {
      "key": "nvapi-xxx",
      "tokens": 28,
      "nextTokenMs": 0,
      "blacklisted": false,
      "currentRPM": 15
    }
  ]
}
```

| 字段 | 说明 |
|------|------|
| `keyCount` | 当前 Key 总数 |
| `queueSize` | 当前排队中的请求数 |
| `queueLimit` | 队列上限（自动计算：Key 数 × 30，最小 40，最大 200） |
| `globalTokens` | 所有 Key 令牌之和 |
| `globalNextMs` | 所有 Key 中最短的令牌等待毫秒数 |
| `perKeyRPM` | 每 Key 基准速率（38 RPM） |
| `theoreticalRPM` | 理论最大速率 = `keyCount × perKeyRPM` |
| `currentRPM` | 过去 60 秒实际请求速率 |
| `utilization` | 利用率 = `currentRPM / theoreticalRPM × 100%` |
| `totalRequests` | DO 启动以来的累计请求数 |
| `keys[].currentRPM` | 该 Key 过去 60 秒的实际 RPM |

示例：

```bash
# 添加 Key
curl "https://你的域名/密码/__addkey?key=nvapi-xxxxxxxxxxxx"

# 查看状态
curl "https://你的域名/密码/__debug"

# 删除 Key
curl "https://你的域名/密码/__delkey?key=nvapi-xxxxxxxxxxxx"
```

---

## 五、管理面板功能

| 功能 | 说明 |
|------|------|
| API Keys 统计 | Key 总数 |
| 排队中 | 当前排队请求数 |
| 理论速率 | `Key 数 × 38 RPM`，自动更新 |
| 当前速率 | 过去 60 秒实际 RPM，>70% 理论值变黄 |
| 利用率 | 当前/理论 × 100%，>80% 黄色预警 |
| 总令牌 | 所有 Key 令牌之和 |
| 最短等待 | 所有 Key 中最短等待毫秒数 |
| 累计请求 | 总请求数（过千显示为 1.2k） |
| 添加 Key | 输入框粘贴 Key，点击添加或按回车 |
| 删除 Key | 每个 Key 右侧的红色「删除」按钮 |
| 清空全部 | 右上角一键清空 |
| 复制 Key | 点击 📋 图标复制到剪贴板 |
| 每 Key RPM | 每个 Key 旁显示其实时 RPM（如 `15rpm 30t`） |
| 状态指示 | 🟢 正常 / 🟡 额度不足 / 🔴 已拉黑 |
| 自动刷新 | 每 5 秒自动刷新状态 |

---

## 六、自适应限流策略

### 核心机制

系统以 `PER_KEY_RPM = 38` 为基准，根据 Key 数量自动推导所有限制参数：

| 参数 | 计算公式 | 示例（3 个 Key） | 示例（6 个 Key） |
|------|----------|------------------|------------------|
| 每 Key 限流 | `38 RPM`（固定） | 38 RPM | 38 RPM |
| 总速率上限 | `Key 数 × 38 RPM` | 114 RPM | 228 RPM |
| 队列上限 | `min(max(Key 数 × 30, 40), 200)` | 90 | 180 |

添加或删除 Key 时，系统**即刻重算**队列上限，无需重启或手动修改配置。首次请求时自动从 KV 加载 Key 数量完成初始化。

### 排队期间 Key 刷新

当所有 Key 令牌耗尽进入排队等待时，每 5 次轮询自动从 KV 重新拉取 Key 列表。如果排队期间有新 Key 添加，系统会立即感知并纳入轮换，提升吞吐。

### 其他固定参数

| 限制项 | 值 | 说明 |
|--------|-----|------|
| 队列超时 | 65 秒 | 超时返回 429 |
| 请求超时 | 30 秒 | 单个请求最大等待 |
| Key 缓存 | 5 分钟 | KV 读取缓存时间 |
| 拉黑时长 | 3 分钟 | 返回 401/403 自动拉黑 |

### 速率统计机制

- 使用 **60 秒滑动窗口** 记录每次成功转发的时间戳
- `currentRPM` = 过去 60 秒窗口内的请求数
- 每个 Key 独立统计，汇总展示
- 窗口自动清理过期数据，内存开销可控

---

## 七、常用命令

```bash
# 本地开发调试
npm run dev

# 部署
npm run deploy

# 查看实时日志
npm run tail

# 查看部署状态
npx wrangler deploy --dry-run
```

---

## 八、项目结构

```
nvidia-proxy/
├── src/
│   └── worker.js        # Worker 主代码（限流 + 速率统计 + 管理面板 + 代理转发）
├── wrangler.toml         # Cloudflare Workers 配置（KV + DO + Cron）
├── package.json          # 项目依赖配置
├── README.md             # 项目 README（英文）
├── README_zh.md          # 项目 README（中文）
├── GUIDE.md              # 部署指南（英文）
├── GUIDE_zh.md           # 部署指南（中文，本文件）
└── .gitignore            # Git 忽略规则
```

### worker.js 核心模块

| 模块 | 行数 | 职责 |
|------|------|------|
| 常量 & 工具函数 | ~30 | `PER_KEY_RPM`、CORS、JSON 响应等 |
| `serveAdmin()` | ~275 | 管理面板完整 HTML/CSS/JS（暗色 UI） |
| `TokenBucket` | ~40 | 令牌桶限流算法，支持运行时 `updateLimits()` |
| `NV_B` (Durable Object) | ~360 | 限流、速率统计、Key 管理、请求转发 |
| `export default` | ~15 | Worker 入口 + Cron 保活触发器 |

### wrangler.toml 配置了什么？

| 配置项 | 类型 | 作用 |
|--------|------|------|
| `[[kv_namespaces]]` | KV 命名空间 | 持久化存储 API Key，绑定为 `NVIDIA_KV` |
| `[[durable_objects.bindings]]` | Durable Objects | 限流 + 速率统计，绑定为 `NV_C`，类名 `NV_B` |
| `[[migrations]]` | DO 迁移 | 首次部署时创建 `NV_B` 这个 DO 类 |
| `[triggers]` | Cron 触发器 | 每 5 分钟触发 `scheduled()`，保活 DO 防止被回收 |
| `[vars]` | 环境变量 | 可配置 `ADMIN_PATH`（管理面板路径）和 `AUTH_TOKEN`（API 鉴权） |

---

## 九、常见问题

### Q: 部署失败，提示 KV 绑定错误？
确保在 `wrangler.toml` 中正确填写了 KV Namespace ID。

### Q: 管理面板显示「加载失败」？
1. 打开浏览器开发者工具（F12）查看具体错误
2. 确认 `ADMIN_PATH` 环境变量已正确设置
3. 确认 Worker 已部署最新代码

### Q: 代理返回 500？
1. 检查管理面板中是否已添加 API Key
2. 检查 Key 是否有效（未过期、未超限）
3. 在 `__debug` 查看各 Key 状态和速率

### Q: 返回 401 Unauthorized？
说明你设置了 `AUTH_TOKEN`，但请求中没有带上正确的鉴权头。解决方法：
```bash
# 请求时加上 Authorization 头
curl https://你的域名/v1/chat/completions \
  -H "Authorization: Bearer 你的token" \
  -H "Content-Type: application/json" \
  -d '{"model":"...","messages":[...]}'
```
如果不想用鉴权，把 `wrangler.toml` 里的 `AUTH_TOKEN` 删掉重新部署即可。

### Q: 总速率不够用怎么办？
**加 Key 就行。** 每加一个 Key，总速率上限自动增加 38 RPM，队列上限也会相应提高。面板上的「理论速率」会实时更新。

### Q: 利用率很高（>80%）说明什么？
说明你的请求量接近当前 Key 池的理论上限，建议**添加更多 Key** 来扩容。黄色预警是一个提醒信号。

### Q: 如何更新代码？
```bash
# 修改 src/worker.js 后重新部署
npm run deploy
```

---

> 此项目全部由 AI 生成。
>
> 如果看了文档还是不会操作，把这份文档丢给 AI（如 ChatGPT、Claude、SOLO），让 AI 一步步教你。每个步骤、每段代码 AI 都能解释清楚。
