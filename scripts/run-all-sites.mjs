#!/usr/bin/env node
/**
 * run-all-sites.mjs
 *
 * Runs oracle-scanner sequentially across every enabled site in sites.json.
 * Per-site credentials are drawn from .env (ORACLE_<SITE_ID_UPPER>_USERNAME etc.).
 * Each site gets its own artifacts subdirectory so runs never collide.
 *
 * Usage:
 *   node scripts/run-all-sites.mjs [--sites riyadh,khamis] [--limit 10] [--resume] [--fast] [--dry-run]
 */

import { readFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { execSync } from "node:child_process";
import dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), ".env") });

const ROOT = resolve(import.meta.dirname || ".", "..");
const argv = process.argv.slice(2);

// Parse CLI flags
function flag(name) { return argv.includes(name); }
function option(name) {
  const idx = argv.indexOf(name);
  return idx !== -1 ? argv[idx + 1] : null;
}

const siteFilter  = option("--sites") ? option("--sites").split(",").map(s => s.trim().toLowerCase()) : null;
const limit       = option("--limit") || "";
const resume      = flag("--resume") ? "--resume" : "";
const fast        = flag("--fast")   ? "--fast"   : "";
const dryRun      = flag("--dry-run") ? "--dry-run" : "";
const concurrency = option("--concurrency") || "1";

// Load site definitions
const sitesPath = resolve(ROOT, "sites.json");
const allSites = JSON.parse(readFileSync(sitesPath, "utf8"));
const sites = allSites.filter(s => {
  if (!s.enabled) return false;
  if (siteFilter && !siteFilter.includes(s.id.toLowerCase())) return false;
  return true;
});

if (sites.length === 0) {
  console.error("No enabled sites found. Check sites.json or --sites filter.");
  process.exit(1);
}

// Find node executable (support portable install)
const NODE_EXE = process.env.NODE_EXE || process.execPath;
const NODE_FLAGS = "--max-old-space-size=4096 --expose-gc";

function sep(label) {
  const line = "═".repeat(60);
  console.log(`\n${line}`);
  console.log(`  ${label}`);
  console.log(`${line}\n`);
}

function getSiteEnv(site) {
  const prefix = `ORACLE_${site.id.toUpperCase()}_`;
  const username  = process.env[`${prefix}USERNAME`] || process.env.ORACLE_USERNAME || "";
  const password  = process.env[`${prefix}PASSWORD`] || process.env.ORACLE_PASSWORD || "";
  const url       = process.env[`${prefix}URL`]      || site.url;

  return {
    ...process.env,
    ORACLE_PORTAL_URL:    url,
    ORACLE_USERNAME:      username,
    ORACLE_PASSWORD:      password,
    ORACLE_ARTIFACTS_DIR: site.artifactsDir,
    // Disable TLS rejection for HTTPS sites with self-signed certs (Riyadh)
    NODE_TLS_REJECT_UNAUTHORIZED: site.tlsRejectUnauthorized === false ? "0" : "1",
  };
}

const results = [];

for (const site of sites) {
  sep(`Site: ${site.name}  [${site.id}]  →  ${site.url}`);

  // Ensure artifacts dir exists
  mkdirSync(resolve(ROOT, site.artifactsDir), { recursive: true });

  const scannerPath = resolve(ROOT, "oracle-scanner.mjs");
  const payloadPath = resolve(ROOT, "nphies_normalized_submissions.json");

  const cmdParts = [
    `"${NODE_EXE}"`, NODE_FLAGS,
    `"${scannerPath}"`,
    "--payload", `"${payloadPath}"`,
    resume, fast, dryRun,
    limit ? `--limit ${limit}` : "",
    `--concurrency ${concurrency}`,
  ].filter(Boolean).join(" ");

  const logFile = resolve(ROOT, site.artifactsDir, `scan_${site.id}.log`);
  const fullCmd = `${cmdParts} >> "${logFile}" 2>&1`;

  console.log(`Command : ${cmdParts}`);
  console.log(`Log     : ${logFile}`);
  console.log("");

  const start = Date.now();
  let success = false;
  try {
    execSync(fullCmd, {
      cwd: ROOT,
      env: getSiteEnv(site),
      stdio: "inherit",
      timeout: 4 * 3600 * 1000, // 4h max per site
    });
    success = true;
  } catch (err) {
    console.error(`\n[${site.name}] Scan failed: ${err.message}`);
  }

  const elapsed = Math.round((Date.now() - start) / 1000 / 60);
  results.push({ site: site.name, success, elapsed });
  console.log(`\n[${site.name}] ${success ? "✅ OK" : "❌ FAILED"} — ${elapsed} min`);
}

// Summary
sep("Run Summary");
for (const r of results) {
  console.log(`  ${r.success ? "✅" : "❌"}  ${r.site.padEnd(12)} ${r.elapsed} min`);
}
const failed = results.filter(r => !r.success).length;
console.log(`\n  Total: ${results.length} sites, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
