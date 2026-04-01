#!/usr/bin/env node
/**
 * portal/server.mjs  —  Unified OASIS Plus Portal
 *
 * Serves a dashboard at http://localhost:3458  → Cloudflare Tunnel → portals.elfadil.com
 * Routes:
 *   GET  /                  HTML dashboard (all 6 branches)
 *   GET  /api/sites         Sites JSON
 *   GET  /api/status        Live site scan statuses (+ portal reachability)
 *   GET  /api/health        Healthcheck
 *   POST /api/scan/:siteId  Queue a site scan (writes trigger file)
 *   ALL  /proxy/:siteId/*   Reverse-proxy to each Oracle portal
 */

import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { URL } from "node:url";

const PORT = Number(process.env.PORTAL_PORT) || 3458;
const ROOT = resolve(import.meta.dirname || ".", "..");

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadSites() {
  const p = join(ROOT, "sites.json");
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return []; }
}

function loadJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function latestRunDir(artifactsBase) {
  const latest = join(artifactsBase, "latest");
  if (existsSync(latest)) return latest;
  if (!existsSync(artifactsBase)) return null;
  const runs = readdirSync(artifactsBase)
    .filter(d => d.startsWith("run-"))
    .map(d => ({ d, mt: statSync(join(artifactsBase, d)).mtime }))
    .sort((a, b) => b.mt - a.mt);
  return runs.length ? join(artifactsBase, runs[0].d) : null;
}

function siteStatus(site) {
  const base    = resolve(ROOT, site.artifactsDir);
  const runDir  = latestRunDir(base);
  if (!runDir) return { site: site.id, name: site.name, url: site.url, hasData: false };
  const gate    = loadJson(join(runDir, "submission_gate.json")) || [];
  const total   = gate.length;
  const go      = gate.filter(g => g?.gateStatus === "GO").length;
  const runName = runDir.split(/[/\\]/).pop();
  return { site: site.id, name: site.name, url: site.url, hasData: true, runDir: runName, total, go, pctGo: total ? Math.round(go / total * 100) : 0 };
}

// Ping a hospital portal URL (HEAD request, 8 s timeout)
function pingPortal(site) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ online: false, status: 0, ms: 8000 }), 8000);
    try {
      const parsed  = new URL(site.url);
      const useHttps = parsed.protocol === "https:";
      const requester = useHttps ? httpsRequest : httpRequest;
      const start = Date.now();
      const req = requester({
        hostname: parsed.hostname,
        port: parsed.port || (useHttps ? 443 : 80),
        path: parsed.pathname || "/",
        method: "HEAD",
        rejectUnauthorized: false,
        timeout: 7000,
      }, res => {
        clearTimeout(timer);
        res.resume();
        resolve({ online: true, status: res.statusCode, ms: Date.now() - start });
      });
      req.on("error", () => { clearTimeout(timer); resolve({ online: false, status: 0, ms: Date.now() - start }); });
      req.on("timeout", () => { req.destroy(); clearTimeout(timer); resolve({ online: false, status: 0, ms: 7000 }); });
      req.end();
    } catch {
      clearTimeout(timer);
      resolve({ online: false, status: 0, ms: 0 });
    }
  });
}

// Write a scan trigger file for the daemon
function writeScanTrigger(siteId, opts = {}) {
  const triggerDir  = resolve(ROOT, "artifacts", "triggers");
  const triggerPath = join(triggerDir, `scan_${siteId}.json`);
  mkdirSync(triggerDir, { recursive: true });
  writeFileSync(triggerPath, JSON.stringify({
    siteId, fast: Boolean(opts.fast), resume: Boolean(opts.resume),
    requestedAt: new Date().toISOString(),
  }, null, 2), "utf8");
  return triggerPath;
}

// Check if a scan trigger is pending
function isTriggerPending(siteId) {
  const p = resolve(ROOT, "artifacts", "triggers", `scan_${siteId}.json`);
  return existsSync(p);
}

// ── Reverse proxy ─────────────────────────────────────────────────────────────

function proxyRequest(req, res, targetUrl) {
  const parsed  = new URL(targetUrl);
  const useHttps = parsed.protocol === "https:";
  const requester = useHttps ? httpsRequest : httpRequest;

  const options = {
    hostname : parsed.hostname,
    port     : parsed.port || (useHttps ? 443 : 80),
    path     : parsed.pathname + (parsed.search || ""),
    method   : req.method,
    headers  : { ...req.headers, host: parsed.host },
    rejectUnauthorized: false,
    timeout  : 30000,
  };
  delete options.headers["accept-encoding"]; // avoid compressed pipe issues

  const proxy = requester(options, (proxyRes) => {
    const hdrs = { ...proxyRes.headers };
    // Rewrite Location headers so redirects stay within our proxy
    if (hdrs.location) {
      try {
        const loc = new URL(hdrs.location, targetUrl);
        hdrs.location = `/proxy/${req._siteId}${loc.pathname}${loc.search || ""}`;
      } catch {}
    }
    res.writeHead(proxyRes.statusCode, hdrs);
    proxyRes.pipe(res, { end: true });
  });

  proxy.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: `Proxy error: ${err.message}` }));
    }
  });

  req.pipe(proxy, { end: true });
}

// ── Dashboard HTML ─────────────────────────────────────────────────────────────

function buildDashboardHtml(sites, statuses) {
  const cards = sites.map(site => {
    const st  = statuses.find(s => s.site === site.id) || {};
    const pct = st.pctGo ?? 0;
    const bar = pct > 70 ? "#22c55e" : pct > 40 ? "#f59e0b" : "#ef4444";
    const onlineDot = st.online === true ? 'dot-green' : st.online === false ? 'dot-red' : 'dot-gray';
    const onlineLabel = st.online === true ? `Online (${st.onlineMs ?? 0}ms)` : st.online === false ? 'Offline' : 'Unknown';
    const pending = st.scanPending ? `<span class="badge-pending">⏳ Scan queued</span>` : '';
    return `
    <div class="card" id="card-${site.id}">
      <div class="card-header">
        <span class="dot ${onlineDot}" title="${onlineLabel}"></span>
        <span class="site-name">${site.name}</span>
        <a class="btn-access" href="/proxy/${site.id}/" target="_blank">Open ↗</a>
        <button class="btn-scan" onclick="triggerScan('${site.id}',this)" title="Queue scan for ${site.name}">⚡ Scan</button>
      </div>
      <div class="card-url">${site.url}</div>
      <div class="ping-row"><span class="ping-label">${onlineLabel}</span>${pending}</div>
      ${st.hasData ? `
      <div class="stats">
        <div class="stat"><div class="stat-val">${st.total}</div><div class="stat-label">Total</div></div>
        <div class="stat"><div class="stat-val go">${st.go}</div><div class="stat-label">GO</div></div>
        <div class="stat"><div class="stat-val">${pct}%</div><div class="stat-label">Ready</div></div>
      </div>
      <div class="prog-wrap"><div class="prog-bar" style="width:${pct}%;background:${bar}"></div></div>
      <div class="run-label">Last run: ${st.runDir || "—"}</div>
      ` : `<div class="no-data">No scan data yet — click ⚡ Scan to start</div>`}
    </div>`;
  }).join("\n");

  const totalGo    = statuses.reduce((a, s) => a + (s.go || 0), 0);
  const totalClaims = statuses.reduce((a, s) => a + (s.total || 0), 0);
  const sitesWithData = statuses.filter(s => s.hasData).length;
  const onlineCount = statuses.filter(s => s.online).length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>OASIS Plus — Unified Portal</title>
<style>
  :root { --bg:#0f172a; --card:#1e293b; --border:#334155; --text:#f1f5f9; --sub:#94a3b8; --accent:#3b82f6; --green:#22c55e; --red:#ef4444; --amber:#f59e0b; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; min-height:100vh; }
  header { padding:20px 32px; border-bottom:1px solid var(--border); display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
  .logo { font-size:22px; font-weight:700; letter-spacing:-0.5px; }
  .logo span { color:var(--accent); }
  .header-right { margin-left:auto; display:flex; align-items:center; gap:12px; }
  .refresh-info { color:var(--sub); font-size:12px; }
  .summary { display:flex; gap:20px; padding:20px 32px; border-bottom:1px solid var(--border); flex-wrap:wrap; }
  .sum-card { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:14px 20px; flex:1; min-width:120px; }
  .sum-val { font-size:28px; font-weight:700; }
  .sum-val.accent { color:var(--accent); }
  .sum-val.green  { color:var(--green); }
  .sum-val.amber  { color:var(--amber); }
  .sum-label { font-size:11px; color:var(--sub); margin-top:4px; text-transform:uppercase; letter-spacing:.5px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:18px; padding:20px 32px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:18px; display:flex; flex-direction:column; gap:10px; transition:border-color .2s; }
  .card:hover { border-color:var(--accent); }
  .card-header { display:flex; align-items:center; gap:8px; }
  .dot { width:10px; height:10px; border-radius:50%; flex-shrink:0; cursor:help; }
  .dot-green { background:var(--green); box-shadow:0 0 6px var(--green); }
  .dot-red   { background:var(--red);   box-shadow:0 0 6px var(--red); }
  .dot-gray  { background:#475569; }
  .site-name { font-size:16px; font-weight:600; flex:1; }
  .btn-access { background:var(--accent); color:#fff; border:none; border-radius:7px; padding:5px 12px; font-size:11px; font-weight:600; cursor:pointer; text-decoration:none; }
  .btn-access:hover { background:#2563eb; }
  .btn-scan { background:transparent; color:var(--amber); border:1px solid var(--amber); border-radius:7px; padding:5px 10px; font-size:11px; font-weight:600; cursor:pointer; transition:all .2s; }
  .btn-scan:hover { background:var(--amber); color:#000; }
  .btn-scan:disabled { opacity:.4; cursor:default; }
  .card-url { font-size:10px; color:var(--sub); font-family:monospace; background:#0f172a; padding:5px 8px; border-radius:5px; word-break:break-all; }
  .ping-row { display:flex; align-items:center; gap:8px; min-height:18px; }
  .ping-label { font-size:11px; color:var(--sub); }
  .badge-pending { font-size:10px; color:var(--amber); background:rgba(245,158,11,.12); border:1px solid rgba(245,158,11,.3); border-radius:20px; padding:2px 8px; }
  .stats { display:flex; gap:12px; }
  .stat { flex:1; text-align:center; }
  .stat-val { font-size:20px; font-weight:700; }
  .stat-val.go { color:var(--green); }
  .stat-label { font-size:10px; color:var(--sub); margin-top:1px; text-transform:uppercase; }
  .prog-wrap { height:5px; background:#0f172a; border-radius:3px; overflow:hidden; }
  .prog-bar { height:100%; border-radius:3px; transition:width 1s; }
  .run-label { font-size:10px; color:var(--sub); }
  .no-data { color:var(--sub); font-size:12px; text-align:center; padding:10px 0; }
  .toast { position:fixed; bottom:24px; right:24px; background:#1e293b; border:1px solid var(--border); border-radius:10px; padding:12px 20px; font-size:13px; box-shadow:0 8px 32px rgba(0,0,0,.5); z-index:999; opacity:0; transform:translateY(10px); transition:all .3s; pointer-events:none; }
  .toast.show { opacity:1; transform:translateY(0); }
  footer { text-align:center; padding:20px; color:var(--sub); font-size:11px; border-top:1px solid var(--border); margin-top:6px; }
  @media(max-width:600px) { header,.grid,.summary { padding:12px; } .summary { flex-direction:column; } }
</style>
</head>
<body>
<header>
  <div class="logo">OASIS <span>Plus</span></div>
  <div style="color:var(--sub);font-size:13px;">Hayath Hospital Group</div>
  <div class="header-right">
    <span class="refresh-info">Auto-refresh: <strong id="countdown">60</strong>s</span>
    <button onclick="doRefresh()" style="background:transparent;border:1px solid var(--border);color:var(--sub);padding:5px 12px;border-radius:7px;cursor:pointer;font-size:12px;">↻ Now</button>
  </div>
</header>
<div class="summary">
  <div class="sum-card"><div class="sum-val accent">${sites.length}</div><div class="sum-label">Sites</div></div>
  <div class="sum-card"><div class="sum-val amber">${onlineCount}</div><div class="sum-label">Online</div></div>
  <div class="sum-card"><div class="sum-val">${totalClaims.toLocaleString()}</div><div class="sum-label">Total Claims</div></div>
  <div class="sum-card"><div class="sum-val green">${totalGo.toLocaleString()}</div><div class="sum-label">GO for Submission</div></div>
  <div class="sum-card"><div class="sum-val accent">${sitesWithData}</div><div class="sum-label">Scanned Sites</div></div>
</div>
<div class="grid">${cards}</div>
<footer>oracle-scanner &nbsp;·&nbsp; portals.elfadil.com &nbsp;·&nbsp; <span id="ts"></span></footer>
<div class="toast" id="toast"></div>
<script>
  document.getElementById("ts").textContent = new Date().toLocaleString("en-SA");

  let countdownVal = 60;
  const cdEl = document.getElementById("countdown");
  const timer = setInterval(() => {
    countdownVal--;
    cdEl.textContent = countdownVal;
    if (countdownVal <= 0) { clearInterval(timer); doRefresh(); }
  }, 1000);

  function doRefresh() { clearInterval(timer); location.reload(); }

  function showToast(msg, ok) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.style.borderColor = ok ? "var(--green)" : "var(--red)";
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 3500);
  }

  async function triggerScan(siteId, btn) {
    btn.disabled = true;
    btn.textContent = "⏳…";
    try {
      const r = await fetch("/api/scan/" + siteId, { method: "POST" });
      const j = await r.json();
      if (r.ok) {
        showToast("✅ Scan queued for " + siteId, true);
        btn.textContent = "⏳ Queued";
      } else {
        showToast("❌ " + (j.error || r.status), false);
        btn.disabled = false; btn.textContent = "⚡ Scan";
      }
    } catch(e) {
      showToast("❌ " + e.message, false);
      btn.disabled = false; btn.textContent = "⚡ Scan";
    }
  }
</script>
</body>
</html>`;
}

// ── HTTP Server ───────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = req.url || "/";

  // Health
  if (req.method === "GET" && url === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }));
    return;
  }

  // Sites API
  if (req.method === "GET" && url === "/api/sites") {
    const sites = loadSites();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sites }));
    return;
  }

  // Status API (includes portal pings)
  if (req.method === "GET" && url === "/api/status") {
    const sites    = loadSites();
    const [scanResults, pingResults] = await Promise.all([
      Promise.resolve(sites.map(siteStatus)),
      Promise.all(sites.map(pingPortal)),
    ]);
    const statuses = scanResults.map((s, i) => ({
      ...s,
      online: pingResults[i].online,
      onlineStatus: pingResults[i].status,
      onlineMs: pingResults[i].ms,
      scanPending: isTriggerPending(s.site),
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ts: new Date().toISOString(), sites: statuses }));
    return;
  }

  // Scan trigger API
  const scanMatch = url.match(/^\/api\/scan\/([^/]+)$/);
  if (req.method === "POST" && scanMatch) {
    const siteId = scanMatch[1];
    const sites  = loadSites();
    const site   = sites.find(s => s.id === siteId);
    if (!site) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Unknown site: ${siteId}` }));
      return;
    }
    try {
      const triggerPath = writeScanTrigger(siteId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, siteId, triggerPath, requestedAt: new Date().toISOString() }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Dashboard
  if (req.method === "GET" && (url === "/" || url === "/dashboard")) {
    const sites    = loadSites();
    const [scanResults, pingResults] = await Promise.all([
      Promise.resolve(sites.map(siteStatus)),
      Promise.all(sites.map(pingPortal)),
    ]);
    const statuses = scanResults.map((s, i) => ({
      ...s,
      online: pingResults[i].online,
      onlineMs: pingResults[i].ms,
      scanPending: isTriggerPending(s.site),
    }));
    const html = buildDashboardHtml(sites, statuses);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  // Reverse proxy:  /proxy/:siteId/<path>
  const proxyMatch = url.match(/^\/proxy\/([^/]+)(\/.*)?$/);
  if (proxyMatch) {
    const siteId  = proxyMatch[1];
    const subPath = proxyMatch[2] || "/";
    const sites   = loadSites();
    const site    = sites.find(s => s.id === siteId);
    if (!site) {
      res.writeHead(404);
      res.end(`Unknown site: ${siteId}. Valid: ${sites.map(s => s.id).join(", ")}`);
      return;
    }
    const targetBase = site.url.replace(/\/[^/]*\.(jsf|html|xhtml)$/, ""); // strip login page
    const targetUrl  = targetBase.endsWith("/") ? `${targetBase}${subPath.slice(1)}` : `${targetBase}${subPath}`;
    req._siteId      = siteId;
    proxyRequest(req, res, targetUrl);
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[portal] Listening  http://127.0.0.1:${PORT}`);
  console.log(`[portal] Public URL https://portals.elfadil.com`);
  console.log(`[portal] Sites      ${loadSites().length} configured in sites.json`);
});

server.on("error", err => { console.error("[portal] Server error:", err.message); process.exit(1); });
