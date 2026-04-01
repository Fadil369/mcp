import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

function parseArgs(argv) {
  const args = {
    manifest: "artifacts/oracle-portal/latest/nphies_submission_bundle_manifest.json",
    outputJson: "manual_retrieval_queue.json",
    outputCsv: "manual_retrieval_queue.csv",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === "--manifest" && next) {
      args.manifest = next;
      i += 1;
    } else if (key === "--output-json" && next) {
      args.outputJson = next;
      i += 1;
    } else if (key === "--output-csv" && next) {
      args.outputCsv = next;
      i += 1;
    }
  }

  return args;
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (text.includes(",") || text.includes("\"") || text.includes("\n")) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function writeCsv(path, rows, headers) {
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  }
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), `${lines.join("\n")}\n`, "utf8");
}

function run() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(resolve(args.manifest), "utf8"));
  const claims = Array.isArray(manifest) ? manifest : [];

  const queue = claims
    .map((claim, idx) => {
      const missing = (claim.attachments || [])
        .filter((a) => String(a.status || "").toLowerCase() !== "ready")
        .map((a) => a.requiredType);
      return {
        queueId: idx + 1,
        invoiceNumber: String(claim.invoiceNumber ?? ""),
        mrn: String(claim.mrn ?? ""),
        oracleFound: Boolean(claim.oracleFound),
        nphiesReady: Boolean(claim.nphiesReady),
        requiredAttachmentCount: Number(claim.requiredAttachmentCount || 0),
        resolvedAttachmentCount: Number(claim.resolvedAttachmentCount || 0),
        missingAttachmentCount: missing.length,
        missingAttachmentTypes: missing,
        recommendedAction: claim.oracleFound
          ? (missing.length ? "Retrieve missing attachments in Oracle portal" : "Ready for NPHIES submission")
          : "Resolve MRN/patient match in Oracle",
      };
    })
    .sort((a, b) => b.missingAttachmentCount - a.missingAttachmentCount || a.invoiceNumber.localeCompare(b.invoiceNumber));

  const summary = {
    runAt: new Date().toISOString(),
    totalClaims: queue.length,
    claimsReady: queue.filter((q) => q.nphiesReady).length,
    claimsMissingAttachments: queue.filter((q) => q.missingAttachmentCount > 0).length,
    claimsMissingPatientMatch: queue.filter((q) => !q.oracleFound).length,
    missingTypeFrequency: queue
      .flatMap((q) => q.missingAttachmentTypes)
      .reduce((acc, type) => {
        acc[type] = (acc[type] || 0) + 1;
        return acc;
      }, {}),
  };

  const out = { summary, queue };
  mkdirSync(dirname(resolve(args.outputJson)), { recursive: true });
  writeFileSync(resolve(args.outputJson), `${JSON.stringify(out, null, 2)}\n`, "utf8");

  const rows = queue.map((q) => ({
    queueId: q.queueId,
    invoiceNumber: q.invoiceNumber,
    mrn: q.mrn,
    oracleFound: q.oracleFound,
    nphiesReady: q.nphiesReady,
    requiredAttachmentCount: q.requiredAttachmentCount,
    resolvedAttachmentCount: q.resolvedAttachmentCount,
    missingAttachmentCount: q.missingAttachmentCount,
    missingAttachmentTypes: q.missingAttachmentTypes.join("; "),
    recommendedAction: q.recommendedAction,
  }));
  writeCsv(args.outputCsv, rows, [
    "queueId",
    "invoiceNumber",
    "mrn",
    "oracleFound",
    "nphiesReady",
    "requiredAttachmentCount",
    "resolvedAttachmentCount",
    "missingAttachmentCount",
    "missingAttachmentTypes",
    "recommendedAction",
  ]);

  console.log(`Claims in queue: ${summary.totalClaims}`);
  console.log(`Ready claims: ${summary.claimsReady}`);
  console.log(`Claims missing attachments: ${summary.claimsMissingAttachments}`);
  console.log(`Claims missing patient match: ${summary.claimsMissingPatientMatch}`);
  console.log(`JSON: ${resolve(args.outputJson)}`);
  console.log(`CSV: ${resolve(args.outputCsv)}`);
}

run();
