import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Environment bindings (declared in wrangler.jsonc)
// ---------------------------------------------------------------------------
export interface Env {
	MCP_OBJECT: DurableObjectNamespace;
	/** URL of the local oracle-nphies MCP HTTP bridge, exposed via cloudflared.
	 *  e.g. https://mcp.elfadil.com  (set in wrangler.jsonc > vars) */
	ORACLE_BRIDGE_URL?: string;
	/** Shared secret to authenticate requests to the bridge */
	ORACLE_BRIDGE_SECRET?: string;
}

// ---------------------------------------------------------------------------
// Static site list (mirrors sites.json)
// ---------------------------------------------------------------------------
const SITES = [
	{ id: "riyadh",  name: "Riyadh",  url: "https://128.1.1.185/prod/faces/Home" },
	{ id: "madinah", name: "Madinah", url: "http://172.25.11.26/Oasis/faces/Login.jsf" },
	{ id: "unaizah", name: "Unaizah", url: "http://10.0.100.105/prod/faces/Login.jsf" },
	{ id: "khamis",  name: "Khamis",  url: "http://172.30.0.77/prod/faces/Login.jsf" },
	{ id: "jizan",   name: "Jizan",   url: "http://172.17.4.84/prod/faces/Login.jsf" },
	{ id: "abha",    name: "Abha",    url: "http://172.19.1.1/Oasis/faces/Home" },
] as const;

type SiteId = (typeof SITES)[number]["id"];

// ---------------------------------------------------------------------------
// Helper — call the local oracle MCP bridge
// ---------------------------------------------------------------------------
async function callBridge(
	env: Env,
	method: string,
	params: Record<string, unknown>,
): Promise<unknown> {
	const base = env.ORACLE_BRIDGE_URL?.replace(/\/$/, "");
	if (!base) throw new Error("ORACLE_BRIDGE_URL not configured.");

	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (env.ORACLE_BRIDGE_SECRET) headers["x-bridge-secret"] = env.ORACLE_BRIDGE_SECRET;

	const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
	const resp = await fetch(`${base}/mcp`, { method: "POST", headers, body });
	if (!resp.ok) throw new Error(`Bridge HTTP ${resp.status}`);
	const json = (await resp.json()) as { result?: unknown; error?: { message: string } };
	if (json.error) throw new Error(json.error.message);
	return json.result;
}

function text(t: string) {
	return { content: [{ type: "text" as const, text: t }] };
}

// ---------------------------------------------------------------------------
// MCP Agent
// ---------------------------------------------------------------------------
export class MyMCP extends McpAgent<Env> {
	server = new McpServer({ name: "oracle-nphies", version: "0.3.0" });

	async init() {
		// ── Sites ──────────────────────────────────────────────────────────
		this.server.tool(
			"oracle.sites.list",
			"List all 6 OASIS Plus branch portals.",
			{},
			async () => text(JSON.stringify({ sites: SITES }, null, 2)),
		);

		this.server.tool(
			"oracle.sites.status",
			"Return last-run scan summary for a site (or all sites).",
			{ siteId: z.string().optional() },
			async ({ siteId }, { env }) => {
				try {
					const result = await callBridge(env, "tools/call", {
						name: "oracle.sites.status",
						arguments: siteId ? { siteId } : {},
					});
					return result as ReturnType<typeof text>;
				} catch (e) {
					return text(`Bridge unavailable: ${(e as Error).message}`);
				}
			},
		);

		// ── Runs ────────────────────────────────────────────────────────────
		this.server.tool(
			"oracle.runs.latest",
			"Return the latest artifacts run directory for a site.",
			{
				siteId: z.enum(["riyadh", "madinah", "unaizah", "khamis", "jizan", "abha"]).optional(),
				runDir: z.string().optional(),
			},
			async ({ siteId, runDir }, { env }) => {
				try {
					const result = await callBridge(env, "tools/call", {
						name: "oracle.runs.latest",
						arguments: { siteId, runDir },
					});
					return result as ReturnType<typeof text>;
				} catch (e) {
					return text(`Bridge error: ${(e as Error).message}`);
				}
			},
		);

		// ── Claims ──────────────────────────────────────────────────────────
		this.server.tool(
			"oracle.claims.list_go",
			"List Gate=GO claims for a site.",
			{
				siteId: z.enum(["riyadh", "madinah", "unaizah", "khamis", "jizan", "abha"]),
				limit: z.number().int().positive().max(500).optional(),
			},
			async ({ siteId, limit }, { env }) => {
				try {
					const result = await callBridge(env, "tools/call", {
						name: "oracle.claims.list_go",
						arguments: { siteId, limit },
					});
					return result as ReturnType<typeof text>;
				} catch (e) {
					return text(`Bridge error: ${(e as Error).message}`);
				}
			},
		);

		this.server.tool(
			"oracle.claims.select_go",
			"Select N fully-ready GO claims (unique MRN preferred).",
			{
				siteId: z.enum(["riyadh", "madinah", "unaizah", "khamis", "jizan", "abha"]),
				count: z.number().int().positive().max(50).optional(),
				uniqueMrn: z.boolean().optional(),
			},
			async ({ siteId, count, uniqueMrn }, { env }) => {
				try {
					const result = await callBridge(env, "tools/call", {
						name: "oracle.claims.select_go",
						arguments: { siteId, count, uniqueMrn },
					});
					return result as ReturnType<typeof text>;
				} catch (e) {
					return text(`Bridge error: ${(e as Error).message}`);
				}
			},
		);

		this.server.tool(
			"oracle.claims.bundle_manifest",
			"Get attachment bundle manifest for a specific invoice + MRN.",
			{
				siteId: z.enum(["riyadh", "madinah", "unaizah", "khamis", "jizan", "abha"]),
				invoiceNumber: z.string(),
				mrn: z.string(),
			},
			async ({ siteId, invoiceNumber, mrn }, { env }) => {
				try {
					const result = await callBridge(env, "tools/call", {
						name: "oracle.claims.bundle_manifest",
						arguments: { siteId, invoiceNumber, mrn },
					});
					return result as ReturnType<typeof text>;
				} catch (e) {
					return text(`Bridge error: ${(e as Error).message}`);
				}
			},
		);

		// ── Scan control ────────────────────────────────────────────────────
		this.server.tool(
			"oracle.scan.trigger",
			"Queue a scan for a branch site. Daemon picks it up on its next cycle.",
			{
				siteId: z.enum(["riyadh", "madinah", "unaizah", "khamis", "jizan", "abha"]),
				fast: z.boolean().optional(),
				resume: z.boolean().optional(),
			},
			async ({ siteId, fast, resume }, { env }) => {
				try {
					const result = await callBridge(env, "tools/call", {
						name: "oracle.scan.trigger",
						arguments: { siteId, fast, resume },
					});
					return result as ReturnType<typeof text>;
				} catch (e) {
					return text(`Bridge error: ${(e as Error).message}`);
				}
			},
		);
	}
}

// ---------------------------------------------------------------------------
// Portal dashboard HTML (full-featured, mirrors local portal/server.mjs)
// ---------------------------------------------------------------------------
function portalHtml(): string {
	const siteCards = SITES.map(
		(s) => `
    <div class="card" id="card-${s.id}">
      <div class="card-header">
        <span class="dot dot-gray" id="dot-${s.id}" title="Checking…"></span>
        <span class="site-name">${s.name}</span>
        <a class="btn-access" href="/proxy/${s.id}/" target="_blank">Open ↗</a>
        <button class="btn-scan" onclick="triggerScan('${s.id}',this)" title="Queue scan">⚡ Scan</button>
      </div>
      <div class="card-url">${s.url}</div>
      <div class="ping-row"><span class="ping-label" id="ping-${s.id}">Checking portal…</span></div>
      <div class="card-data" id="data-${s.id}">
        <div class="no-data">Loading scan data…</div>
      </div>
    </div>`,
	).join("");

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>OASIS Plus — Unified Portal</title>
<style>
  :root{--bg:#0f172a;--card:#1e293b;--border:#334155;--text:#f1f5f9;--sub:#94a3b8;--accent:#3b82f6;--green:#22c55e;--red:#ef4444;--amber:#f59e0b}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh}
  header{padding:18px 28px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .logo{font-size:20px;font-weight:700}.logo span{color:var(--accent)}
  .header-right{margin-left:auto;display:flex;align-items:center;gap:12px}
  .refresh-info{color:var(--sub);font-size:12px}
  #summary{display:flex;gap:16px;padding:16px 28px;border-bottom:1px solid var(--border);flex-wrap:wrap}
  .sum-card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px 18px;flex:1;min-width:100px}
  .sum-val{font-size:26px;font-weight:700}
  .sum-val.accent{color:var(--accent)}.sum-val.green{color:var(--green)}.sum-val.amber{color:var(--amber)}
  .sum-label{font-size:10px;color:var(--sub);margin-top:3px;text-transform:uppercase;letter-spacing:.5px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:16px;padding:18px 28px}
  .card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:9px;transition:border-color .2s}
  .card:hover{border-color:var(--accent)}
  .card-header{display:flex;align-items:center;gap:8px}
  .dot{width:9px;height:9px;border-radius:50%;flex-shrink:0;cursor:help;transition:all .4s}
  .dot-green{background:var(--green);box-shadow:0 0 6px var(--green)}
  .dot-red{background:var(--red);box-shadow:0 0 6px var(--red)}
  .dot-gray{background:#475569}
  .site-name{font-size:15px;font-weight:600;flex:1}
  .btn-access{background:var(--accent);color:#fff;border:none;border-radius:6px;padding:4px 11px;font-size:11px;font-weight:600;text-decoration:none;cursor:pointer}
  .btn-access:hover{background:#2563eb}
  .btn-scan{background:transparent;color:var(--amber);border:1px solid var(--amber);border-radius:6px;padding:4px 9px;font-size:11px;font-weight:600;cursor:pointer;transition:all .2s}
  .btn-scan:hover{background:var(--amber);color:#000}
  .btn-scan:disabled{opacity:.4;cursor:default}
  .card-url{font-size:10px;color:var(--sub);font-family:monospace;background:#0f172a;padding:4px 7px;border-radius:4px;word-break:break-all}
  .ping-row{display:flex;align-items:center;gap:8px;min-height:16px}
  .ping-label{font-size:11px;color:var(--sub)}
  .badge-pending{font-size:10px;color:var(--amber);background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3);border-radius:20px;padding:1px 7px}
  .stats{display:flex;gap:10px}
  .stat{flex:1;text-align:center}
  .stat-val{font-size:18px;font-weight:700}
  .stat-val.go{color:var(--green)}
  .stat-label{font-size:10px;color:var(--sub);margin-top:1px;text-transform:uppercase}
  .prog-wrap{height:4px;background:#0f172a;border-radius:2px;overflow:hidden}
  .prog-bar{height:100%;border-radius:2px;transition:width 1s}
  .run-label{font-size:10px;color:var(--sub)}
  .no-data{color:var(--sub);font-size:12px;text-align:center;padding:8px 0}
  .toast{position:fixed;bottom:20px;right:20px;background:#1e293b;border:1px solid var(--border);border-radius:8px;padding:10px 18px;font-size:13px;box-shadow:0 8px 32px rgba(0,0,0,.5);z-index:999;opacity:0;transform:translateY(8px);transition:all .3s;pointer-events:none}
  .toast.show{opacity:1;transform:translateY(0)}
  footer{text-align:center;padding:18px;color:var(--sub);font-size:11px;border-top:1px solid var(--border);margin-top:6px}
  @media(max-width:600px){header,.grid,#summary{padding:12px}.sum-card{min-width:80px}}
</style>
</head>
<body>
<header>
  <div class="logo">OASIS <span>Plus</span></div>
  <div style="color:var(--sub);font-size:13px">Hayath Hospital Group</div>
  <div class="header-right">
    <span class="refresh-info">Auto-refresh: <strong id="countdown">60</strong>s</span>
    <button onclick="doRefresh()" style="background:transparent;border:1px solid var(--border);color:var(--sub);padding:4px 11px;border-radius:6px;cursor:pointer;font-size:12px">↻ Now</button>
  </div>
</header>
<div id="summary">
  <div class="sum-card"><div class="sum-val accent" id="s-sites">${SITES.length}</div><div class="sum-label">Sites</div></div>
  <div class="sum-card"><div class="sum-val amber" id="s-online">—</div><div class="sum-label">Online</div></div>
  <div class="sum-card"><div class="sum-val" id="s-total">—</div><div class="sum-label">Total Claims</div></div>
  <div class="sum-card"><div class="sum-val green" id="s-go">—</div><div class="sum-label">GO Claims</div></div>
  <div class="sum-card"><div class="sum-val accent" id="s-scanned">—</div><div class="sum-label">Scanned</div></div>
</div>
<div class="grid">${siteCards}</div>
<footer>oracle-scanner v1.3 &nbsp;·&nbsp; portals.elfadil.com &nbsp;·&nbsp; Protected by Cloudflare &nbsp;·&nbsp; <span id="ts"></span></footer>
<div class="toast" id="toast"></div>
<script>
document.getElementById("ts").textContent = new Date().toLocaleString("en-SA");

// Auto-refresh countdown
let cv=60;
const cdEl=document.getElementById("countdown");
const tmr=setInterval(()=>{ cv--; cdEl.textContent=cv; if(cv<=0){clearInterval(tmr);doRefresh();} },1000);
function doRefresh(){clearInterval(tmr);location.reload();}

function showToast(msg,ok){
  const t=document.getElementById("toast");
  t.textContent=msg; t.style.borderColor=ok?"var(--green)":"var(--red)";
  t.classList.add("show"); setTimeout(()=>t.classList.remove("show"),3500);
}

async function triggerScan(siteId,btn){
  btn.disabled=true; btn.textContent="⏳…";
  try{
    const r=await fetch("/api/scan/"+siteId,{method:"POST"});
    const j=await r.json();
    if(r.ok){ showToast("✅ Scan queued for "+siteId,true); btn.textContent="⏳ Queued"; }
    else{ showToast("❌ "+(j.error||r.status),false); btn.disabled=false; btn.textContent="⚡ Scan"; }
  }catch(e){ showToast("❌ "+e.message,false); btn.disabled=false; btn.textContent="⚡ Scan"; }
}

// Load live status from bridge
fetch("/api/status").then(r=>r.json()).then(d=>{
  const sites=d.sites||d.content?.[0]?.text&&JSON.parse(d.content[0].text)?.sites||[];
  let online=0,total=0,go=0,scanned=0;
  sites.forEach(s=>{
    const dot=document.getElementById("dot-"+s.site);
    const ping=document.getElementById("ping-"+s.site);
    const data=document.getElementById("data-"+s.site);
    if(dot){ dot.className="dot dot-green"; dot.title="Data available"; }
    if(ping) ping.textContent=s.status==="ok"?"Data OK":"No data";
    if(s.hasData||s.status==="ok"){
      scanned++;
      const t=s.total||s.gateTotal||0;
      const g=s.go||s.goCount||0;
      const pct=s.pctGo||s.gatePctGo||0;
      total+=t; go+=g;
      const bar=pct>70?"#22c55e":pct>40?"#f59e0b":"#ef4444";
      if(data) data.innerHTML=\`
        <div class="stats">
          <div class="stat"><div class="stat-val">\${t.toLocaleString()}</div><div class="stat-label">Total</div></div>
          <div class="stat"><div class="stat-val go">\${g.toLocaleString()}</div><div class="stat-label">GO</div></div>
          <div class="stat"><div class="stat-val">\${pct}%</div><div class="stat-label">Ready</div></div>
        </div>
        <div class="prog-wrap"><div class="prog-bar" style="width:\${pct}%;background:\${bar}"></div></div>
        <div class="run-label">Last run: \${s.runDir||"—"}</div>\`;
    } else {
      if(data) data.innerHTML='<div class="no-data">No scan data — click ⚡ Scan to start</div>';
    }
  });
  online=scanned; // approximate: sites with data are "up"
  document.getElementById("s-online").textContent=online;
  document.getElementById("s-total").textContent=total.toLocaleString();
  document.getElementById("s-go").textContent=go.toLocaleString();
  document.getElementById("s-scanned").textContent=scanned;
}).catch(err=>{
  document.querySelectorAll(".ping-label").forEach(el=>{ el.textContent="Bridge unavailable"; });
});
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Fetch handler
// ---------------------------------------------------------------------------
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const { pathname } = url;

		// MCP endpoint
		if (pathname === "/mcp") {
			return MyMCP.serve("/mcp").fetch(request, env, ctx);
		}

		// Health
		if (pathname === "/api/health") {
			return Response.json({ ok: true, ts: new Date().toISOString(), sites: SITES.length });
		}

		// Sites list
		if (pathname === "/api/sites") {
			return Response.json({ sites: SITES });
		}

		// Live status — proxy to local bridge
		if (pathname === "/api/status") {
			try {
				const result = await callBridge(env, "tools/call", {
					name: "oracle.sites.status",
					arguments: {},
				});
				return Response.json(result);
			} catch {
				return Response.json({ sites: SITES.map((s) => ({ site: s.id, name: s.name, hasData: false })) });
			}
		}

		// Scan trigger — queue a scan via bridge
		const scanMatch = pathname.match(/^\/api\/scan\/([^/]+)$/);
		if (scanMatch && request.method === "POST") {
			const siteId = scanMatch[1];
			const site = SITES.find((s) => s.id === siteId);
			if (!site) return Response.json({ error: `Unknown site: ${siteId}` }, { status: 404 });
			try {
				const result = await callBridge(env, "tools/call", {
					name: "oracle.scan.trigger",
					arguments: { siteId },
				});
				return Response.json({ ok: true, siteId, result });
			} catch (e) {
				return Response.json({ error: (e as Error).message }, { status: 502 });
			}
		}

		// /proxy/:siteId/ — redirect to direct LAN URL
		const proxyMatch = pathname.match(/^\/proxy\/([^/]+)(\/.*)?$/);
		if (proxyMatch) {
			const siteId = proxyMatch[1] as SiteId;
			const site = SITES.find((s) => s.id === siteId);
			if (!site) return new Response(`Unknown site: ${siteId}`, { status: 404 });
			return Response.redirect(site.url, 302);
		}

		// Dashboard (root)
		if (pathname === "/" || pathname === "/dashboard") {
			return new Response(portalHtml(), {
				headers: { "Content-Type": "text/html;charset=UTF-8" },
			});
		}

		return new Response("Not found", { status: 404 });
	},
};

