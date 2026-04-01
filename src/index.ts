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
// Static site list (mirrors sites.json — kept here so the Worker has it
// without needing KV/R2, and is always up-to-date with deployments).
// ---------------------------------------------------------------------------
const SITES = [
	{ id: "riyadh",  name: "Riyadh",   url: "https://128.1.1.185/prod/faces/Home" },
	{ id: "madinah", name: "Madinah",   url: "http://172.25.11.26/Oasis/faces/Login.jsf" },
	{ id: "unaizah", name: "Unaizah",   url: "http://10.0.100.105/prod/faces/Login.jsf" },
	{ id: "khamis",  name: "Khamis",    url: "http://172.30.0.77/prod/faces/Login.jsf" },
	{ id: "jizan",   name: "Jizan",     url: "http://172.17.4.84/prod/faces/Login.jsf" },
	{ id: "abha",    name: "Abha",      url: "http://172.19.1.1/Oasis/faces/Home" },
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
	server = new McpServer({ name: "oracle-nphies", version: "0.2.0" });

	async init() {
		// ── Sites ────────────────────────────────────────────────────────────
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

		// ── Claims ───────────────────────────────────────────────────────────
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
// Portal dashboard HTML
// ---------------------------------------------------------------------------
function portalHtml(): string {
	const cards = SITES.map(
		(s) => `
    <div class="card">
      <div class="card-header">
        <span class="dot"></span>
        <span class="site-name">${s.name}</span>
        <a class="btn" href="/proxy/${s.id}/" target="_blank">Open ↗</a>
      </div>
      <div class="card-url">${s.url}</div>
      <div class="card-status" id="st-${s.id}">Loading…</div>
    </div>`,
	).join("");

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>OASIS Plus — Unified Portal</title>
<style>
  :root{--bg:#0f172a;--card:#1e293b;--border:#334155;--text:#f1f5f9;--sub:#94a3b8;--accent:#3b82f6;--green:#22c55e}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh}
  header{padding:20px 28px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px}
  .logo{font-size:20px;font-weight:700}.logo span{color:var(--accent)}
  .tagline{color:var(--sub);font-size:13px;margin-left:auto}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:18px;padding:24px 28px}
  .card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px;display:flex;flex-direction:column;gap:10px}
  .card:hover{border-color:var(--accent)}
  .card-header{display:flex;align-items:center;gap:8px}
  .dot{width:9px;height:9px;border-radius:50%;background:var(--green);box-shadow:0 0 6px var(--green);flex-shrink:0}
  .site-name{font-size:16px;font-weight:600;flex:1}
  .btn{background:var(--accent);color:#fff;border:none;border-radius:7px;padding:5px 12px;font-size:12px;font-weight:600;text-decoration:none;cursor:pointer}
  .btn:hover{background:#2563eb}
  .card-url{font-size:11px;color:var(--sub);font-family:monospace;background:#0f172a;padding:5px 8px;border-radius:5px;word-break:break-all}
  .card-status{font-size:12px;color:var(--sub)}
  .card-status.ok{color:var(--green)}
  footer{text-align:center;padding:20px;color:var(--sub);font-size:12px;border-top:1px solid var(--border);margin-top:8px}
  @media(max-width:600px){header,.grid{padding:14px}}
</style>
</head>
<body>
<header>
  <div class="logo">OASIS <span>Plus</span></div>
  <div>Unified Portal</div>
  <div class="tagline">🏥 Hayath Hospital Group &nbsp;·&nbsp; portals.elfadil.com &nbsp;·&nbsp; Protected by Cloudflare Access</div>
</header>
<div class="grid">${cards}</div>
<footer>oracle-scanner v1.2 &nbsp;·&nbsp; <span id="ts"></span></footer>
<script>
document.getElementById("ts").textContent = new Date().toLocaleString();
fetch("/api/status").then(r=>r.json()).then(d=>{
  (d.sites||[]).forEach(s=>{
    const el = document.getElementById("st-"+s.site);
    if(!el) return;
    if(!s.hasData){ el.textContent="No scan data"; return; }
    el.textContent = s.go+" GO / "+s.total+" claims ("+s.pctGo+"%) — "+s.runDir;
    el.className="card-status ok";
  });
}).catch(()=>{});
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

		// Reverse proxy to Oracle portal  /proxy/:siteId/*
		const proxyMatch = pathname.match(/^\/proxy\/([^/]+)(\/.*)$/);
		if (proxyMatch) {
			const siteId = proxyMatch[1] as SiteId;
			const subPath = proxyMatch[2] || "/";
			const site = SITES.find((s) => s.id === siteId);
			if (!site) return new Response(`Unknown site: ${siteId}`, { status: 404 });

			// Route via local bridge so Worker doesn't expose internal LAN IPs
			// The bridge URL is the cloudflared-exposed portal server
			const base = env.ORACLE_BRIDGE_URL?.replace(/\/mcp$/, "") ?? "";
			if (!base) return new Response("ORACLE_BRIDGE_URL not set", { status: 503 });
			const target = `${base}/proxy/${siteId}${subPath}${url.search}`;
			const proxyReq = new Request(target, {
				method: request.method,
				headers: request.headers,
				body: request.body,
				redirect: "follow",
			});
			return fetch(proxyReq);
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
