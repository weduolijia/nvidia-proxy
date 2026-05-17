# API Proxy

A Cloudflare Workers-based reverse proxy for AI APIs with automatic multi-key rotation, custom provider support, adaptive rate limiting, real-time rate statistics, and a built-in management dashboard.

[中文文档](README_zh.md)

## Architecture

```
Request → Cloudflare Worker → NV_B (Durable Object)
                                ├── Per-key token bucket (configurable RPM)
                                ├── Sliding window rate stats
                                ├── Custom provider (switchable via UI)
                                ├── Automatic key failover
                                ├── Admin dashboard (4 tabs)
                                └── Forward → your configured upstream
```

## Features

- **Custom Provider** — Switch upstream, model map, and RPM from the admin panel without touching code
- **Multi-Key Rotation** — Distribute requests across multiple API keys automatically
- **Adaptive Rate Limiting** — Automatically calculates optimal queue limits based on key count
- **Real-time Rate Statistics** — 60-second sliding window RPM tracking per key
- **Admin Dashboard** — 4 tabs: Dashboard / API Keys / Provider / Error Logs
- **AUTH_TOKEN Protection** — Protects both the proxy API and admin panel
- **Automatic Failover** — Blacklists keys returning 401/403 for 3 minutes
- **Key Refresh During Queue** — Detects newly added keys while requests are queued
- **Error Logging** — Rate limit, blacklist, and timeout events logged and viewable in panel
- **Cold Start Auto-Init** — Automatically loads config and initializes limits on first request

## v6 Highlights

| Feature | Description |
|---------|-------------|
| Custom Provider | Configure upstream URL, RPM, model mapping via UI, takes effect immediately |
| Provider Tab | New admin panel tab for editing provider settings and model mappings |
| Logs Tab | New admin panel tab for viewing rate limit/blacklist/timeout logs |
| AUTH_TOKEN on Admin | Admin panel now also requires AUTH_TOKEN (browser prompt) |
| Universal | Works with any OpenAI-compatible API, not just NVIDIA |
| Reset to Default | One-click restore to default NVIDIA config |

## Quick Start

### Prerequisites

- Cloudflare account with Workers enabled
- Node.js >= 18
- At least one API key

### 1. Install dependencies

```bash
npm install
```

### 2. Create KV namespace

```bash
npx wrangler kv:namespace create NVIDIA_KV
```

Copy the returned `id` into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "NVIDIA_KV"
id = "your-kv-namespace-id"
```

### 3. Configure environment variables (optional)

```toml
[vars]
ADMIN_PATH = "your-secret-path"
AUTH_TOKEN = "your-auth-token"
```

- `ADMIN_PATH` — Path for the admin panel. If empty, `/` and `/admin` are accessible.
- `AUTH_TOKEN` — If set, both proxy requests and the admin panel require this token.

### 4. Deploy

```bash
npm run deploy
```

Or copy `src/index.js` directly into the Cloudflare Workers editor.

### 5. Add API Keys

Open the admin panel:

```
https://your-domain/your-secret-path    # if ADMIN_PATH is set
https://your-domain/admin               # if ADMIN_PATH is empty
```

Paste your API key and click **Add**.

### 6. Configure Provider (optional)

Admin panel → Provider tab, you can modify:

- **Provider Name** — e.g. NVIDIA, OpenAI, Groq
- **Upstream URL** — API request forwarding target
- **Per-Key RPM** — Rate limit per key
- **Model Mapping** — Client model name → upstream model name

### 7. Verify

```bash
curl https://your-domain/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token" \
  -d '{
    "model": "your-model-name",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

Skip `Authorization` header if `AUTH_TOKEN` is not set.

## API Reference

### Proxy Endpoints

All non-admin paths are forwarded to your configured upstream:

```bash
POST /v1/chat/completions
POST /v1/images/generations
GET  /v1/models
# ...and any OpenAI-compatible API endpoint
```

### Admin Endpoints

All under your `ADMIN_PATH`:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/{path}` | GET | Admin dashboard |
| `/{path}/__debug` | GET | Full status dump (limits, rates, utilization) |
| `/{path}/__ping` | GET | Health check |
| `/{path}/__addkey` | POST | Add an API key (JSON `{"key": "xxx"}`) |
| `/{path}/__delkey` | POST | Remove an API key (JSON `{"key": "xxx"}`) |
| `/{path}/__listkeys` | GET | List all keys with status |
| `/{path}/__clearkeys` | POST | Clear all keys |
| `/{path}/__getconfig` | GET | Get provider configuration |
| `/{path}/__setconfig` | POST | Update provider configuration |
| `/{path}/__resetconfig` | POST | Reset to default provider config |
| `/{path}/__logs` | GET | View error logs |

### `__debug` Response

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
  "providerName": "NVIDIA",
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

| Field | Description |
|-------|-------------|
| `keyCount` | Total number of API keys |
| `queueSize` | Requests currently queued |
| `queueLimit` | Max queue size (auto-calculated) |
| `globalTokens` | Sum of all key token buckets |
| `globalNextMs` | Shortest wait time across all keys (ms) |
| `perKeyRPM` | Base rate per key |
| `theoreticalRPM` | Theoretical max = `keyCount × perKeyRPM` |
| `currentRPM` | Actual RPM over the last 60s |
| `utilization` | `currentRPM / theoreticalRPM × 100%` |
| `totalRequests` | Total requests since DO startup |
| `providerName` | Current provider name |
| `keys[].currentRPM` | Per-key RPM over the last 60s |

## Dashboard Features

| Feature | Description |
|---------|-------------|
| Dashboard | Key count, queue, rates, utilization, cumulative requests |
| API Keys | Add/remove/clear/copy keys, status indicators, per-key RPM |
| Provider | Edit name, upstream URL, RPM, model mapping table — save to apply |
| Logs | View recent error events (rate limited, blacklisted, timeout) |
| AUTH Protection | Admin panel requires token if AUTH_TOKEN is set |
| Auto-refresh | Status refreshes every 5 seconds |

## Adaptive Rate Limiting

| Parameter | Formula | Example (3 keys) | Example (6 keys) |
|-----------|---------|------------------|------------------|
| Per-key limit | From provider config (default 38 RPM) | 38 RPM | 38 RPM |
| Total rate | `keyCount × perKeyRPM` | 114 RPM | 228 RPM |
| Queue limit | `min(max(keyCount × 30, 40), 200)` | 90 | 180 |

Adding or removing a key recalculates limits instantly. Switching providers updates RPM automatically.

### Rate Statistics

- **60-second sliding window** records timestamps of each successful forward
- `currentRPM` = request count in the last 60 seconds
- Per-key independent tracking, aggregated for dashboard
- Expired entries auto-pruned

### Other Parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| Queue timeout | 65s | Returns 429 on timeout |
| Request timeout | 30s | Max wait per request |
| Key cache TTL | 5 min | KV read cache duration |
| Blacklist duration | 3 min | Auto-blacklist on 401/403 |

## Project Structure

```
nvidia-proxy/
├── src/
│   └── index.js           # Core worker (rate limiting, provider, admin, proxy)
├── wrangler.toml           # Cloudflare Workers configuration
├── package.json            # Project metadata & scripts
├── GUIDE.md                # Deployment guide (English)
├── GUIDE_zh.md             # Deployment guide (Chinese)
├── README.md               # This file
├── README_zh.md            # Chinese README
└── .gitignore
```

## Commands

```bash
npm run dev       # Local development
npm run deploy    # Deploy to Cloudflare
npm run tail      # Real-time log tailing
npm run kv:create # Create KV namespace
```

## FAQ

**Q: Deployment fails with KV binding error?**
Make sure the KV namespace ID is correctly set in `wrangler.toml`.

**Q: Dashboard shows "Failed to load"?**
Check browser dev tools (F12), verify `ADMIN_PATH` env var, and ensure the latest Worker code is deployed.

**Q: Proxy returns 500?**
1. Check that API keys have been added via the dashboard
2. Verify keys are valid (not expired, not rate-limited)
3. Check `__debug` for per-key status

**Q: Getting 401 Unauthorized?**
You have `AUTH_TOKEN` set. Add `-H "Authorization: Bearer your-token"` to requests. Or remove `AUTH_TOKEN` from `wrangler.toml` and redeploy.

**Q: Need more throughput?**
Add more API keys. Each additional key adds perKeyRPM to the theoretical maximum.

**Q: Utilization consistently >80%?**
You're approaching the limit of your current key pool. Add more keys to scale.

**Q: How to switch providers?**
Admin panel → Provider tab → Edit upstream URL, RPM, and model mapping → Click "Save", takes effect immediately.

**Q: How to update the code?**
Modify `src/index.js` then run `npm run deploy`. Or paste the code into the Cloudflare Workers editor.

## License

MIT

---

> This project was entirely generated by AI.
>
> If you need help with deployment or configuration, share this README with any AI assistant (ChatGPT, Claude, SOLO, etc.) for step-by-step guidance.
