# NVIDIA API Proxy

A Cloudflare Workers-based reverse proxy for NVIDIA APIs with automatic multi-key rotation, adaptive rate limiting, real-time rate statistics, and a built-in management dashboard.

[中文文档](README_zh.md)

## Architecture

```
Request → Cloudflare Worker → NV_B (Durable Object)
                               ├── Per-key token bucket (38 RPM)
                               ├── Sliding window rate stats
                               ├── Automatic key failover
                               ├── Admin dashboard
                               └── Forward → integrate.api.nvidia.com
```

## Features

- **Multi-Key Rotation** — Distribute requests across multiple NVIDIA API keys automatically
- **Adaptive Rate Limiting** — Automatically calculates optimal queue limits based on key count
- **Real-time Rate Statistics** — 60-second sliding window RPM tracking per key
- **Admin Dashboard** — Web UI for key management, status monitoring, and utilization alerts
- **Automatic Failover** — Blacklists keys returning 401/403 for 3 minutes
- **Key Refresh During Queue** — Detects newly added keys while requests are queued
- **Cold Start Auto-Init** — Automatically initializes limits on first request

## v3 Highlights

| Feature | Description |
|---------|-------------|
| Adaptive limits | Queue limit = `min(max(keyCount × 30, 40), 200)`, recalculated instantly |
| Rate stats | 60s sliding window, real-time RPM per key |
| Theoretical rate | `keyCount × 38 RPM` displayed on dashboard |
| Utilization | `current / theoretical × 100%`, yellow warning at >80% |
| Cumulative requests | Total request count since DO startup |
| Per-key RPM | Individual key RPM shown in dashboard |

## Quick Start

### Prerequisites

- Cloudflare account with Workers enabled
- Node.js >= 18
- At least one NVIDIA API key

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
- `AUTH_TOKEN` — If set, all proxy requests require `Authorization: Bearer <token>`.

### 4. Deploy

```bash
npm run deploy
```

### 5. Add API Keys

Open the admin panel:

```
https://your-domain/your-secret-path    # if ADMIN_PATH is set
https://your-domain/admin               # if ADMIN_PATH is empty
```

Paste your NVIDIA API key and click **Add**.

### 6. Verify

```bash
curl https://your-domain/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token" \
  -d '{
    "model": "meta/llama-3.1-8b-instruct",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

Skip `Authorization` header if `AUTH_TOKEN` is not set.

## API Reference

### Proxy Endpoints

All non-admin paths are forwarded to `integrate.api.nvidia.com`:

```bash
POST /v1/chat/completions
POST /v1/images/generations
GET  /v1/models
# ...and any other NVIDIA API endpoint
```

### Admin Endpoints

All under your `ADMIN_PATH`:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/{path}` | GET | Admin dashboard |
| `/{path}/__debug` | GET | Full status dump (limits, rates, utilization) |
| `/{path}/__ping` | GET | Health check |
| `/{path}/__addkey?key=xxx` | GET | Add an API key |
| `/{path}/__delkey?key=xxx` | GET | Remove an API key |
| `/{path}/__listkeys` | GET | List all keys with status |
| `/{path}/__clearkeys` | GET | Remove all keys |

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
| `perKeyRPM` | Base rate per key (38 RPM) |
| `theoreticalRPM` | Theoretical max = `keyCount × 38` |
| `currentRPM` | Actual RPM over the last 60s |
| `utilization` | `currentRPM / theoreticalRPM × 100%` |
| `totalRequests` | Total requests since DO startup |
| `keys[].currentRPM` | Per-key RPM over the last 60s |

## Dashboard Features

| Feature | Description |
|---------|-------------|
| API Key count | Total keys loaded |
| Queue size | Currently queued requests |
| Theoretical rate | `keyCount × 38 RPM`, auto-updates |
| Current rate | Actual 60s RPM, yellow at >70% theoretical |
| Utilization | Current / theoretical %, yellow warning at >80% |
| Total tokens | Sum of all key buckets |
| Min wait | Shortest token wait across all keys (ms) |
| Total requests | Cumulative count, formatted (e.g. 1.2k) |
| Add key | Paste key, click add or press Enter |
| Remove key | Red delete button per key |
| Clear all | One-click remove all |
| Copy key | Click clipboard icon to copy |
| Per-key RPM | Real-time RPM display beside each key |
| Status indicators | 🟢 OK / 🟡 Low balance / 🔴 Blacklisted |
| Auto-refresh | Status refreshes every 5 seconds |

## Adaptive Rate Limiting

| Parameter | Formula | Example (3 keys) | Example (6 keys) |
|-----------|---------|------------------|------------------|
| Per-key limit | `38 RPM` (fixed) | 38 RPM | 38 RPM |
| Total rate | `keyCount × 38 RPM` | 114 RPM | 228 RPM |
| Queue limit | `min(max(keyCount × 30, 40), 200)` | 90 | 180 |

Adding or removing a key recalculates limits instantly. Cold start initializes on first request.

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
│   └── worker.js        # Core worker (rate limiting, stats, admin, proxy)
├── wrangler.toml         # Cloudflare Workers configuration
├── package.json          # Project metadata & scripts
├── GUIDE.md              # Deployment guide (English)
├── GUIDE_zh.md           # Deployment guide (Chinese)
├── README.md             # This file
├── README_zh.md          # Chinese README
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
Add more API keys. Each additional key adds 38 RPM to the theoretical maximum.

**Q: Utilization consistently >80%?**
You're approaching the limit of your current key pool. Add more keys to scale.

**Q: How to update the code?**
Modify `src/worker.js` then run `npm run deploy`.

## License

MIT

---

> This project was entirely generated by AI.
>
> If you need help with deployment or configuration, share this README with any AI assistant (ChatGPT, Claude, SOLO, etc.) for step-by-step guidance.

