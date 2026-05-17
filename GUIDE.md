# NVIDIA Proxy — Complete Deployment Guide

[中文版](GUIDE_zh.md)

## Overview

A Cloudflare Workers-based reverse proxy for NVIDIA APIs, automatically managing multi-key rotation, adaptive rate limiting, rate statistics, and failover.

```
Request → Cloudflare Worker → NV_B (Durable Object)
                               ├── Per-key rate limit (38 RPM) + rate stats
                               ├── Key1 token bucket + rate stats
                               ├── Key2 token bucket + rate stats
                               ├── Key3 token bucket + rate stats
                               └── Forward → integrate.api.nvidia.com
```

### v3 Features

| Feature | Description |
|---------|-------------|
| **Adaptive Rate Limiting** | Auto-calculates queue limits based on key count; adding/removing keys takes effect instantly |
| **Rate Statistics** | 60-second sliding window for real-time per-key RPM tracking |
| **Theoretical Rate** | Dashboard displays `keyCount × 38 RPM` max throughput |
| **Utilization Monitoring** | `current / theoretical × 100%`, yellow warning at >80% |
| **Cumulative Requests** | Total requests since DO startup |
| **Per-Key RPM** | Individual key RPM shown in dashboard |

### Cloudflare Storage Used

This project uses two Cloudflare persistent storage services:

| Service | Purpose | Details |
|---------|---------|---------|
| **Durable Objects (DO)** | Rate limiting + stats | Global singleton, precise per-key rate limiting. With sliding window counters for real-time RPM stats. Stateful — survives Worker cold starts |
| **KV (Key-Value)** | API Key storage | All NVIDIA keys are stored in KV, manageable via dashboard or API. Persists across restarts and redeployments |

**Why Durable Objects?**
- Workers are **stateless** — requests may land on different instances
- Local in-memory counters wouldn't be accurate across instances
- DO provides a **global singleton** — all requests hit the same DO for rate limiting
- Cron trigger sends a keep-alive every 5 minutes to prevent DO eviction

**Why KV?**
- Stores the API key list, supports dynamic add/remove without code changes
- Unlike hardcoded keys, KV can be managed online at any time

---

## 1. Prerequisites

| Requirement | Details |
|-------------|---------|
| Cloudflare account | Workers feature enabled |
| Node.js >= 18 | Required for wrangler CLI |
| NVIDIA API Key | At least one, from NVIDIA Developer Platform |

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

> **KV (Key-Value)** is Cloudflare's key-value store. This project uses it to persist API keys across Worker restarts.

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

# API auth token (optional)
# If set, all proxy requests must include Authorization: Bearer <token>
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

Paste your NVIDIA API key in the input field and click **Add**.

> Key format example: `nvapi-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

### 3.2 Verify the Proxy

> If `AUTH_TOKEN` is set, add `-H "Authorization: Bearer your-token"` to requests below.
> If not set, no auth header is needed.

```bash
curl https://your-domain/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token" \
  -d '{
    "model": "meta/llama-3.1-8b-instruct",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

> Note: You do NOT include your NVIDIA API key in requests. The Worker manages keys automatically.
> If you get a 401 error, check your `AUTH_TOKEN` configuration.

---

## 4. API Reference

### 4.1 Proxy Forwarding

All non-admin paths are forwarded to `integrate.api.nvidia.com`:

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
| `/{path}/__addkey?key=xxx` | GET | Add API key |
| `/{path}/__delkey?key=xxx` | GET | Remove API key |
| `/{path}/__listkeys` | GET | List all keys with status |
| `/{path}/__clearkeys` | GET | Clear all keys |

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
| `queueLimit` | Max queue size (auto-calculated) |
| `globalTokens` | Sum of all key tokens |
| `globalNextMs` | Shortest token wait across all keys (ms) |
| `perKeyRPM` | Base rate per key (38 RPM) |
| `theoreticalRPM` | Theoretical max = `keyCount × perKeyRPM` |
| `currentRPM` | Actual RPM over the last 60s |
| `utilization` | `currentRPM / theoreticalRPM × 100%` |
| `totalRequests` | Total requests since DO startup |
| `keys[].currentRPM` | Per-key RPM over the last 60s |

Examples:

```bash
# Add a key
curl "https://your-domain/secret/__addkey?key=nvapi-xxxxxxxxxxxx"

# View status
curl "https://your-domain/secret/__debug"

# Remove a key
curl "https://your-domain/secret/__delkey?key=nvapi-xxxxxxxxxxxx"
```

---

## 5. Admin Dashboard Features

| Feature | Description |
|---------|-------------|
| API Key count | Total number of keys |
| Queue size | Requests currently queued |
| Theoretical rate | `keyCount × 38 RPM`, auto-updates |
| Current rate | Actual 60s RPM, yellow at >70% theoretical |
| Utilization | Current / theoretical %, yellow warning at >80% |
| Total tokens | Sum of all key buckets |
| Min wait | Shortest token wait across all keys (ms) |
| Total requests | Cumulative, formatted (e.g. 1.2k) |
| Add key | Paste key, click Add or press Enter |
| Delete key | Red delete button per key |
| Clear all | One-click remove all keys |
| Copy key | Click clipboard icon to copy |
| Per-key RPM | Real-time RPM beside each key (e.g. `15rpm 30t`) |
| Status | 🟢 OK / 🟡 Low balance / 🔴 Blacklisted |
| Auto-refresh | Status refreshes every 5 seconds |

---

## 6. Adaptive Rate Limiting Strategy

### Core Mechanism

The system uses `PER_KEY_RPM = 38` as the baseline and auto-derives all limits from key count:

| Parameter | Formula | Example (3 keys) | Example (6 keys) |
|-----------|---------|------------------|------------------|
| Per-key limit | `38 RPM` (fixed) | 38 RPM | 38 RPM |
| Total rate cap | `keyCount × 38 RPM` | 114 RPM | 228 RPM |
| Queue limit | `min(max(keyCount × 30, 40), 200)` | 90 | 180 |

Adding or removing a key **instantly recalculates** the queue limit. No restart or config change required. Cold start initializes on first request by auto-loading key count from KV.

### Key Refresh During Queue

When all key tokens are exhausted and requests are queued, the system re-fetches the key list from KV every 5 polling cycles. If new keys are added while requests are waiting, they're picked up immediately and included in rotation.

### Other Fixed Parameters

| Limit | Value | Description |
|-------|-------|-------------|
| Queue timeout | 65s | Returns 429 on timeout |
| Request timeout | 30s | Max wait per individual request |
| Key cache TTL | 5 min | KV read cache duration |
| Blacklist duration | 3 min | Auto-blacklist on 401/403 response |

### Rate Statistics Mechanism

- **60-second sliding window** records timestamps of each successful forward
- `currentRPM` = number of requests in the last 60-second window
- Each key tracked independently, aggregated for dashboard display
- Expired entries auto-pruned to keep memory usage low

---

## 7. Common Commands

```bash
# Local development
npm run dev

# Deploy
npm run deploy

# Real-time log tailing
npm run tail

# Check deployment status
npx wrangler deploy --dry-run
```

---

## 8. Project Structure

```
nvidia-proxy/
├── src/
│   └── worker.js        # Core worker (rate limiting + stats + admin + proxy)
├── wrangler.toml         # Cloudflare Workers configuration (KV + DO + Cron)
├── package.json          # Project metadata & scripts
├── README.md             # Project README (English)
├── README_zh.md          # Project README (Chinese)
├── GUIDE.md              # Deployment guide (English, this file)
├── GUIDE_zh.md           # Deployment guide (Chinese)
└── .gitignore            # Git ignore rules
```

### worker.js Core Modules

| Module | ~Lines | Responsibility |
|--------|--------|----------------|
| Constants & utilities | ~30 | `PER_KEY_RPM`, CORS, JSON helpers |
| `serveAdmin()` | ~275 | Full admin dashboard HTML/CSS/JS (dark UI) |
| `TokenBucket` | ~40 | Token bucket algorithm, runtime `updateLimits()` |
| `NV_B` (Durable Object) | ~360 | Rate limiting, stats, key management, request forwarding |
| `export default` | ~15 | Worker entrypoint + Cron keep-alive trigger |

### wrangler.toml Configuration

| Config | Type | Purpose |
|--------|------|---------|
| `[[kv_namespaces]]` | KV namespace | Persistent API key storage, bound as `NVIDIA_KV` |
| `[[durable_objects.bindings]]` | Durable Objects | Rate limiting + stats, bound as `NV_C`, class `NV_B` |
| `[[migrations]]` | DO migration | Creates the `NV_B` DO class on first deploy |
| `[triggers]` | Cron trigger | Every 5 minutes, keeps DO alive to prevent eviction |
| `[vars]` | Environment vars | Configurable `ADMIN_PATH` (dashboard path) and `AUTH_TOKEN` (API auth) |

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
**Add more keys.** Each additional key adds 38 RPM to the theoretical max. Queue limit and theoretical rate update automatically.

### Q: Utilization consistently >80%?
Your request volume is approaching your key pool's limit. Add more keys to scale.

### Q: How to update the code?
```bash
# Modify src/worker.js then redeploy
npm run deploy
```

---

> This project was entirely generated by AI.
>
> If you need help with deployment or configuration, share this guide with any AI assistant (ChatGPT, Claude, SOLO, etc.) for step-by-step guidance.

