# API Proxy — Complete Deployment Guide

[中文版](GUIDE_zh.md)

## Overview

A Cloudflare Workers-based reverse proxy for AI APIs, supporting custom providers, automatic multi-key rotation, adaptive rate limiting, rate statistics, and failover.

```
Request → Cloudflare Worker → NV_B (Durable Object)
                                ├── Per-key rate limit (configurable RPM) + rate stats
                                ├── Key1 token bucket + rate stats
                                ├── Key2 token bucket + rate stats
                                ├── Key3 token bucket + rate stats
                                └── Forward → your configured upstream
```

### v6 Features

| Feature | Description |
|---------|-------------|
| **Custom Provider** | Switch upstream URL, RPM, and model mapping from admin panel |
| **Provider Management** | Add/edit/delete model mappings, save takes effect immediately |
| **Error Logging** | Rate limit/blacklist/timeout events auto-logged to KV, viewable in panel |
| **AUTH_TOKEN on Admin** | Admin panel also requires token authentication (browser prompt) |
| **Universal** | Works with any OpenAI-compatible API, not just NVIDIA |

### Cloudflare Storage Used

This project uses two Cloudflare persistent storage services:

| Service | Purpose | Details |
|---------|---------|---------|
| **Durable Objects (DO)** | Rate limiting + stats | Global singleton, precise per-key rate limiting. With sliding window counters for real-time RPM stats. Stateful — survives Worker cold starts |
| **KV (Key-Value)** | API Key storage + provider config | All keys and provider config stored in KV, manageable via dashboard or API. Persists across restarts and redeployments |

**Why Durable Objects?**
- Workers are **stateless** — requests may land on different instances
- Local in-memory counters wouldn't be accurate across instances
- DO provides a **global singleton** — all requests hit the same DO for rate limiting
- Cron trigger sends a keep-alive every 5 minutes to prevent DO eviction

**Why KV?**
- Stores API keys and provider configuration, supports dynamic changes without code modification
- Unlike hardcoded values, KV can be managed online at any time

---

## 1. Prerequisites

| Requirement | Details |
|-------------|---------|
| Cloudflare account | Workers feature enabled |
| Node.js >= 18 | Required for wrangler CLI |
| API Key | At least one, from your provider |

---

## 2. Deployment Steps

### 2.1 Install Dependencies

#### ① Open Terminal

- **Windows**: Inside the project folder, `Shift + Right Click` → "Open PowerShell window here" or "Open Terminal"
- **macOS**: Open Terminal, type `cd ` (with trailing space), drag the project folder in, press Enter
- Or use VS Code: right-click the folder → "Open with Code" → top menu "Terminal → New Terminal"

#### ② Verify Node.js

```bash
node --version
```

If a version number appears (e.g. `v18.0.0` or higher), you're good. Skip to step ③.

If you get "command not found", install Node.js first:

- Visit https://nodejs.org/
- Download the **LTS** installer
- Run it, keep clicking Next until done
- **Close and reopen the terminal**, then verify with `node --version`

#### ③ Enter the project directory

```bash
cd nvidia-proxy
```

> If you opened the folder in VS Code, you can skip this step.

#### ④ Install dependencies

```bash
npm install
```

Expected output:

```
added 1 package in 2s
```

> If you get a permission error (Mac/Linux), try `sudo npm install`

### 2.2 Configure KV Namespace

> **KV (Key-Value)** is Cloudflare's key-value store. This project uses it to persist API keys and provider config across Worker restarts.

Create a KV namespace:

```bash
npx wrangler kv:namespace create NVIDIA_KV
```

Example output:
```
🌀 Creating namespace with title "nvidia-proxy-NVIDIA_KV"
✨ Success!
Add the following to your wrangler.toml:

[[kv_namespaces]]
binding = "NVIDIA_KV"
id = "abc123def456..."
```

Copy the returned `id` into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "NVIDIA_KV"
id = "abc123def456..."   # ← Paste your ID here
```

### 2.3 Configure Environment Variables

Edit `wrangler.toml` as needed:

```toml
[vars]
# Admin panel access path (strongly recommended)
# If empty, / and /admin will serve the dashboard
ADMIN_PATH = "your-secret-path"

# API + Admin panel auth token (optional)
# If set, all proxy requests and admin panel must pass this token
# If empty, no auth is required
AUTH_TOKEN = "your-token"
```

### 2.4 Deploy

```bash
npx wrangler deploy
```

Example output on success:
```
✨  Deployment complete! Take a peek over at https://your-domain.workers.dev
```

**Alternatively**: Copy `src/index.js` directly into the Cloudflare Workers editor and save/deploy.

---

## 3. First-Time Setup

### 3.1 Add API Key

Open the admin panel:

```
# If ADMIN_PATH is set
https://your-domain/your-secret-path

# If ADMIN_PATH is empty
https://your-domain/admin
```

If `AUTH_TOKEN` is set, the browser will prompt for the token.

Paste your API key in the input field and click **Add**.

> Key format example: `nvapi-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` or `sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

### 3.2 Configure Provider (optional)

Admin panel → Provider tab:

1. **Provider Name** — Give your provider a name (e.g. "NVIDIA", "OpenAI", "Groq")
2. **Upstream URL** — The actual API endpoint to forward requests to
3. **Per-Key RPM** — Rate limit per key
4. **Model Mapping Table** — Add "client model name → upstream model name" mappings

Click **Save** after modification — takes effect immediately, no restart needed.

### 3.3 Verify the Proxy

> If `AUTH_TOKEN` is set, add `-H "Authorization: Bearer your-token"` to requests below.
> If not set, no auth header is needed.

```bash
curl https://your-domain/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token" \
  -d '{
    "model": "your-model-name",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

> Note: You do NOT include your provider API key in requests. The Worker manages keys automatically.
> If you get a 401 error, check your `AUTH_TOKEN` configuration.

---

## 4. API Reference

### 4.1 Proxy Forwarding

All non-admin paths are forwarded to your configured upstream:

```
POST https://your-domain/v1/chat/completions
POST https://your-domain/v1/images/generations
GET  https://your-domain/v1/models
```

### 4.2 Admin Endpoints

All under your `ADMIN_PATH`:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/{path}` | GET | Admin dashboard |
| `/{path}/__debug` | GET | Full status (limits, rates, utilization) |
| `/{path}/__ping` | GET | Health check |
| `/{path}/__addkey` | POST | Add API key |
| `/{path}/__delkey` | POST | Remove API key |
| `/{path}/__listkeys` | GET | List all keys with status |
| `/{path}/__clearkeys` | POST | Clear all keys |
| `/{path}/__getconfig` | GET | Get provider configuration |
| `/{path}/__setconfig` | POST | Update provider configuration |
| `/{path}/__resetconfig` | POST | Reset to default NVIDIA config |
| `/{path}/__logs` | GET | View error logs |

### 4.3 `__debug` Response Fields

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
| `keyCount` | Total key count |
| `queueSize` | Requests currently queued |
| `queueLimit` | Max queue size (auto-calculated: keyCount × 30, min 40, max 200) |
| `globalTokens` | Sum of all key tokens |
| `globalNextMs` | Shortest token wait across all keys (ms) |
| `perKeyRPM` | Base rate per key |
| `theoreticalRPM` | Theoretical max = `keyCount × perKeyRPM` |
| `currentRPM` | Actual RPM over the last 60s |
| `utilization` | `currentRPM / theoreticalRPM × 100%` |
| `totalRequests` | Total requests since DO startup |
| `providerName` | Current provider name |
| `keys[].currentRPM` | Per-key RPM over the last 60s |

---

## 5. Dashboard Features

| Feature | Description |
|---------|-------------|
| Dashboard | Key count, queue, rates, utilization, tokens, cumulative requests |
| API Keys | Add/remove/clear/copy keys, status indicators (🟢 🟡 🔴), per-key RPM |
| Provider | Edit name, upstream URL, RPM, model mapping table — save to apply |
| Logs | View recent error events (rate limited, blacklisted, timeout), refresh button |
| AUTH Protection | Panel requires token if `AUTH_TOKEN` is set |
| Auto-refresh | Status refreshes every 5 seconds |

---

## 6. Adaptive Rate Limiting

### Core Mechanism

The system uses your configured `perKeyRPM` and derives all limit parameters from the key count:

| Parameter | Formula | Example (3 keys) | Example (6 keys) |
|-----------|---------|------------------|------------------|
| Per-key limit | From provider config (default 38 RPM) | 38 RPM | 38 RPM |
| Total rate | `keyCount × perKeyRPM` | 114 RPM | 228 RPM |
| Queue limit | `min(max(keyCount × 30, 40), 200)` | 90 | 180 |

Adding or removing a key recalculates limits instantly. Switching providers updates RPM automatically.

### Key Refresh During Queue

When all keys are exhausted and requests are queued, the system re-fetches the key list from KV every 5 polling cycles. If new keys are added during queuing, they'll be detected and included in rotation immediately.

### Other Fixed Parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| Queue timeout | 65s | Returns 429 on timeout |
| Request timeout | 30s | Max wait per request |
| Key cache TTL | 5 min | KV read cache duration |
| Blacklist duration | 3 min | Auto-blacklist on 401/403 |

### Rate Statistics

- **60-second sliding window** records timestamps of each successful forward
- `currentRPM` = request count in the last 60 seconds
- Per-key independent tracking, aggregated for dashboard
- Expired entries auto-pruned, memory-efficient

---

## 7. Commands

```bash
# Local development
npm run dev

# Deploy
npm run deploy

# Real-time log tailing
npm run tail

# Dry-run deploy check
npx wrangler deploy --dry-run
```

---

## 8. Project Structure

```
nvidia-proxy/
├── src/
│   └── index.js            # Core worker (rate limiting + provider + admin panel + proxy)
├── wrangler.toml            # Cloudflare Workers config (KV + DO + Cron)
├── package.json             # Project dependencies
├── README.md                # Project README (English)
├── README_zh.md             # Project README (Chinese)
├── GUIDE.md                 # Deployment guide (English)
├── GUIDE_zh.md              # Deployment guide (Chinese, this file)
└── .gitignore               # Git ignore rules
```

### index.js Core Modules

| Module | Lines | Responsibility |
|--------|-------|----------------|
| Constants & Helpers | ~30 | `VERSION`, CORS, JSON responses, HTML escaping |
| `TokenBucket` | ~40 | Token bucket rate limiting algorithm |
| `RpmCounter` | ~40 | 60-second sliding window rate counter |
| `makeTranslators()` | ~120 | Factory: dynamically reads model map, OpenAI/Anthropic format conversion |
| `serveAdmin()` | ~370 | Admin panel HTML/CSS/JS (4 tabs, provider config, logs) |
| `NV_B` (Durable Object) | ~450 | Config loading, key management, rate limiting, forwarding, logging |
| `export default` | ~15 | Worker entry + Cron keep-alive trigger |

### wrangler.toml Configuration

| Config | Type | Purpose |
|--------|------|---------|
| `[[kv_namespaces]]` | KV namespace | Persistent API key + provider config storage, bound as `NVIDIA_KV` |
| `[[durable_objects.bindings]]` | Durable Objects | Rate limiting + stats, bound as `NV_C`, class `NV_B` |
| `[[migrations]]` | DO migration | Creates the `NV_B` DO class on first deploy |
| `[triggers]` | Cron trigger | Every 5 minutes, keeps DO alive to prevent eviction |
| `[vars]` | Environment vars | Configurable `ADMIN_PATH` (dashboard path) and `AUTH_TOKEN` (API + admin auth) |

---

## 9. FAQ

### Q: Deployment fails with KV binding error?
Make sure the KV Namespace ID is correctly filled in `wrangler.toml`.

### Q: Dashboard shows "Failed to load"?
1. Open browser dev tools (F12) to check the error
2. Verify `ADMIN_PATH` is correctly set
3. Ensure the latest Worker code is deployed

### Q: Proxy returns 500?
1. Check that API keys have been added in the dashboard
2. Verify keys are valid (not expired, not rate-limited)
3. Check `__debug` for per-key status and rates

### Q: Returns 401 Unauthorized?
You have `AUTH_TOKEN` set but didn't include the auth header. Fix:
```bash
# Include Authorization header in requests
curl https://your-domain/v1/chat/completions \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{"model":"...","messages":[...]}'
```
Or remove `AUTH_TOKEN` from `wrangler.toml` and redeploy.

### Q: Not enough total throughput?
**Add more keys.** Each additional key adds perKeyRPM to the theoretical max. Queue limit and theoretical rate update automatically.

### Q: Utilization consistently >80%?
Your request volume is approaching your key pool's limit. Add more keys to scale.

### Q: How to switch providers?
Admin panel → Provider tab → Edit upstream URL, RPM, and model mapping → Click "Save", takes effect immediately, no code changes needed.

### Q: How to update the code?
```bash
# Modify src/index.js then redeploy
npm run deploy
```
Or paste the updated code into the Cloudflare Workers editor.

---

> This project was entirely generated by AI.
>
> If you need help with deployment or configuration, share this guide with any AI assistant (ChatGPT, Claude, SOLO, etc.) for step-by-step guidance.
