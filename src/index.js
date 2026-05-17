const VERSION            = "v6.0.0";
const QUEUE_TIMEOUT_MS   = 65_000;
const REQUEST_TIMEOUT_MS = 30_000;
const KEY_CACHE_TTL_MS   = 5 * 60_000;
const MAX_BODY_SIZE      = 10 * 1024 * 1024;
const MAX_LOGS           = 100;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const sleep       = (ms) => new Promise(r => setTimeout(r, ms));
const safeCancel  = async (res) => { try { await res.body?.cancel(); } catch {} };
const _encoder    = new TextEncoder();
const _decoder    = new TextDecoder();

function cors(res) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) h.set(k, v);
  return new Response(res.body, { status: res.status, headers: h });
}

function jsonReply(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  });
}

// HTML 转义（服务端渲染用）
function _html(s) {
  return (s != null ? String(s) : '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/** 默认提供商配置（首次部署时自动写入 KV） */
function defaultProviderConfig() {
  return {
    name: "NVIDIA",
    upstream: "https://integrate.api.nvidia.com",
    perKeyRpm: 38,
    modelMap: {
      "claude-sonnet-4-20250514":     "nvidia/llama-3.1-nemotron-ultra-253b-v1",
      "claude-sonnet-4":              "nvidia/llama-3.1-nemotron-ultra-253b-v1",
      "claude-3-5-sonnet-20241022":   "nvidia/llama-3.1-nemotron-ultra-253b-v1",
      "claude-3-5-haiku-20241022":    "meta/llama-3.2-90b-vision-instruct",
      "claude-opus-4-20250514":       "nvidia/llama-3.1-nemotron-ultra-253b-v1",
    }
  };
}

// ─── Token Bucket ────────────────────────────────────────────────

class TokenBucket {
  constructor(ratePerMin) {
    this.ratePerMin = ratePerMin;
    this.tokens     = ratePerMin;
    this.max        = ratePerMin;
    this.lastRefill = 0;
  }

  refill(now) {
    this.tokens = Math.min(this.max, this.tokens + (now - this.lastRefill) * this.ratePerMin / 60000);
    this.lastRefill = now;
  }

  tryConsume(now) {
    this.refill(now);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  nextTokenMs(now) {
    this.refill(now);
    if (this.tokens >= 1) return 0;
    return (1 - this.tokens) * 60000 / this.ratePerMin + 1;
  }

  drain() { this.tokens = 0; }
}

class RpmCounter {
  constructor() {
    this.slots    = new Uint16Array(60);
    this.cursor   = 0;
    this.lastTs   = 0;
  }

  tick(now, count = 1) {
    const sec = now >>> 0;
    if (sec !== this.lastTs) {
      if (this.lastTs && sec - this.lastTs < 60) {
        let i = this.lastTs % 60;
        const end = sec % 60;
        if (end > i) {
          this.slots.fill(0, i, end);
        } else {
          this.slots.fill(0, i, 60);
          this.slots.fill(0, 0, end);
        }
      } else if (sec - this.lastTs >= 60) {
        this.slots.fill(0);
      }
      this.lastTs = sec;
      this.cursor = sec % 60;
    }
    this.slots[this.cursor] += count;
  }

  value() {
    const sec = Date.now() / 1000 >>> 0;
    if (sec - this.lastTs > 60) return 0;
    let s = 0;
    for (let i = 0; i < 60; i++) s += this.slots[i];
    return s;
  }
}

// ─── Format Translators ──────────────────────────────────────────

function makeTranslators(getModelMap) {
  return {
    openai: {
      translateRequest(body) { return body; },
      translateResponse(body) { return body; },
      transformStream(stream) { return stream; },
    },

    anthropic: {
      translateRequest(body) {
        const modelMap = getModelMap();
        const messages = [];
        if (body.system) {
          const text = typeof body.system === "string"
            ? body.system
            : Array.isArray(body.system)
              ? body.system.map(b => b.text).filter(Boolean).join("\n")
              : "";
          if (text) messages.push({ role: "system", content: text });
        }
        for (const msg of body.messages || []) {
          if (typeof msg.content === "string") {
            messages.push({ role: msg.role, content: msg.content });
          } else if (Array.isArray(msg.content)) {
            const textParts = msg.content.filter(b => b.type === "text").map(b => b.text);
            if (textParts.length) {
              messages.push({ role: msg.role, content: textParts.join("\n") });
            }
          }
        }
        return {
          model: modelMap[body.model] || body.model || "nvidia/llama-3.1-nemotron-ultra-253b-v1",
          messages,
          max_tokens: body.max_tokens || 4096,
          temperature: body.temperature,
          top_p: body.top_p,
          stream: body.stream || false,
          stop: body.stop_sequences,
        };
      },

      translateResponse(body, requestBody) {
        const choice = body.choices?.[0];
        if (!choice) {
          return { type: "error", error: { message: "No response from upstream" } };
        }
        return {
          id: "msg_" + (body.id || crypto.randomUUID()).replace(/^chatcmpl-/, ""),
          type: "message",
          role: choice.message?.role || "assistant",
          content: [{ type: "text", text: choice.message?.content || "" }],
          model: body.model || requestBody?.model || "unknown",
          stop_reason: choice.finish_reason === "stop" ? "end_turn"
            : choice.finish_reason === "length" ? "max_tokens"
            : choice.finish_reason || null,
          stop_sequence: null,
          usage: {
            input_tokens: body.usage?.prompt_tokens || 0,
            output_tokens: body.usage?.completion_tokens || 0,
          },
        };
      },

      transformStream(stream, requestBody) {
        const modelMap = getModelMap();
        let state = "init";
        let buffer = "";
        const messageId = "msg_" + crypto.randomUUID();
        const model = modelMap[requestBody?.model] || requestBody?.model || "unknown";
        return stream.pipeThrough(new TransformStream({
          transform(chunk, controller) {
            buffer += _decoder.decode(chunk, { stream: true });
            const idx = buffer.lastIndexOf("\n");
            if (idx === -1) return;
            const complete = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            const lines = complete.split("\n");
            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const raw = line.slice(6).trim();
              if (!raw || raw === "[DONE]") continue;
              let openai;
              try { openai = JSON.parse(raw); } catch { continue; }
              const choice = openai.choices?.[0];
              if (!choice) continue;
              if (state === "init") {
                controller.enqueue(_encoder.encode("event: message_start\ndata: " + JSON.stringify({
                  type: "message_start",
                  message: { id: messageId, type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }
                }) + "\n\n"));
                controller.enqueue(_encoder.encode("event: content_block_start\ndata: " + JSON.stringify({
                  type: "content_block_start", index: 0, content_block: { type: "text", text: "" }
                }) + "\n\n"));
                state = "content";
              }
              if (choice.delta?.content) {
                controller.enqueue(_encoder.encode("event: content_block_delta\ndata: " + JSON.stringify({
                  type: "content_block_delta", index: 0, delta: { type: "text_delta", text: choice.delta.content }
                }) + "\n\n"));
              }
              if (choice.finish_reason) {
                controller.enqueue(_encoder.encode("event: content_block_stop\ndata: " + JSON.stringify({
                  type: "content_block_stop", index: 0
                }) + "\n\n"));
                const stopReason = choice.finish_reason === "stop" ? "end_turn"
                  : choice.finish_reason === "length" ? "max_tokens"
                  : choice.finish_reason;
                controller.enqueue(_encoder.encode("event: message_delta\ndata: " + JSON.stringify({
                  type: "message_delta",
                  delta: { stop_reason: stopReason, stop_sequence: null },
                  usage: { output_tokens: openai.usage?.completion_tokens || 0 }
                }) + "\n\n"));
                controller.enqueue(_encoder.encode("event: message_stop\ndata: {}\n\n"));
                state = "done";
              }
            }
          },
          flush(controller) {
            if (buffer.trim()) {
              const line = buffer.trim();
              if (line.startsWith("data: ")) {
                const raw = line.slice(6).trim();
                if (raw && raw !== "[DONE]") {
                  try {
                    const openai = JSON.parse(raw);
                    const choice = openai.choices?.[0];
                    if (choice && choice.finish_reason && state !== "done") {
                      controller.enqueue(_encoder.encode("event: content_block_stop\ndata: " + JSON.stringify({
                        type: "content_block_stop", index: 0
                      }) + "\n\n"));
                      const stopReason = choice.finish_reason === "stop" ? "end_turn"
                        : choice.finish_reason === "length" ? "max_tokens"
                        : choice.finish_reason;
                      controller.enqueue(_encoder.encode("event: message_delta\ndata: " + JSON.stringify({
                        type: "message_delta",
                        delta: { stop_reason: stopReason, stop_sequence: null },
                        usage: { output_tokens: openai.usage?.completion_tokens || 0 }
                      }) + "\n\n"));
                      controller.enqueue(_encoder.encode("event: message_stop\ndata: {}\n\n"));
                    }
                  } catch {}
                }
              }
            }
          },
        }));
      },
    },
  };
}

// ─── Admin HTML ──────────────────────────────────────────────────

function serveAdmin(adminPath, hasAuth, config) {
  const defaultName = config?.name || "NVIDIA";
  const defaultUpstream = config?.upstream || "https://integrate.api.nvidia.com";
  const defaultRpm = config?.perKeyRpm || 38;

  return new Response(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>API Proxy 管理</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0d1117; color: #e6edf3; min-height: 100vh;
  }
  .container { max-width: 960px; margin: 0 auto; padding: 32px 20px; }
  h1 {
    font-size: 22px; font-weight: 600; margin-bottom: 24px;
    display: flex; align-items: center; gap: 10px;
  }
  h1 span { background: #238636; font-size: 12px; padding: 2px 8px; border-radius: 20px; font-weight: 500; }
  .tabs { display: flex; gap: 4px; margin-bottom: 24px; border-bottom: 1px solid #30363d; }
  .tab {
    padding: 10px 18px; cursor: pointer; font-size: 14px; font-weight: 500;
    color: #8b949e; border-bottom: 2px solid transparent; transition: .15s;
  }
  .tab:hover { color: #e6edf3; }
  .tab.active { color: #e6edf3; border-bottom-color: #58a6ff; }
  .tab-content { display: none; }
  .tab-content.active { display: block; }
  .stats {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin-bottom: 24px;
  }
  .stat-card {
    background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 14px 16px;
  }
  .stat-card .label { font-size: 12px; color: #8b949e; margin-bottom: 4px; }
  .stat-card .value { font-size: 22px; font-weight: 600; }
  .stat-card .value.warn { color: #d29922; }
  .stat-card .value.good { color: #3fb950; }
  .stat-card .value.bad { color: #f85149; }
  .section {
    background: #161b22; border: 1px solid #30363d; border-radius: 8px; margin-bottom: 16px;
  }
  .section-header {
    padding: 14px 16px; border-bottom: 1px solid #30363d;
    font-size: 14px; font-weight: 600; display: flex; justify-content: space-between; align-items: center;
  }
  .add-row {
    display: flex; gap: 8px; padding: 12px 16px;
  }
  .add-row input, .form-row input {
    flex: 1; background: #0d1117; border: 1px solid #30363d; border-radius: 6px;
    padding: 8px 12px; color: #e6edf3; font-size: 13px; outline: none;
  }
  .add-row input:focus, .form-row input:focus { border-color: #58a6ff; }
  .form-row {
    display: flex; gap: 8px; padding: 12px 16px; align-items: center;
  }
  .form-row label {
    font-size: 13px; color: #8b949e; min-width: 80px; flex-shrink: 0;
  }
  .form-row input[type="text"], .form-row input[type="number"] {
    flex: 1;
  }
  .btn {
    padding: 8px 16px; border: none; border-radius: 6px; font-size: 13px; font-weight: 500;
    cursor: pointer; white-space: nowrap; transition: .15s;
  }
  .btn:active { transform: scale(.97); }
  .btn:disabled { opacity: .5; cursor: not-allowed; transform: none; }
  .btn-primary { background: #238636; color: #fff; }
  .btn-primary:hover:not(:disabled) { background: #2ea043; }
  .btn-danger { background: #da3633; color: #fff; }
  .btn-danger:hover:not(:disabled) { background: #f85149; }
  .btn-warn { background: #d29922; color: #fff; }
  .btn-warn:hover:not(:disabled) { background: #e3b341; }
  .btn-sm { padding: 4px 10px; font-size: 12px; }
  .btn-ghost { background: transparent; color: #f85149; border: 1px solid #f85149; }
  .btn-ghost:hover:not(:disabled) { background: #f851491a; }
  .key-list { }
  .key-item {
    display: flex; justify-content: space-between; align-items: center;
    padding: 10px 16px; border-bottom: 1px solid #21262d; font-size: 13px;
  }
  .key-item:last-child { border-bottom: none; }
  .key-item .key-info { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
  .key-item .key-text {
    font-family: "SF Mono", "Fira Code", monospace; font-size: 12px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .key-item .status-dot {
    width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
  }
  .status-dot.active { background: #3fb950; }
  .status-dot.blocked { background: #f85149; }
  .status-dot.exhausted { background: #d29922; }
  .key-item .actions { display: flex; gap: 6px; flex-shrink: 0; }
  .empty-state {
    padding: 32px 16px; text-align: center; color: #8b949e; font-size: 14px;
  }
  .error-state {
    padding: 32px 16px; text-align: center; color: #f85149; font-size: 14px;
  }
  .toast {
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    background: #1c2128; border: 1px solid #30363d; border-radius: 8px;
    padding: 10px 20px; font-size: 13px; box-shadow: 0 8px 24px rgba(0,0,0,.4);
    opacity: 0; transition: opacity .25s; pointer-events: none; z-index: 999;
  }
  .toast.show { opacity: 1; }
  .toast.success { border-color: #238636; }
  .toast.error { border-color: #da3633; }
  .footer { text-align: center; font-size: 12px; color: #484f58; padding: 16px 0; }
  .copy-btn { background: transparent; border: none; color: #8b949e; cursor: pointer; padding: 2px 6px; font-size: 13px; }
  .copy-btn:hover { color: #e6edf3; }
  .model-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .model-table th {
    text-align: left; padding: 10px 16px; border-bottom: 1px solid #30363d;
    color: #8b949e; font-weight: 500; font-size: 12px;
  }
  .model-table td { padding: 6px 16px; border-bottom: 1px solid #21262d; }
  .model-table td input {
    width: 100%; background: #0d1117; border: 1px solid #30363d; border-radius: 4px;
    padding: 6px 8px; color: #e6edf3; font-size: 13px; outline: none; font-family: "SF Mono", "Fira Code", monospace;
  }
  .model-table td input:focus { border-color: #58a6ff; }
  .model-table .model-actions { display: flex; gap: 4px; }
  .model-add-row td { padding: 8px 16px; }
  .model-add-row input { font-family: "SF Mono", "Fira Code", monospace; }
  .config-info { font-size: 12px; color: #484f58; padding: 8px 16px; }
  .log-list { max-height: 300px; overflow-y: auto; }
  .log-item {
    padding: 8px 16px; border-bottom: 1px solid #21262d; font-size: 12px; font-family: "SF Mono", "Fira Code", monospace;
    color: #8b949e; word-break: break-all;
  }
  .log-item:last-child { border-bottom: none; }
  .log-item .log-time { color: #484f58; }
  .log-item .log-err { color: #f85149; }
  @media (max-width: 600px) {
    .container { padding: 16px 12px; }
    .stats { grid-template-columns: repeat(2, 1fr); }
    .key-item { flex-wrap: wrap; gap: 8px; }
    .key-item .actions { width: 100%; justify-content: flex-end; }
    .form-row { flex-wrap: wrap; }
    .form-row label { min-width: 100%; }
  }
  .provider-badge {
    display: inline-flex; align-items: center; gap: 6px;
    background: #161b22; border: 1px solid #30363d; border-radius: 6px;
    padding: 4px 12px; font-size: 12px; color: #8b949e;
  }
  .provider-badge strong { color: #e6edf3; }
</style>
</head>
<body>
<div class="container">
  <h1>
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#76b900" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
    API Proxy
    <span>${VERSION}</span>
    <span class="provider-badge" id="providerBadge">提供商: <strong id="providerName">${_html(defaultName)}</strong></span>
  </h1>

  <div class="tabs">
    <div class="tab active" onclick="switchTab('dashboard')">仪表盘</div>
    <div class="tab" onclick="switchTab('keys')">API Keys</div>
    <div class="tab" onclick="switchTab('provider')">提供商</div>
    <div class="tab" onclick="switchTab('logs')">日志</div>
  </div>

  <!-- 仪表盘 -->
  <div class="tab-content active" id="tab-dashboard">
    <div class="stats" id="stats">
      <div class="stat-card"><div class="label">API Keys</div><div class="value" id="keyCount">-</div></div>
      <div class="stat-card"><div class="label">排队中</div><div class="value" id="queueSize">-</div></div>
      <div class="stat-card"><div class="label">理论速率</div><div class="value" id="theoreticalRPM">-</div></div>
      <div class="stat-card"><div class="label">当前速率</div><div class="value" id="currentRPM">-</div></div>
      <div class="stat-card"><div class="label">利用率</div><div class="value" id="utilization">-</div></div>
      <div class="stat-card"><div class="label">总令牌</div><div class="value" id="globalTokens">-</div></div>
      <div class="stat-card"><div class="label">最短等待</div><div class="value" id="globalNextMs">-</div></div>
      <div class="stat-card"><div class="label">累计请求</div><div class="value" id="totalRequests">-</div></div>
    </div>
  </div>

  <!-- API Keys -->
  <div class="tab-content" id="tab-keys">
    <div class="section">
      <div class="section-header">
        <span>管理 API Key</span>
        <button class="btn btn-danger btn-sm" onclick="clearAll()">清空全部</button>
      </div>
      <div class="add-row">
        <input type="text" id="keyInput" placeholder="输入新的 API Key（如 nvapi-... 或 sk-...）" spellcheck="false">
        <button class="btn btn-primary" onclick="addKey()">添加</button>
      </div>
      <div class="key-list" id="keyList">
        <div class="empty-state">加载中...</div>
      </div>
    </div>
  </div>

  <!-- 提供商设置 -->
  <div class="tab-content" id="tab-provider">
    <div class="section">
      <div class="section-header">
        <span>提供商配置</span>
        <div>
          <button class="btn btn-warn btn-sm" onclick="resetProvider()" style="margin-right:6px">恢复默认</button>
          <button class="btn btn-primary btn-sm" onclick="saveProvider()">保存配置</button>
        </div>
      </div>
      <div class="form-row">
        <label>提供商名称</label>
        <input type="text" id="cfgName" value="${_html(defaultName)}" placeholder="如 NVIDIA、OpenAI、Groq">

      </div>
      <div class="form-row">
        <label>上游地址</label>
        <input type="text" id="cfgUpstream" value="${_html(defaultUpstream)}" placeholder="https://integrate.api.nvidia.com">
      </div>
      <div class="form-row">
        <label>每 Key RPM</label>
        <input type="number" id="cfgRpm" value="${defaultRpm}" min="1" max="10000">
      </div>
      <div class="section-header" style="border-top:1px solid #30363d;margin-top:4px">
        <span>模型映射</span>
        <button class="btn btn-primary btn-sm" onclick="addModelRow()">+ 添加映射</button>
      </div>
      <table class="model-table">
        <thead><tr><th style="width:45%">客户端模型名</th><th style="width:45%">上游模型名</th><th style="width:10%">操作</th></tr></thead>
        <tbody id="modelTableBody">
        </tbody>
        <tfoot>
          <tr class="model-add-row">
            <td><input type="text" id="newModelKey" placeholder="如 claude-sonnet-4"></td>
            <td><input type="text" id="newModelVal" placeholder="如 nvidia/llama-3.1-nemotron-ultra-253b-v1"></td>
            <td><button class="btn btn-primary btn-sm" onclick="addModelRow()">添加</button></td>
          </tr>
        </tfoot>
      </table>
      <div class="config-info">修改后点击「保存配置」立即生效，无需重启。</div>
    </div>
  </div>

  <!-- 日志 -->
  <div class="tab-content" id="tab-logs">
    <div class="section">
      <div class="section-header">
        <span>最近错误日志</span>
        <button class="btn btn-ghost btn-sm" onclick="loadLogs()">刷新</button>
      </div>
      <div class="log-list" id="logList">
        <div class="empty-state">加载中...</div>
      </div>
    </div>
  </div>

  <div class="footer">API Proxy &middot; ${VERSION}</div>
</div>
<div class="toast" id="toast"></div>
<script>
${hasAuth ? `const AUTH_TOKEN = sessionStorage.getItem('proxy_token');
if (!AUTH_TOKEN) {
  const token = prompt('请输入 AUTH_TOKEN 以访问管理面板：');
  if (token) { sessionStorage.setItem('proxy_token', token); location.reload(); }
  else { document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;background:#0d1117;color:#e6edf3;font-size:16px">需要认证才能访问管理面板</div>'; }
}` : 'const AUTH_TOKEN = null;'}
const ADMIN_PATH = '${adminPath}';
const BASE = location.origin + '/' + ADMIN_PATH;

function apiHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (AUTH_TOKEN) h['Authorization'] = 'Bearer ' + AUTH_TOKEN;
  return h;
}

function toast(msg, type) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = 'toast ' + (type || 'success') + ' show';
  setTimeout(() => el.classList.remove('show'), 3000);
}

async function api(path) {
  const res = await fetch(BASE + path, { headers: apiHeaders() });
  if (!res.ok) {
    let msg;
    try { const j = await res.json(); msg = j.error || res.statusText; } catch { msg = res.statusText; }
    throw new Error(msg);
  }
  return res.json();
}

function showError(msg) {
  document.getElementById('keyList').innerHTML = '<div class="error-state">加载失败: ' + escapeHtml(msg) + '</div>';
}

function switchTab(name) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  document.querySelector('.tab[onclick*="' + name + '"]')?.classList.add('active');
  if (name === 'logs') loadLogs();
}

async function loadAll() {
  try {
    const [debug, list] = await Promise.all([
      api('/__debug'),
      api('/__listkeys')
    ]);
    renderStats(debug);
    renderKeys(list);
  } catch (e) {
    showError(e.message);
  }
}

function renderStats(d) {
  document.getElementById('keyCount').textContent = d.keyCount;
  document.getElementById('queueSize').textContent = d.queueSize;
  document.getElementById('theoreticalRPM').textContent = d.theoreticalRPM + ' RPM';
  const cr = document.getElementById('currentRPM');
  cr.textContent = d.currentRPM + ' RPM';
  cr.className = 'value' + (d.currentRPM > d.theoreticalRPM * 0.7 ? ' warn' : ' good');
  const util = document.getElementById('utilization');
  util.textContent = d.utilization.toFixed(1) + '%';
  util.className = 'value' + (d.utilization > 80 ? ' warn' : d.utilization > 50 ? '' : ' good');
  const gt = document.getElementById('globalTokens');
  gt.textContent = Math.floor(d.globalTokens);
  gt.className = 'value' + (d.globalTokens < 20 ? ' warn' : ' good');
  const gn = document.getElementById('globalNextMs');
  gn.textContent = d.globalNextMs + 'ms';
  gn.className = 'value' + (d.globalNextMs > 1000 ? ' warn' : ' good');
  const tr = document.getElementById('totalRequests');
  tr.textContent = d.totalRequests >= 1000 ? (d.totalRequests / 1000).toFixed(1) + 'k' : d.totalRequests;
  if (d.providerName) {
    document.getElementById('providerName').textContent = d.providerName;
  }
}

function renderKeys(d) {
  const el = document.getElementById('keyList');
  if (!d.keys.length) {
    el.innerHTML = '<div class="empty-state">还没有 API Key，在上方输入添加</div>';
    return;
  }
  el.innerHTML = d.keys.map(k => {
    const dotClass = k.blacklisted ? 'blocked' : k.tokens < 5 ? 'exhausted' : 'active';
    const statusHint = k.blacklisted ? '已拉黑（自动恢复）' : k.tokens < 5 ? '额度不足' : '正常';
    return '<div class="key-item">'
      + '<div class="key-info">'
      + '<span class="status-dot ' + dotClass + '" title="' + statusHint + '"></span>'
      + '<span class="key-text" title="' + escapeAttr(k.key) + '">' + escapeHtml(k.key) + '</span>'
      + '<button class="copy-btn" onclick="copyKey(this)" data-key="' + escapeAttr(k.key) + '" title="复制">📋</button>'
      + '</div>'
      + '<div class="actions">'
      + '<span style="font-size:11px;color:#8b949e;margin-right:4px">' + k.currentRPM + ' rpm</span>'
      + '<span style="font-size:11px;color:#8b949e;margin-right:4px">' + k.tokens + ' t</span>'
      + '<button class="btn btn-sm btn-ghost" onclick="delKey(this)" data-key="' + escapeAttr(k.key) + '">删除</button>'
      + '</div>'
      + '</div>';
  }).join('');
}

function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escapeAttr(s) { return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;'); }

function copyKey(btn) {
  navigator.clipboard.writeText(btn.dataset.key).then(() => toast('已复制'), () => toast('复制失败', 'error'));
}

async function addKey() {
  const input = document.getElementById('keyInput');
  const key = input.value.trim();
  if (!key) { toast('请输入 Key', 'error'); return; }
  const btn = document.querySelector('.add-row .btn-primary');
  btn.disabled = true;
  try {
    const r = await fetch(BASE + '/__addkey', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ key })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    toast(d.message);
    input.value = '';
    await loadAll();
  } catch (e) { toast(e.message, 'error'); }
  btn.disabled = false;
}

async function delKey(btn) {
  btn.disabled = true;
  const key = btn.dataset.key;
  try {
    const r = await fetch(BASE + '/__delkey', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ key })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    toast(d.message);
    await loadAll();
  } catch (e) { toast(e.message, 'error'); }
  btn.disabled = false;
}

async function clearAll() {
  if (!confirm('确定清空所有 API Key？')) return;
  try {
    const r = await fetch(BASE + '/__clearkeys', {
      method: 'POST',
      headers: apiHeaders()
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    toast(d.message);
    await loadAll();
  } catch (e) { toast(e.message, 'error'); }
}

// ─── 提供商配置 ──────────────────────────────────────────────────

let models = [];

async function loadProvider() {
  try {
    const cfg = await api('/__getconfig');
    document.getElementById('cfgName').value = cfg.name || '';
    document.getElementById('cfgUpstream').value = cfg.upstream || '';
    document.getElementById('cfgRpm').value = cfg.perKeyRpm || 38;
    models = cfg.modelMap ? Object.entries(cfg.modelMap).map(([k, v]) => [k, v]) : [];
    renderModels();
    if (cfg.name) document.getElementById('providerName').textContent = cfg.name;
  } catch (e) {
    toast('加载配置失败: ' + e.message, 'error');
  }
}

function renderModels() {
  const tbody = document.getElementById('modelTableBody');
  if (!models.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty-state">暂无模型映射</td></tr>';
    return;
  }
  tbody.innerHTML = models.map((m, i) => '<tr>'
    + '<td><input type="text" value="' + escapeAttr(m[0]) + '" onchange="models[' + i + '][0]=this.value"></td>'
    + '<td><input type="text" value="' + escapeAttr(m[1]) + '" onchange="models[' + i + '][1]=this.value"></td>'
    + '<td class="model-actions"><button class="btn btn-sm btn-ghost" onclick="delModel(' + i + ')">删除</button></td>'
    + '</tr>').join('');
}

function addModelRow() {
  const keyInput = document.getElementById('newModelKey');
  const valInput = document.getElementById('newModelVal');
  const key = keyInput.value.trim();
  const val = valInput.value.trim();
  if (key && val) {
    models.push([key, val]);
    renderModels();
    keyInput.value = '';
    valInput.value = '';
    toast('已添加映射');
  } else {
    // 直接添加空行方便输入
    models.push(['', '']);
    renderModels();
  }
}

function delModel(idx) {
  models.splice(idx, 1);
  renderModels();
}

async function saveProvider() {
  const name = document.getElementById('cfgName').value.trim();
  const upstream = document.getElementById('cfgUpstream').value.trim();
  const perKeyRpm = parseInt(document.getElementById('cfgRpm').value) || 38;
  if (!name) { toast('请输入提供商名称', 'error'); return; }
  if (!upstream) { toast('请输入上游地址', 'error'); return; }
  const modelMap = {};
  for (const m of models) {
    if (m[0].trim() && m[1].trim()) modelMap[m[0].trim()] = m[1].trim();
  }
  const btn = document.querySelector('#tab-provider .btn-primary');
  btn.disabled = true;
  try {
    const r = await fetch(BASE + '/__setconfig', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ name, upstream, perKeyRpm, modelMap })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    toast('配置已保存并生效');
    document.getElementById('providerName').textContent = name;
  } catch (e) { toast(e.message, 'error'); }
  btn.disabled = false;
}

async function resetProvider() {
  if (!confirm('确定恢复默认提供商配置（NVIDIA）？')) return;
  try {
    const r = await fetch(BASE + '/__resetconfig', {
      method: 'POST',
      headers: apiHeaders()
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    toast('已恢复默认配置');
    await loadProvider();
  } catch (e) { toast(e.message, 'error'); }
}

// ─── 日志 ────────────────────────────────────────────────────────

async function loadLogs() {
  const el = document.getElementById('logList');
  el.innerHTML = '<div class="empty-state">加载中...</div>';
  try {
    const d = await api('/__logs');
    if (!d.logs || !d.logs.length) {
      el.innerHTML = '<div class="empty-state">暂无错误日志</div>';
      return;
    }
    el.innerHTML = d.logs.map(log =>
      '<div class="log-item"><span class="log-time">' + escapeHtml(log.t || '') + '</span> '
      + '<span class="log-err">[' + escapeHtml(log.l || '?') + ']</span> '
      + escapeHtml(log.m || '')
      + '</div>'
    ).join('');
  } catch (e) {
    el.innerHTML = '<div class="error-state">加载日志失败: ' + escapeHtml(e.message) + '</div>';
  }
}

document.getElementById('keyInput').addEventListener('keydown', e => { if (e.key === 'Enter') addKey(); });

loadAll();
setInterval(loadAll, 5000);

// 加载提供商配置（切换到提供商 tab 时也会重新加载）
loadProvider();
</script>
</body>
</html>`, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

// ─── NV_B Durable Object ─────────────────────────────────────────

export class NV_B {
  constructor(state, env) {
    this.state         = state;
    this.env           = env;
    this.keyBuckets    = new Map();
    this.blacklist     = new Map();
    this.cachedKeys    = [];
    this.keysCachedAt  = 0;
    this.cachedConfig  = null;
    this.configCachedAt = 0;
    this.queueSize     = 0;
    this.queueLimit    = 80;
    this.adminPath     = (env.ADMIN_PATH || 'admin').replace(/^\/+|\/+$/g, '');
    this.totalRequests = 0;
    this.rpmCounter    = new RpmCounter();
    this.keyRpmCounters = new Map();
    this.perKeyRPM     = 38;
    this.limitsInited  = false;
    this.pingCount     = 0;
    this.pingWindowStart = Date.now();

    // 创建 translators（通过闭包动态读取 modelMap）
    this.translators = makeTranslators(() => this.getModelMapSync());
  }

  getModelMapSync() {
    return this.cachedConfig?.modelMap || defaultProviderConfig().modelMap;
  }

  // ─── 配置加载 ──────────────────────────────────────────────────

  getBucket(key) {
    let b = this.keyBuckets.get(key);
    if (!b) { b = new TokenBucket(this.perKeyRPM); this.keyBuckets.set(key, b); }
    return b;
  }

  async loadConfig() {
    if (this.cachedConfig && Date.now() - this.configCachedAt < KEY_CACHE_TTL_MS) {
      return this.cachedConfig;
    }
    try {
      const raw = await this.env.NVIDIA_KV.get("proxy_config");
      if (!raw) {
        // 首次部署，写入默认配置
        const def = defaultProviderConfig();
        await this.env.NVIDIA_KV.put("proxy_config", JSON.stringify(def));
        this.cachedConfig = def;
        this.configCachedAt = Date.now();
        this.perKeyRPM = def.perKeyRpm;
        return def;
      }
      this.cachedConfig = JSON.parse(raw);
      this.configCachedAt = Date.now();
      this.perKeyRPM = this.cachedConfig.perKeyRpm || 38;
      return this.cachedConfig;
    } catch (err) {
      return this.cachedConfig || defaultProviderConfig();
    }
  }

  async saveConfig(cfg) {
    await this.env.NVIDIA_KV.put("proxy_config", JSON.stringify(cfg));
    this.cachedConfig = cfg;
    this.configCachedAt = Date.now();
    this.perKeyRPM = cfg.perKeyRpm || 38;
  }

  earliestTokenMs(keys, now) {
    let min = 2000;
    for (let i = 0; i < keys.length; i++) {
      if (this.isBlacklisted(keys[i])) continue;
      const t = this.getBucket(keys[i]).nextTokenMs(now);
      if (t < min) min = t;
    }
    return min;
  }

  checkPingLimit() {
    const now = Date.now();
    if (now - this.pingWindowStart > 60_000) {
      this.pingCount = 0;
      this.pingWindowStart = now;
    }
    this.pingCount++;
    return this.pingCount <= 12;
  }

  async getKeys() {
    if (this.cachedKeys.length && Date.now() - this.keysCachedAt < KEY_CACHE_TTL_MS) {
      return this.cachedKeys;
    }
    try {
      const raw = await this.env.NVIDIA_KV.get("keys");
      if (!raw) return [];
      this.cachedKeys   = raw.split("\n").map(s => s.trim()).filter(s => s.length > 0);
      this.keysCachedAt = Date.now();
      return this.cachedKeys;
    } catch (err) {
      return this.cachedKeys;
    }
  }

  async saveKeys(keys) {
    await this.env.NVIDIA_KV.put("keys", keys.join("\n"));
    this.cachedKeys   = keys;
    this.keysCachedAt = Date.now();
  }

  isBlacklisted(key) {
    const exp = this.blacklist.get(key);
    if (!exp) return false;
    if (Date.now() > exp) { this.blacklist.delete(key); return false; }
    return true;
  }

  async markBlocked(key, code) {
    this.blacklist.set(key, Date.now() + 3 * 60_000);
    this.getBucket(key).drain();
    this.keyRpmCounters.delete(key);
    try {
      await this.env.NVIDIA_KV.put(
        "state:" + key,
        JSON.stringify({ status: "blocked", reason: code }),
        { expirationTtl: 180 }
      );
    } catch {}
  }

  recordRequest(key) {
    const now = Date.now() / 1000 >>> 0;
    this.totalRequests++;
    this.rpmCounter.tick(now);
    if (key) {
      let c = this.keyRpmCounters.get(key);
      if (!c) { c = new RpmCounter(); this.keyRpmCounters.set(key, c); }
      c.tick(now);
    }
  }

  getCurrentRPM() { return this.rpmCounter.value(); }

  getKeyRPM(key) {
    const c = this.keyRpmCounters.get(key);
    return c ? c.value() : 0;
  }

  recalcLimits(keyCount) {
    this.queueLimit = Math.min(Math.max(Math.max(keyCount, 1) * 30, 40), 200);
  }

  hasAvailableKeys(keys) {
    for (let i = 0; i < keys.length; i++) {
      if (!this.isBlacklisted(keys[i])) return true;
    }
    return false;
  }

  pickKey(keys, now) {
    for (let i = 0; i < keys.length; i++) {
      const idx = (Math.random() * keys.length) >>> 0;
      const key = keys[idx];
      if (!this.isBlacklisted(key) && this.getBucket(key).tryConsume(now)) return key;
    }
    return null;
  }

  buildHeaders(req, key) {
    const h = new Headers(req.headers);
    const drop = new Set(["host", "content-length", "transfer-encoding", "x-api-key", "anthropic-version", "anthropic-dangerous-direct-browser-access"]);
    for (const k of h.keys()) { if (drop.has(k.toLowerCase())) h.delete(k); }
    h.set("Authorization", "Bearer " + key);
    h.set("Content-Type", "application/json");
    return h;
  }

  async fetchWithTimeout(url, opt, ms) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    try {
      const res = await fetch(url, { ...opt, signal: c.signal });
      clearTimeout(t);
      return res;
    } catch (e) {
      clearTimeout(t);
      throw e;
    }
  }

  async forward(req, key, body, format) {
    const cfg = await this.loadConfig();
    const upstream = cfg.upstream || "https://integrate.api.nvidia.com";
    const url = new URL(req.url);
    const apiPath = format === 'anthropic' ? '/v1/chat/completions' : url.pathname;
    const target = upstream + apiPath + url.search;
    return this.fetchWithTimeout(target, {
      method:  req.method,
      headers: this.buildHeaders(req, key),
      body
    }, REQUEST_TIMEOUT_MS);
  }

  detectFormat(path) {
    const p = this.adminPath;
    const prefix = '/' + p;
    if (path === prefix || path.startsWith(prefix + '/') || path === '/') return null;
    if (path.includes('/v1/messages')) return 'anthropic';
    return 'openai';
  }

  // ─── 日志 ──────────────────────────────────────────────────────

  async logError(level, message) {
    try {
      const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const key = "log:" + Date.now();
      await this.env.NVIDIA_KV.put(key, JSON.stringify({ t: ts, l: level, m: message }), { expirationTtl: 86400 });
      // 清理超过 MAX_LOGS 的旧日志
      const list = await this.env.NVIDIA_KV.list({ prefix: "log:", limit: MAX_LOGS + 10 });
      if (list.keys.length > MAX_LOGS) {
        const toDel = list.keys.slice(0, list.keys.length - MAX_LOGS);
        for (const k of toDel) await this.env.NVIDIA_KV.delete(k.name);
      }
    } catch {}
  }

  async getLogs() {
    try {
      const list = await this.env.NVIDIA_KV.list({ prefix: "log:", limit: MAX_LOGS });
      const entries = [];
      for (const k of list.keys.reverse()) {
        const raw = await this.env.NVIDIA_KV.get(k.name);
        if (raw) {
          try { entries.push(JSON.parse(raw)); } catch { entries.push({ t: '', l: '?', m: raw }); }
        }
      }
      return entries;
    } catch { return []; }
  }

  // ─── Admin API ─────────────────────────────────────────────────

  checkAdminAuth(req) {
    const authToken = this.env.AUTH_TOKEN;
    if (!authToken) return true;
    const authHeader = req.headers.get("Authorization") || "";
    const queryToken = new URL(req.url).searchParams.get('token') || "";
    return authHeader.startsWith("Bearer ") && authHeader.slice(7) === authToken
      || queryToken === authToken;
  }

  async execAddKey(key) {
    const keys = await this.getKeys();
    if (keys.includes(key)) return jsonReply({ message: "Key 已存在" });
    keys.push(key);
    await this.saveKeys(keys);
    this.recalcLimits(keys.length);
    return jsonReply({ message: "添加成功", keyCount: keys.length });
  }

  async execDelKey(key) {
    const keys = await this.getKeys();
    const filtered = keys.filter(k => k !== key);
    if (filtered.length === keys.length) return jsonReply({ error: "Key 不存在" }, 404);
    await this.saveKeys(filtered);
    this.recalcLimits(filtered.length);
    this.keyBuckets.delete(key);
    this.blacklist.delete(key);
    this.keyRpmCounters.delete(key);
    return jsonReply({ message: "删除成功", keyCount: filtered.length });
  }

  async execListKeys() {
    const keys = await this.getKeys();
    const now  = Date.now();
    const stats = [];
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const b = this.getBucket(k);
      b.refill(now);
      stats.push({
        key: k,
        tokens:      Math.floor(b.tokens),
        blacklisted: this.isBlacklisted(k),
        currentRPM:  this.getKeyRPM(k)
      });
    }
    return jsonReply({ keys: stats, keyCount: stats.length });
  }

  async execClearKeys() {
    await this.saveKeys([]);
    this.recalcLimits(0);
    this.keyBuckets.clear();
    this.blacklist.clear();
    this.keyRpmCounters.clear();
    this.rpmCounter = new RpmCounter();
    this.totalRequests = 0;
    return jsonReply({ message: "已清空所有 Key" });
  }

  async execGetConfig() {
    const cfg = await this.loadConfig();
    return jsonReply({
      name: cfg.name || "NVIDIA",
      upstream: cfg.upstream || "https://integrate.api.nvidia.com",
      perKeyRpm: cfg.perKeyRpm || 38,
      modelMap: cfg.modelMap || {}
    });
  }

  async execSetConfig(body) {
    if (!body || !body.upstream) return jsonReply({ error: "需要提供 upstream 参数" }, 400);
    const cfg = {
      name: body.name || "Custom",
      upstream: body.upstream,
      perKeyRpm: parseInt(body.perKeyRpm) || 38,
      modelMap: body.modelMap || {}
    };
    await this.saveConfig(cfg);
    return jsonReply({ message: "配置已更新", config: cfg });
  }

  async execResetConfig() {
    const def = defaultProviderConfig();
    await this.saveConfig(def);
    return jsonReply({ message: "已恢复默认配置", config: def });
  }

  async handleAdminRoute(sub, url, req) {
    // AUTH 检查（/__ping 和 /__debug 除外便于心跳检测的匿名访问）
    const authExceptions = new Set(['/__ping', '/__debug']);
    if (!authExceptions.has(sub) && !this.checkAdminAuth(req)) {
      return jsonReply({ error: "UNAUTHORIZED", message: "无效的认证令牌" }, 401);
    }

    switch (sub) {
      case '/__debug': return this.handleDebug();
      case '/__ping':
        return this.checkPingLimit() ? new Response("ok") : jsonReply({ error: "PING_RATE_LIMITED" }, 429);
      case '/__addkey': {
        let key;
        if (req.method === 'POST') {
          try { const b = await req.json(); key = b.key; } catch {}
        }
        if (!key) key = url.searchParams.get('key');
        if (!key) return jsonReply({ error: "需要提供 key 参数（POST JSON 或 ?key=）" }, 400);
        return this.execAddKey(key);
      }
      case '/__delkey': {
        let key;
        if (req.method === 'POST') {
          try { const b = await req.json(); key = b.key; } catch {}
        }
        if (!key) key = url.searchParams.get('key');
        if (!key) return jsonReply({ error: "需要提供 key 参数（POST JSON 或 ?key=）" }, 400);
        return this.execDelKey(key);
      }
      case '/__listkeys': return this.execListKeys();
      case '/__clearkeys': return this.execClearKeys();
      case '/__getconfig': return this.execGetConfig();
      case '/__setconfig': {
        let body;
        try { body = await req.json(); } catch { return jsonReply({ error: "INVALID_JSON" }, 400); }
        return this.execSetConfig(body);
      }
      case '/__resetconfig': return this.execResetConfig();
      case '/__logs': {
        const logs = await this.getLogs();
        return jsonReply({ logs });
      }
    }
    return null;
  }

  async handleDebug() {
    const cfg = await this.loadConfig();
    const keys  = await this.getKeys();
    const keyCount = keys.length;
    const currentRPM = this.getCurrentRPM();
    const theoreticalRPM = keyCount * this.perKeyRPM;
    const utilization = theoreticalRPM > 0 ? (currentRPM / theoreticalRPM) * 100 : 0;
    const now = Date.now();
    const stats = [];
    let totalTokens = 0;
    let minNextMs = 2000;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const b = this.getBucket(k);
      b.refill(now);
      totalTokens += Math.floor(b.tokens);
      const nt = b.nextTokenMs(now);
      if (nt < minNextMs) minNextMs = nt;
      stats.push({ key: k, tokens: Math.floor(b.tokens), nextTokenMs: nt, blacklisted: this.isBlacklisted(k), currentRPM: this.getKeyRPM(k) });
    }
    return jsonReply({
      keyCount,
      queueSize:      this.queueSize,
      queueLimit:     this.queueLimit,
      globalTokens:   totalTokens,
      globalNextMs:   minNextMs === 2000 ? 0 : minNextMs,
      perKeyRPM:      this.perKeyRPM,
      theoreticalRPM,
      currentRPM,
      utilization:    Math.round(utilization * 10) / 10,
      totalRequests:  this.totalRequests,
      providerName:   cfg.name || "NVIDIA",
      keys:           stats
    });
  }

  // ─── 主请求入口 ─────────────────────────────────────────────────

  async fetch(req) {
    await this.loadConfig();

    const url  = new URL(req.url);
    const path = url.pathname;
    const p    = this.adminPath;
    const prefix = '/' + p;

    if (path === prefix) return serveAdmin(p, !!this.env.AUTH_TOKEN, this.cachedConfig);
    if (path === '/') return new Response(null, { status: 302, headers: { 'Location': "https://www.114514.com" } });

    if (path.startsWith(prefix + '/')) {
      const result = await this.handleAdminRoute(path.slice(prefix.length), url, req);
      if (result) return result;
    }

    // API 代理认证
    const authToken = this.env.AUTH_TOKEN;
    if (authToken) {
      const authHeader = req.headers.get("Authorization") || "";
      const anonKey = req.headers.get("x-api-key") || "";
      const valid = authHeader.startsWith("Bearer ") && authHeader.slice(7) === authToken;
      const validAnon = anonKey === authToken;
      if (!valid && !validAnon) {
        return new Response(JSON.stringify({
          error: "UNAUTHORIZED",
          message: "缺少或无效的 Authorization/x-api-key 头"
        }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS }
        });
      }
    }

    const format = this.detectFormat(path);
    if (!format) return jsonReply({ error: "NOT_FOUND", message: "未知的 API 路径" }, 404);

    const keys = await this.getKeys();
    if (!keys.length) return jsonReply({ error: "NO_KEYS_IN_KV", hint: '去 /' + p + ' 添加 Key' }, 500);

    if (!this.limitsInited) {
      this.recalcLimits(keys.length);
      this.limitsInited = true;
    }

    const contentLength = parseInt(req.headers.get('Content-Length') || '0');
    if (contentLength > MAX_BODY_SIZE) return jsonReply({ error: "PAYLOAD_TOO_LARGE", maxMB: MAX_BODY_SIZE / 1024 / 1024 }, 413);

    const translator = this.translators[format] || this.translators.openai;
    let rawBody     = null;
    let translatedBody = null;
    let isStream    = false;
    let parsedReq   = null;

    if (req.method !== "GET" && req.method !== "HEAD") {
      try {
        if (format === 'openai') {
          rawBody = await req.text();
          parsedReq = JSON.parse(rawBody);
          translatedBody = rawBody;
        } else {
          parsedReq = await req.json();
          translatedBody = JSON.stringify(translator.translateRequest(parsedReq));
        }
      } catch (e) {
        return jsonReply({ error: "INVALID_JSON", message: "请求体不是合法的 JSON" }, 400);
      }
      isStream = parsedReq.stream === true;
    }

    if (!this.hasAvailableKeys(keys)) return jsonReply({ error: "ALL_KEYS_BLOCKED" }, 503);

    if (this.queueSize >= this.queueLimit) return jsonReply({ error: "QUEUE_FULL" }, 503);

    this.queueSize++;
    const deadline = Date.now() + QUEUE_TIMEOUT_MS;
    let missCount = 0;

    try {
      while (true) {
        const now = Date.now();
        const key = this.pickKey(keys, now);

        if (key) {
          missCount = 0;
          try {
            const res = await this.forward(req, key, translatedBody, format);

            if (res.status === 429) {
              this.getBucket(key).drain();
              this.logError("WARN", "Key 被限流 (429): " + key.slice(0, 20) + "...");
              await safeCancel(res);
              continue;
            }

            if (res.status === 401 || res.status === 403) {
              await this.markBlocked(key, res.status);
              this.logError("WARN", "Key 认证失败 (" + res.status + "): " + key.slice(0, 20) + "...");
              await safeCancel(res);
              continue;
            }

            this.recordRequest(key);

            if (isStream && format !== 'openai') {
              const transformed = translator.transformStream(res.body, parsedReq);
              return new Response(transformed, {
                headers: { "Content-Type": "text/event-stream; charset=utf-8", ...CORS_HEADERS }
              });
            }

            if (format !== 'openai') {
              let data;
              try { data = await res.json(); } catch { return cors(res); }
              return jsonReply(translator.translateResponse(data, parsedReq), res.status);
            }

            return cors(res);
          } catch (err) {
            const isRetryable = err.name === 'AbortError'
              || (err.message && (err.message.includes('fetch') || err.message.includes('network') || err.message.includes('timeout')));
            if (isRetryable) {
              this.logError("WARN", "请求失败，即将重试: " + (err.message || '').slice(0, 100));
              continue;
            }
            this.logError("ERROR", "不可恢复错误: " + (err.message || '').slice(0, 200));
            return jsonReply({ error: "PROXY_ERROR", message: err.message }, 502);
          }
        }

        missCount++;
        if (missCount % 5 === 0) {
          const fresh = await this.getKeys();
          if (fresh.length > keys.length) {
            keys.length = 0;
            keys.push(...fresh);
          }
        }

        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          this.logError("WARN", "请求排队超时");
          return jsonReply({ error: "QUEUE_TIMEOUT" }, 504);
        }

        const wait = Math.min(this.earliestTokenMs(keys, now) + Math.floor(Math.random() * 200), remaining, 2000);
        await sleep(Math.max(wait, 50));
      }
    } finally {
      this.queueSize--;
    }
  }
}

// ─── Worker Entry ────────────────────────────────────────────────

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
    const id   = env.NV_C.idFromName("global");
    const stub = env.NV_C.get(id);
    return stub.fetch(req);
  },
  async scheduled(event, env) {
    const id   = env.NV_C.idFromName("global");
    const stub = env.NV_C.get(id);
    const adminPath = (env.ADMIN_PATH || 'admin').replace(/^\/+|\/+$/g, '');
    await stub.fetch(new Request('https://keepalive/' + adminPath + '/__ping'));
  }
};