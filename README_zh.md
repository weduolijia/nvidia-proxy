# NVIDIA API Proxy

基于 Cloudflare Workers 的 NVIDIA API 反向代理，支持多 Key 自动轮换、自适应限流、实时速率统计和内置管理面板。

[English](README.md)

## 架构

```
请求 → Cloudflare Worker → NV_B (Durable Object)
                            ├── 每 Key 令牌桶限流 (38 RPM)
                            ├── 滑动窗口速率统计
                            ├── 自动故障转移
                            ├── 管理面板
                            └── 转发 → integrate.api.nvidia.com
```

## 特性

- **多 Key 轮换** — 自动在多个 NVIDIA API Key 之间分配请求
- **自适应限流** — 根据 Key 数量自动计算最优队列上限
- **实时速率统计** — 60 秒滑动窗口，追踪每个 Key 的实时 RPM
- **管理面板** — Web UI 管理 Key、监控状态、查看利用率预警
- **自动故障转移** — 返回 401/403 的 Key 自动拉黑 3 分钟
- **排队期间刷新** — 等待排队期间自动检测新添加的 Key
- **冷启动初始化** — 首次请求自动完成限流参数初始化

## v3 新特性

| 特性 | 说明 |
|------|------|
| 自适应限流 | 队列上限 = `min(max(Key数 × 30, 40), 200)`，增删 Key 即刻重算 |
| 速率统计 | 60 秒滑动窗口，每 Key 实时 RPM |
| 理论速率 | 面板展示 `Key数 × 38 RPM` 的理论上限 |
| 利用率 | `当前 / 理论 × 100%`，>80% 黄色预警 |
| 累计请求 | 记录自 DO 启动以来的总请求数 |
| 每 Key RPM | 管理面板中每个 Key 显示其实时 RPM |

## 快速开始

### 前置条件

- Cloudflare 账号，已开通 Workers
- Node.js >= 18
- 至少一个 NVIDIA API Key

### 1. 安装依赖

```bash
npm install
```

### 2. 创建 KV 命名空间

```bash
npx wrangler kv:namespace create NVIDIA_KV
```

将返回的 `id` 填入 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "NVIDIA_KV"
id = "你的-KV-Namespace-ID"
```

### 3. 配置环境变量（可选）

```toml
[vars]
ADMIN_PATH = "你的密钥路径"
AUTH_TOKEN = "你的鉴权Token"
```

- `ADMIN_PATH` — 管理面板访问路径。留空则 `/` 和 `/admin` 可直接访问。
- `AUTH_TOKEN` — 设置后，所有代理请求需携带 `Authorization: Bearer <token>`。

### 4. 部署

```bash
npm run deploy
```

### 5. 添加 API Key

打开管理面板：

```
https://你的域名/你的密钥路径    # 设置了 ADMIN_PATH
https://你的域名/admin           # 没设置 ADMIN_PATH
```

粘贴 NVIDIA API Key，点击「添加」。

### 6. 验证

```bash
curl https://你的域名/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer 你的Token" \
  -d '{
    "model": "meta/llama-3.1-8b-instruct",
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

未设置 `AUTH_TOKEN` 时可省略 `Authorization` 头。

## API 接口

### 代理转发

所有非管理路径的请求转发至 `integrate.api.nvidia.com`：

```bash
POST /v1/chat/completions
POST /v1/images/generations
GET  /v1/models
# ...任意 NVIDIA API 端点
```

### 管理接口

所有接口在 `ADMIN_PATH` 路径下：

| 接口 | 方法 | 说明 |
|------|------|------|
| `/{path}` | GET | 管理面板 |
| `/{path}/__debug` | GET | 完整状态（限流、速率、利用率） |
| `/{path}/__ping` | GET | 健康检查 |
| `/{path}/__addkey?key=xxx` | GET | 添加 API Key |
| `/{path}/__delkey?key=xxx` | GET | 删除 API Key |
| `/{path}/__listkeys` | GET | 列出所有 Key 及状态 |
| `/{path}/__clearkeys` | GET | 清空所有 Key |

### `__debug` 响应

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
| `queueLimit` | 队列上限（自动计算） |
| `globalTokens` | 所有 Key 令牌之和 |
| `globalNextMs` | 所有 Key 中最短等待毫秒数 |
| `perKeyRPM` | 每 Key 基准速率（38 RPM） |
| `theoreticalRPM` | 理论最大速率 = `keyCount × 38` |
| `currentRPM` | 过去 60 秒实际请求速率 |
| `utilization` | 利用率 = `currentRPM / theoreticalRPM × 100%` |
| `totalRequests` | DO 启动以来累计请求数 |
| `keys[].currentRPM` | 该 Key 过去 60 秒的实际 RPM |

## 管理面板功能

| 功能 | 说明 |
|------|------|
| API Key 统计 | Key 总数 |
| 排队中 | 当前排队请求数 |
| 理论速率 | `Key数 × 38 RPM`，自动更新 |
| 当前速率 | 过去 60 秒实际 RPM，>70% 理论值变黄 |
| 利用率 | 当前/理论 × 100%，>80% 黄色预警 |
| 总令牌 | 所有 Key 令牌之和 |
| 最短等待 | 所有 Key 中最短等待毫秒数 |
| 累计请求 | 总请求数（过千显示为 1.2k） |
| 添加 Key | 输入框粘贴 Key，点击添加或按回车 |
| 删除 Key | 每个 Key 右侧红色「删除」按钮 |
| 清空全部 | 右上角一键清空 |
| 复制 Key | 点击复制图标 |
| 每 Key RPM | 每个 Key 旁显示其实时 RPM |
| 状态指示 | 🟢 正常 / 🟡 额度不足 / 🔴 已拉黑 |
| 自动刷新 | 每 5 秒自动刷新状态 |

## 自适应限流策略

| 参数 | 计算公式 | 示例（3 个 Key） | 示例（6 个 Key） |
|------|----------|------------------|------------------|
| 每 Key 限流 | `38 RPM`（固定） | 38 RPM | 38 RPM |
| 总速率上限 | `Key数 × 38 RPM` | 114 RPM | 228 RPM |
| 队列上限 | `min(max(Key数 × 30, 40), 200)` | 90 | 180 |

增删 Key 即刻重算限制参数，冷启动首次请求自动初始化。

### 速率统计机制

- **60 秒滑动窗口**记录每次成功转发的时间戳
- `currentRPM` = 过去 60 秒窗口内的请求数
- 每个 Key 独立统计，面板汇总展示
- 过期数据自动清理

### 其他参数

| 参数 | 值 | 说明 |
|------|-----|------|
| 队列超时 | 65 秒 | 超时返回 429 |
| 请求超时 | 30 秒 | 单个请求最大等待 |
| Key 缓存 | 5 分钟 | KV 读取缓存时长 |
| 拉黑时长 | 3 分钟 | 401/403 自动拉黑 |

## 项目结构

```
nvidia-proxy/
├── src/
│   └── worker.js        # Worker 主代码（限流、速率统计、管理面板、代理转发）
├── wrangler.toml         # Cloudflare Workers 配置
├── package.json          # 项目配置
├── GUIDE.md              # 部署指南（英文）
├── GUIDE_zh.md           # 部署指南（中文）
├── README.md             # 英文 README
├── README_zh.md          # 中文 README（本文件）
└── .gitignore
```

## 常用命令

```bash
npm run dev       # 本地开发
npm run deploy    # 部署到 Cloudflare
npm run tail      # 查看实时日志
npm run kv:create # 创建 KV 命名空间
```

## 常见问题

**Q: 部署失败，提示 KV 绑定错误？**
确保在 `wrangler.toml` 中正确填写了 KV Namespace ID。

**Q: 管理面板显示「加载失败」？**
打开浏览器开发者工具（F12）查看错误，确认 `ADMIN_PATH` 配置正确，且已部署最新代码。

**Q: 代理返回 500？**
1. 检查管理面板中是否已添加 API Key
2. 检查 Key 是否有效（未过期、未超限）
3. 在 `__debug` 查看各 Key 状态

**Q: 返回 401 Unauthorized？**
你设置了 `AUTH_TOKEN`。请求时加上 `-H "Authorization: Bearer 你的Token"`。或者从 `wrangler.toml` 中删除 `AUTH_TOKEN` 并重新部署。

**Q: 总速率不够用？**
添加更多 API Key。每增加一个 Key，总速率上限自动提高 38 RPM。

**Q: 利用率持续 >80%？**
说明请求量接近当前 Key 池的理论上限，建议添加更多 Key 来扩容。

**Q: 如何更新代码？**
修改 `src/worker.js` 后运行 `npm run deploy` 即可。

## License

MIT

---

> 此项目全部由 AI 生成。
>
> 如果看了文档还是不会操作，把这份文档丢给 AI（ChatGPT、Claude、SOLO 等），让 AI 一步步教你。

