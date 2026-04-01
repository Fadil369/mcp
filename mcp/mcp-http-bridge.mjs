/**
 * mcp-http-bridge.mjs
 *
 * Thin HTTP wrapper around the oracle-nphies MCP stdio server.
 * Accepts POST /mcp with a JSON-RPC body, spawns the MCP process
 * via stdio framing, and returns the JSON-RPC response.
 *
 * This is what Cloudflare Access terminates against so the MCP
 * tools are reachable over HTTPS from outside the LAN.
 *
 * Usage:
 *   node mcp/mcp-http-bridge.mjs          (default port 3456)
 *   PORT=3456 node mcp/mcp-http-bridge.mjs
 *
 * Protected by Cloudflare Access — no auth built-in here intentionally.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const PORT    = Number(process.env.PORT) || 3456;
const ROOT    = resolve(import.meta.dirname || ".", "..");
const NODE    = process.env.NODE_EXE || process.execPath;
const MCP_JS  = resolve(ROOT, "mcp", "oracle-nphies-mcp.mjs");

function frameMessage(obj) {
  const json    = JSON.stringify(obj);
  const payload = Buffer.from(json, "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "utf8"),
    payload,
  ]);
}

function parseMcpFrame(buf) {
  const headerEnd = buf.indexOf("\r\n\r\n");
  if (headerEnd === -1) return null;
  const headerText = buf.slice(0, headerEnd).toString("utf8");
  const match = headerText.match(/Content-Length:\s*(\d+)/i);
  if (!match) return null;
  const length     = Number.parseInt(match[1], 10);
  const frameStart = headerEnd + 4;
  if (buf.length < frameStart + length) return null;
  return buf.slice(frameStart, frameStart + length).toString("utf8");
}

const server = createServer((req, res) => {
  // CORS headers (Cloudflare handles external auth)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.method !== "POST" || req.url !== "/mcp") {
    res.writeHead(404); res.end(JSON.stringify({ error: "POST /mcp only" })); return;
  }

  let body = "";
  req.on("data", chunk => { body += chunk; });
  req.on("end", () => {
    let reqObj;
    try { reqObj = JSON.parse(body); }
    catch { res.writeHead(400); res.end(JSON.stringify({ error: "Invalid JSON" })); return; }

    // Spawn the MCP process per-request (stateless / fast)
    const child = spawn(NODE, [MCP_JS], {
      cwd: ROOT,
      env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
    });

    let respBuf = Buffer.alloc(0);

    // Step 1: send initialize
    child.stdin.write(frameMessage({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }));

    // Step 2: once initialized, send actual request
    let initialized = false;

    child.stdout.on("data", chunk => {
      respBuf = Buffer.concat([respBuf, chunk]);
      const frame = parseMcpFrame(respBuf);
      if (!frame) return;

      if (!initialized) {
        initialized = true;
        // Drain the initialize response, send the real request
        child.stdin.write(frameMessage({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }));
        child.stdin.write(frameMessage({ ...reqObj, id: reqObj.id ?? 1 }));
        respBuf = Buffer.alloc(0);
        return;
      }

      // Got the actual response
      child.stdin.end();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(frame);
      child.kill();
    });

    child.stderr.on("data", d => process.stderr.write(d));
    child.on("error", err => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    child.on("close", code => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: `MCP process exited: ${code}` }));
      }
    });
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mcp-http-bridge] Listening on http://127.0.0.1:${PORT}/mcp`);
  console.log(`[mcp-http-bridge] MCP server: ${MCP_JS}`);
});
