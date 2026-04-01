#!/usr/bin/env node
// End-to-end NPHIES submission pipeline orchestrator.
// Runs: normalize → dry-run checklist → scan (with resume) → package results
//
// Usage: node scripts/run-pipeline.mjs [--limit N] [--skip-normalize] [--skip-checklist]

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const limit = argv.includes("--limit") ? argv[argv.indexOf("--limit") + 1] : "";
const skipNormalize = argv.includes("--skip-normalize");
const skipChecklist = argv.includes("--skip-checklist");

const NODE = "node --max-old-space-size=4096 --expose-gc";
const CWD = resolve(import.meta.dirname || ".", "..");

function run(label, cmd) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${label}`);
  console.log(`${"═".repeat(60)}\n`);
  try {
    execSync(cmd, { cwd: CWD, stdio: "inherit", timeout: 3600_000 });
    console.log(`✅ ${label} — done\n`);
    return true;
  } catch (error) {
    console.error(`❌ ${label} — failed: ${error.message}\n`);
    return false;
  }
}

// Step 1: Normalize payload
if (!skipNormalize) {
  const payloadExists = existsSync(resolve(CWD, "nphies_full_payload.json"));
  if (payloadExists) {
    run("Step 1: Normalize NPHIES payload",
      `${NODE} scripts/normalize-nphies-full-payload.mjs`);
  } else {
    console.log("⚠️  nphies_full_payload.json not found, skipping normalization.");
  }
} else {
  console.log("⏭️  Skipping normalization (--skip-normalize).");
}

// Step 2: Dry-run checklist validation
if (!skipChecklist) {
  const normalizedExists = existsSync(resolve(CWD, "nphies_normalized_submissions.json"));
  if (normalizedExists) {
    run("Step 2: Dry-run checklist validation",
      `${NODE} scripts/dry-run-nphies-checklist.mjs`);
  } else {
    console.log("⚠️  nphies_normalized_submissions.json not found, skipping checklist.");
  }
} else {
  console.log("⏭️  Skipping checklist (--skip-checklist).");
}

// Step 3: Run Oracle scanner with resume support
const scanArgs = ["--payload", "nphies_normalized_submissions.json", "--resume"];
if (limit) scanArgs.push("--limit", limit);
const scanOk = run("Step 3: Oracle portal scan & document retrieval",
  `${NODE} oracle-scanner.mjs ${scanArgs.join(" ")}`);

if (!scanOk) {
  console.log("\n⚠️  Scanner did not complete. You can re-run this pipeline to resume from the last checkpoint.");
  console.log("   Or run directly: npm run scan:resume");
  process.exit(1);
}

// Step 4: Package ready submissions
run("Step 4: Package NPHIES-ready submissions",
  `${NODE} scripts/package-nphies-ready-submissions.mjs`);

// Step 5: Build manual retrieval queue for missing docs
run("Step 5: Build manual retrieval queue",
  `${NODE} scripts/build-manual-retrieval-queue.mjs`);

console.log("\n" + "═".repeat(60));
console.log("  Pipeline complete!");
console.log("═".repeat(60));
console.log("\nNext steps:");
console.log("  1. Check artifacts/oracle-portal/run-*/submission_gate.csv for GO/NO_GO status");
console.log("  2. Review manual_retrieval_queue.csv for any missing documents");
console.log("  3. Upload nphies_upload_package/ contents to NPHIES portal");
