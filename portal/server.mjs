#!/usr/bin/env node
/**
 * portal/server.mjs  —  Unified OASIS Plus Portal
 *
 * Serves a dashboard at http://localhost:3458  → Cloudflare Tunnel → portals.elfadil.com
 * Routes:
 *   GET  /                  HTML dashboard (all 6 branches)
 *   GET  /api/sites         Sites JSON
 *   GET  /api/status        Live site scan statuses
 *   GET  /api/health        Healthcheck
 *   ALL  /proxy/:siteId/*   Reverse-proxy to each Oracle portal
 */

import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
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
    return `
    <div class="card">
      <div class="card-header">
        <span class="dot ${site.enabled ? 'dot-green' : 'dot-gray'}"></span>
        <span class="site-name">${site.name}</span>
        <a class="btn-access" href="/proxy/${site.id}/" target="_blank">Open Portal ↗</a>
      </div>
      <div class="card-url">${site.url}</div>
      ${st.hasData ? `
      <div class="stats">
        <div class="stat"><div class="stat-val">${st.total}</div><div class="stat-label">Total</div></div>
        <div class="stat"><div class="stat-val go">${st.go}</div><div class="stat-label">GO</div></div>
        <div class="stat"><div class="stat-val">${pct}%</div><div class="stat-label">Ready</div></div>
      </div>
      <div class="prog-wrap"><div class="prog-bar" style="width:${pct}%;background:${bar}"></div></div>
      <div class="run-label">Last run: ${st.runDir || "—"}</div>
      ` : `<div class="no-data">No scan data yet</div>`}
    </div>`;
  }).join("\n");

  const totalGo    = statuses.reduce((a, s) => a + (s.go || 0), 0);
  const totalClaims = statuses.reduce((a, s) => a + (s.total || 0), 0);
  const sitesWithData = statuses.filter(s => s.hasData).length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>OASIS Plus — Unified Portal</title>
<style>
  :root { --bg:#0f172a; --card:#1e293b; --border:#334155; --text:#f1f5f9; --sub:#94a3b8; --accent:#3b82f6; --green:#22c55e; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; min-height:100vh; }
  header { padding:24px 32px; border-bottom:1px solid var(--border); display:flex; align-items:center; gap:16px; }
  .logo { font-size:22px; font-weight:700; letter-spacing:-0.5px; }
  .logo span { color:var(--accent); }
  .subtitle { color:var(--sub); font-size:14px; margin-left:auto; }
  .summary { display:flex; gap:24px; padding:24px 32px; border-bottom:1px solid var(--border); }
  .sum-card { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:16px 24px; flex:1; }
  .sum-val { font-size:32px; font-weight:700; }
  .sum-val.accent { color:var(--accent); }
  .sum-val.green  { color:var(--green); }
  .sum-label { font-size:12px; color:var(--sub); margin-top:4px; text-transform:uppercase; letter-spacing:.5px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:20px; padding:24px 32px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:20px; display:flex; flex-direction:column; gap:12px; transition:border-color .2s; }
  .card:hover { border-color:var(--accent); }
  .card-header { display:flex; align-items:center; gap:10px; }
  .dot { width:10px; height:10px; border-radius:50%; flex-shrink:0; }
  .dot-green { background:var(--green); box-shadow:0 0 8px var(--green); }
  .dot-gray  { background:#475569; }
  .site-name { font-size:17px; font-weight:600; flex:1; }
  .btn-access { background:var(--accent); color:#fff; border:none; border-radius:8px; padding:6px 14px; font-size:12px; font-weight:600; cursor:pointer; text-decoration:none; white-space:nowrap; }
  .btn-access:hover { background:#2563eb; }
  .card-url { font-size:11px; color:var(--sub); font-family:monospace; background:#0f172a; padding:6px 10px; border-radius:6px; word-break:break-all; }
  .stats { display:flex; gap:16px; }
  .stat { flex:1; text-align:center; }
  .stat-val { font-size:22px; font-weight:700; }
  .stat-val.go { color:var(--green); }
  .stat-label { font-size:11px; color:var(--sub); margin-top:2px; text-transform:uppercase; }
  .prog-wrap { height:6px; background:#0f172a; border-radius:3px; overflow:hidden; }
  .prog-bar { height:100%; border-radius:3px; transition:width 1s; }
  .run-label { font-size:11px; color:var(--sub); }
  .no-data { color:var(--sub); font-size:13px; text-align:center; padding:12px 0; }
  footer { text-align:center; padding:24px; color:var(--sub); font-size:12px; border-top:1px solid var(--border); margin-top:8px; }
  .refresh-btn { background:transparent; border:1px solid var(--border); color:var(--sub); padding:6px 14px; border-radius:8px; cursor:pointer; font-size:12px; }
  .refresh-btn:hover { border-color:var(--accent); color:var(--text); }
  @media (max-width:600px) { header,.grid,.summary { padding:16px; } .summary { flex-direction:column; } }
</style>
</head>
<body>
<header>
  <div class="logo">OASIS <span>Plus</span></div>
  <div>Unified Portal</div>
  <div class="subtitle">🏥 Hayath Hospital Group &nbsp;|&nbsp; portals.elfadil.com</div>
  <button class="refresh-btn" onclick="location.reload()">↻ Refresh</button>
</header>
<div class="summary">
  <div class="sum-card"><div class="sum-val accent">${sites.length}</div><div class="sum-label">Active Sites</div></div>
  <div class="sum-card"><div class="sum-val">${totalClaims}</div><div class="sum-label">Total Claims</div></div>
  <div class="sum-card"><div class="sum-val green">${totalGo}</div><div class="sum-label">GO for Submission</div></div>
  <div class="sum-card"><div class="sum-val accent">${sitesWithData}</div><div class="sum-label">Sites with Scan Data</div></div>
</div>
<div class="grid">${cards}</div>
<footer>Powered by oracle-scanner &nbsp;·&nbsp; Protected by Cloudflare Access &nbsp;·&nbsp; <span id="ts"></span></footer>
<script>document.getElementById("ts").textContent = new Date().toLocaleString();</script>
</body>
</html>`;
}

// ── HTTP Server ───────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  const url = req.url || "/";

  // Health
  if (url === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }));
    return;
  }

  // Sites API
  if (url === "/api/sites") {
    const sites = loadSites();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sites }));
    return;
  }

  // Status API
  if (url === "/api/status") {
    const sites    = loadSites();
    const statuses = sites.map(siteStatus);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ts: new Date().toISOString(), sites: statuses }));
    return;
  }

  // Dashboard
  if (url === "/" || url === "/dashboard") {
    const sites    = loadSites();
    const statuses = sites.map(siteStatus);
    const html     = buildDashboardHtml(sites, statuses);
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
