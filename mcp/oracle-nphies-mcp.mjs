/**
 * oracle-nphies-mcp.mjs  —  Multi-site MCP server for OASIS Plus
 *
 * Tools exposed:
 *   oracle.sites.list              — list all configured sites
 *   oracle.sites.status            — reachability + last-run summary per site
 *   oracle.runs.latest             — resolve latest run dir (optionally for a site)
 *   oracle.claims.list_go          — Gate=GO claims for a run
 *   oracle.claims.select_go        — Select N ready claims (unique MRN)
 *   oracle.claims.bundle_manifest  — Attachment manifest for a specific claim
 *   oracle.scan.trigger            — Write a trigger file to queue a site for scanning
 *   oracle.portal.health           — HTTP ping each hospital portal (online/offline + ms)
 */

import { readFileSync, existsSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const ROOT = resolve(process.cwd());

// ---- Helpers --------------------------------------------------------

function clean(value) {
  return String(value ?? "").trim();
}

function jsonParseSafe(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function readJson(path) {
  return jsonParseSafe(readFileSync(path, "utf8"), null);
}

function loadSites() {
  const path = join(ROOT, "sites.json");
  if (!existsSync(path)) return [];
  const sites = jsonParseSafe(readFileSync(path, "utf8"), []);
  return Array.isArray(sites) ? sites : [];
}

function resolveArtifactsBase(siteId) {
  if (siteId) {
    const sites = loadSites();
    const site = sites.find(s => s.id === siteId);
    if (site) return resolve(ROOT, site.artifactsDir);
  }
  return resolve(ROOT, process.env.ORACLE_ARTIFACTS_DIR || "artifacts/oracle-portal");
}

function findLatestRunDir(artifactsBase) {
  const latest = join(artifactsBase, "latest");
  if (existsSync(latest)) return latest;

  // Fallback: pick most-recently-modified run-* dir
  if (!existsSync(artifactsBase)) return null;
  const dirs = readdirSync(artifactsBase)
    .filter(d => d.startsWith("run-"))
    .map(d => ({ name: d, mtime: statSync(join(artifactsBase, d)).mtime }))
    .sort((a, b) => b.mtime - a.mtime);
  return dirs.length > 0 ? join(artifactsBase, dirs[0].name) : null;
}

function resolveRunDir(inputRunDir, siteId) {
  if (clean(inputRunDir)) return resolve(ROOT, inputRunDir);
  const base = resolveArtifactsBase(siteId);
  const dir = findLatestRunDir(base);
  if (dir) return dir;
  throw new Error(`No runDir provided and no latest run found under ${base}`);
}

function loadGate(runDir) {
  const p = join(runDir, "submission_gate.json");
  if (!existsSync(p)) throw new Error(`Missing: ${p}`);
  const data = readJson(p);
  if (!Array.isArray(data)) throw new Error(`Expected array: ${p}`);
  return data;
}

function loadManifest(runDir) {
  const p = join(runDir, "nphies_submission_bundle_manifest.json");
  if (!existsSync(p)) throw new Error(`Missing: ${p}`);
  const data = readJson(p);
  if (!Array.isArray(data)) throw new Error(`Expected array: ${p}`);
  return data;
}

function selectGoClaims({ runDir, count, uniqueMrn }) {
  const gate     = loadGate(runDir);
  const manifest = loadManifest(runDir);
  const go       = gate.filter(g => g?.gateStatus === "GO" && g?.oracleFound && g?.nphiesReady);
  const mMap     = new Map(manifest.map(m => [`${m.invoiceNumber}|${m.mrn}`, m]));
  const selected = [];
  const usedMrn  = new Set();
  const limit    = Math.max(1, Number(count) || 3);
  const uniq     = Boolean(uniqueMrn);

  function tryAdd(g, enforce) {
    const key = `${g.invoiceNumber}|${g.mrn}`;
    const m   = mMap.get(key);
    if (!m) return false;
    if (Number(m.resolvedAttachmentCount || 0) < Number(m.requiredAttachmentCount || 0)) return false;
    const mrn = clean(g.mrn);
    if (enforce && mrn && usedMrn.has(mrn)) return false;
    if (enforce && mrn) usedMrn.add(mrn);
    selected.push({ invoiceNumber: clean(g.invoiceNumber), mrn, gateStatus: "GO", manifest: m });
    return true;
  }

  for (const g of go) { tryAdd(g, uniq); if (selected.length >= limit) break; }
  if (selected.length < limit && uniq) {
    for (const g of go) {
      if (selected.some(s => s.invoiceNumber === clean(g.invoiceNumber) && s.mrn === clean(g.mrn))) continue;
      tryAdd(g, false);
      if (selected.length >= limit) break;
    }
  }
  return selected;
}

function toolText(text) {
  return { content: [{ type: "text", text: String(text) }] };
}

// ---- Tool definitions -----------------------------------------------

const tools = [
  // ── Sites ────────────────────────────────────────────────────────
  {
    name: "oracle.sites.list",
    description: "Lists all OASIS Plus branch sites configured in sites.json.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async call() {
      const sites = loadSites();
      return toolText(JSON.stringify({ count: sites.length, sites }, null, 2));
    },
  },
  {
    name: "oracle.sites.status",
    description: "Returns last-run summary and artifact availability for each site.",
    inputSchema: {
      type: "object",
      properties: {
        siteId: { type: "string", description: "Optional: single site id to check." },
      },
      additionalProperties: false,
    },
    async call(args) {
      const sites = loadSites();
      const filter = clean(args?.siteId);
      const target = filter ? sites.filter(s => s.id === filter) : sites;

      const statuses = target.map(site => {
        const base   = resolveArtifactsBase(site.id);
        const runDir = findLatestRunDir(base);
        if (!runDir) return { site: site.id, name: site.name, status: "no_runs", runDir: null };

        let gateCount = 0, goCount = 0;
        try {
          const gate = loadGate(runDir);
          gateCount = gate.length;
          goCount   = gate.filter(g => g?.gateStatus === "GO").length;
        } catch { /* gate missing */ }

        return {
          site: site.id, name: site.name, url: site.url,
          status: "ok", runDir,
          gateTotal: gateCount, gatePctGo: gateCount ? Math.round(goCount / gateCount * 100) : 0,
          goCount,
        };
      });
      return toolText(JSON.stringify({ sites: statuses }, null, 2));
    },
  },

  // ── Runs ─────────────────────────────────────────────────────────
  {
    name: "oracle.runs.latest",
    description: "Returns the latest artifacts run directory for a site (or default).",
    inputSchema: {
      type: "object",
      properties: {
        siteId: { type: "string", description: "Site id (riyadh|madinah|unaizah|khamis|jizan|abha). Defaults to riyadh." },
        runDir: { type: "string", description: "Explicit run directory (overrides auto-detect)." },
      },
      additionalProperties: false,
    },
    async call(args) {
      const runDir = resolveRunDir(args?.runDir || "", args?.siteId || "");
      return toolText(runDir);
    },
  },

  // ── Claims ───────────────────────────────────────────────────────
  {
    name: "oracle.claims.list_go",
    description: "Lists Gate=GO claims for a site's latest run.",
    inputSchema: {
      type: "object",
      properties: {
        siteId: { type: "string" },
        runDir: { type: "string" },
        limit:  { type: "number", description: "Max rows (default 100)." },
      },
      additionalProperties: false,
    },
    async call(args) {
      const runDir = resolveRunDir(args?.runDir || "", args?.siteId || "");
      const limit  = Math.max(1, Number(args?.limit) || 100);
      const gate   = loadGate(runDir);
      const go     = gate.filter(g => g?.gateStatus === "GO").slice(0, limit).map(g => ({
        invoiceNumber:          clean(g.invoiceNumber),
        mrn:                    clean(g.mrn),
        oracleFound:            Boolean(g.oracleFound),
        nphiesReady:            Boolean(g.nphiesReady),
        missingAttachmentCount: Number(g.missingAttachmentCount || 0),
        missingAttachmentTypes: clean(g.missingAttachmentTypes),
      }));
      return toolText(JSON.stringify({ runDir, count: go.length, claims: go }, null, 2));
    },
  },
  {
    name: "oracle.claims.select_go",
    description: "Selects N Gate=GO claims with all attachments resolved (optionally unique MRNs).",
    inputSchema: {
      type: "object",
      properties: {
        siteId:    { type: "string" },
        runDir:    { type: "string" },
        count:     { type: "number", description: "How many to select (default 3)." },
        uniqueMrn: { type: "boolean", description: "Prefer unique MRNs (default true)." },
      },
      additionalProperties: false,
    },
    async call(args) {
      const runDir   = resolveRunDir(args?.runDir || "", args?.siteId || "");
      const selected = selectGoClaims({
        runDir,
        count:     Number(args?.count) || 3,
        uniqueMrn: args?.uniqueMrn !== false,
      });
      return toolText(JSON.stringify({ runDir, selected }, null, 2));
    },
  },
  {
    name: "oracle.claims.bundle_manifest",
    description: "Returns the attachment bundle manifest for a specific invoice+mrn.",
    inputSchema: {
      type: "object",
      required: ["invoiceNumber", "mrn"],
      properties: {
        siteId:        { type: "string" },
        runDir:        { type: "string" },
        invoiceNumber: { type: "string" },
        mrn:           { type: "string" },
      },
      additionalProperties: false,
    },
    async call(args) {
      const runDir   = resolveRunDir(args?.runDir || "", args?.siteId || "");
      const invoice  = clean(args?.invoiceNumber);
      const mrn      = clean(args?.mrn);
      const manifest = loadManifest(runDir);
      const hit      = manifest.find(m => clean(m.invoiceNumber) === invoice && clean(m.mrn) === mrn);
      if (!hit) return toolText(`Not found: invoice=${invoice} mrn=${mrn} in ${runDir}`);
      return toolText(JSON.stringify({ runDir, claim: hit }, null, 2));
    },
  },

  // ── Scan control ─────────────────────────────────────────────────
  {
    name: "oracle.scan.trigger",
    description: "Queues a site scan by writing a trigger file. The daemon picks it up on its next cycle.",
    inputSchema: {
      type: "object",
      required: ["siteId"],
      properties: {
        siteId: { type: "string", description: "Site to scan (riyadh|madinah|unaizah|khamis|jizan|abha)." },
        fast:   { type: "boolean", description: "Use fast mode (skip visits, short timeouts)." },
        resume: { type: "boolean", description: "Resume from checkpoint." },
      },
      additionalProperties: false,
    },
    async call(args) {
      const siteId  = clean(args?.siteId);
      const sites   = loadSites();
      const site    = sites.find(s => s.id === siteId);
      if (!site) return toolText(`Unknown site: ${siteId}. Valid: ${sites.map(s => s.id).join(", ")}`);

      const triggerDir  = resolve(ROOT, "artifacts", "triggers");
      const triggerPath = join(triggerDir, `scan_${siteId}.json`);
      try {
        const { mkdirSync } = await import("node:fs");
        mkdirSync(triggerDir, { recursive: true });
        writeFileSync(triggerPath, JSON.stringify({
          siteId, fast: Boolean(args?.fast), resume: Boolean(args?.resume),
          requestedAt: new Date().toISOString(),
        }, null, 2), "utf8");
        return toolText(`Trigger written: ${triggerPath}. Daemon will pick up on next cycle.`);
      } catch (err) {
        return toolText(`Failed to write trigger: ${err.message}`);
      }
    },
  },

  // ── Portal health ─────────────────────────────────────────────────
  {
    name: "oracle.portal.health",
    description: "Checks HTTP reachability of each hospital portal site. Returns online/offline status with response time.",
    inputSchema: {
      type: "object",
      properties: {
        siteId: { type: "string", description: "Optional: single site id to check." },
      },
      additionalProperties: false,
    },
    async call(args) {
      const sites = loadSites();
      const filter = clean(args?.siteId);
      const targets = filter ? sites.filter(s => s.id === filter) : sites;

      function pingOne(site) {
        return new Promise(resolve => {
          const timer = setTimeout(() => resolve({ site: site.id, name: site.name, online: false, status: 0, ms: 8000, error: "timeout" }), 8000);
          try {
            const parsed = new URL(site.url);
            const useHttps = parsed.protocol === "https:";
            const requester = useHttps ? httpsRequest : httpRequest;
            const start = Date.now();
            const req = requester({
              hostname: parsed.hostname,
              port: parsed.port || (useHttps ? 443 : 80),
              path: parsed.pathname || "/",
              method: "HEAD",
              rejectUnauthorized: site.tlsRejectUnauthorized !== false,
              timeout: 7000,
            }, res => {
              clearTimeout(timer);
              res.resume();
              resolve({ site: site.id, name: site.name, online: true, status: res.statusCode, ms: Date.now() - start });
            });
            req.on("error", err => { clearTimeout(timer); resolve({ site: site.id, name: site.name, online: false, status: 0, ms: Date.now() - start, error: err.message }); });
            req.on("timeout", () => { req.destroy(); clearTimeout(timer); resolve({ site: site.id, name: site.name, online: false, status: 0, ms: 7000, error: "timeout" }); });
            req.end();
          } catch (err) {
            clearTimeout(timer);
            resolve({ site: site.id, name: site.name, online: false, status: 0, ms: 0, error: err.message });
          }
        });
      }

      const results = await Promise.all(targets.map(pingOne));
      const onlineCount = results.filter(r => r.online).length;
      return toolText(JSON.stringify({ checked: results.length, online: onlineCount, offline: results.length - onlineCount, sites: results }, null, 2));
    },
  },
];

// ---- MCP stdio JSON-RPC framing (Content-Length) --------------------

function writeMessage(obj) {
  const json    = JSON.stringify(obj);
  const payload = Buffer.from(json, "utf8");
  process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
  process.stdout.write(payload);
}

function errorResponse(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: "2.0", id, error: err };
}

function okResponse(id, result) {
  return { jsonrpc: "2.0", id, result };
}

let buffer = Buffer.alloc(0);

function tryReadFrame() {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd === -1) return null;
  const headerText = buffer.slice(0, headerEnd).toString("utf8");
  const match = headerText.match(/Content-Length:\s*(\d+)/i);
  if (!match) throw new Error("Missing Content-Length header");
  const length     = Number.parseInt(match[1], 10);
  const frameStart = headerEnd + 4;
  if (buffer.length < frameStart + length) return null;
  const body = buffer.slice(frameStart, frameStart + length).toString("utf8");
  buffer = buffer.slice(frameStart + length);
  return body;
}

async function handleRequest(msg) {
  const id     = Object.prototype.hasOwnProperty.call(msg, "id") ? msg.id : null;
  const method = clean(msg?.method);
  const params = msg?.params;
  if (!method) return;

  if (method === "initialize") {
    writeMessage(okResponse(id, {
      protocolVersion: "2024-11-05",
      serverInfo: { name: "oracle-nphies-mcp", version: "0.2.0" },
      capabilities: { tools: {} },
    }));
    return;
  }

  if (method === "tools/list") {
    writeMessage(okResponse(id, { tools: tools.map(({ call, ...rest }) => rest) }));
    return;
  }

  if (method === "tools/call") {
    const name = clean(params?.name);
    const args = params?.arguments || {};
    const tool = tools.find(t => t.name === name);
    if (!tool) { writeMessage(errorResponse(id, -32601, `Unknown tool: ${name}`)); return; }
    try {
      const result = await tool.call(args);
      writeMessage(okResponse(id, result));
    } catch (error) {
      writeMessage(errorResponse(id, -32000, error.message, { stack: error.stack }));
    }
    return;
  }

  if (method.startsWith("notifications/")) return;
  if (id !== null) writeMessage(errorResponse(id, -32601, `Method not found: ${method}`));
}

process.stdin.on("data", async chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    let frame;
    try { frame = tryReadFrame(); }
    catch (error) {
      writeMessage(errorResponse(null, -32700, `Parse error: ${error.message}`));
      buffer = Buffer.alloc(0);
      return;
    }
    if (frame === null) break;
    const msg = jsonParseSafe(frame, null);
    if (!msg) { writeMessage(errorResponse(null, -32700, "Parse error: invalid JSON")); continue; }
    await handleRequest(msg);
  }
});

process.stdin.resume();
