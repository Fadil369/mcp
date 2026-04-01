import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import XLSX from "xlsx";

function parseArgs(argv) {
  const args = {
    payload: "nphies_normalized_submissions.json",
    sourceXlsx: "AL_RAJHI_TAKAFUL_INSURANCE1001-183_2025-12_Ts2026-02-10_12-23-09_Sid2511.xlsx",
    processingReportXlsx: "full_processing_report_1770723285649 (1).xlsx",
    outputJson: "dry_run_nphies_checklist.json",
    outputCsv: "dry_run_nphies_checklist.csv",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === "--payload" && next) {
      args.payload = next;
      i += 1;
    } else if (key === "--source-xlsx" && next) {
      args.sourceXlsx = next;
      i += 1;
    } else if (key === "--processing-report-xlsx" && next) {
      args.processingReportXlsx = next;
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

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

function readSheet(path, name) {
  const wb = XLSX.readFile(resolve(path), { cellDates: false });
  const ws = wb.Sheets[name];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json(ws, { defval: null });
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
  const payload = readJson(args.payload);
  const submissions = Array.isArray(payload.submissions) ? payload.submissions : [];

  const sourceRows = readSheet(args.sourceXlsx, "Sheet1");
  const reportRows = readSheet(args.processingReportXlsx, "All Submissions");

  const sourceByInvoice = new Map();
  for (const row of sourceRows) {
    const invoice = String(row["Invoice No"] ?? row["Invoice Number"] ?? "").trim();
    if (!invoice) continue;
    if (!sourceByInvoice.has(invoice)) {
      sourceByInvoice.set(invoice, {
        rows: 0,
        mrn: String(row["Med Rec No"] ?? ""),
        patientName: String(row["Patient Name"] ?? ""),
        invoiceTotal: toNum(row["Invoice Total"] ?? row["Invoice Net Amount"] ?? 0),
      });
    }
    sourceByInvoice.get(invoice).rows += 1;
  }

  const reportByInvoice = new Map();
  for (const row of reportRows) {
    const invoice = String(row["Invoice"] ?? row["Invoice Number"] ?? "").trim();
    if (!invoice) continue;
    reportByInvoice.set(invoice, row);
  }

  const checklist = submissions.map((s, index) => {
    const invoice = String(s.invoiceNumber ?? "");
    const mrn = String(s.mrn ?? "");
    const source = sourceByInvoice.get(invoice);
    const report = reportByInvoice.get(invoice);
    const payloadAttachmentCount = Array.isArray(s.attachments) ? s.attachments.length : 0;
    const declaredAttachmentCount = toNum(s.sourceAttachmentCount ?? payloadAttachmentCount);
    const attachmentTypes = Array.isArray(s.attachments)
      ? s.attachments.map((a) => String(a.type || "").trim()).filter(Boolean)
      : [];
    const uniqueAttachmentTypes = new Set(attachmentTypes);

    const checks = {
      hasInvoice: Boolean(invoice),
      hasMrn: Boolean(mrn),
      hasPatientId: String(s.patientId ?? "") !== "",
      sourceInvoiceFound: Boolean(source),
      sourceMrnMatch: Boolean(source) && String(source.mrn) === mrn,
      sourceLineItemCountMatch: Boolean(source) && toNum(s.lineItemCount) === toNum(source.rows),
      sourceAmountMatch: Boolean(source) && Math.abs(toNum(s.totalAmount) - toNum(source.invoiceTotal)) <= 0.02,
      reportInvoiceFound: Boolean(report),
      reportStatusReady: Boolean(report) && String(report["Status"] ?? "").toUpperCase() === "READY",
      attachmentCountMatch: payloadAttachmentCount === declaredAttachmentCount,
      attachmentTypesPresent: payloadAttachmentCount > 0 && attachmentTypes.length === payloadAttachmentCount,
      attachmentTypesUnique: uniqueAttachmentTypes.size === attachmentTypes.length,
    };

    const failedChecks = Object.entries(checks)
      .filter(([, ok]) => !ok)
      .map(([name]) => name);

    return {
      checklistId: index + 1,
      invoiceNumber: invoice,
      mrn,
      patientId: String(s.patientId ?? ""),
      patientName: String(s.patientName ?? ""),
      lineItemCount: toNum(s.lineItemCount),
      sourceLineItemCount: source ? toNum(source.rows) : "",
      totalAmount: toNum(s.totalAmount),
      sourceTotalAmount: source ? toNum(source.invoiceTotal) : "",
      payloadAttachmentCount,
      declaredAttachmentCount,
      reportStatus: report ? String(report["Status"] ?? "") : "",
      dryRunPass: failedChecks.length === 0,
      failedChecks,
      checks,
    };
  });

  const summary = {
    runAt: new Date().toISOString(),
    submissionsChecked: checklist.length,
    passCount: checklist.filter((r) => r.dryRunPass).length,
    failCount: checklist.filter((r) => !r.dryRunPass).length,
    failedCheckFrequency: checklist
      .flatMap((r) => r.failedChecks)
      .reduce((acc, key) => {
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
  };

  const outJson = {
    summary,
    checklist,
  };

  mkdirSync(dirname(resolve(args.outputJson)), { recursive: true });
  writeFileSync(resolve(args.outputJson), `${JSON.stringify(outJson, null, 2)}\n`, "utf8");

  const csvRows = checklist.map((row) => ({
    checklistId: row.checklistId,
    invoiceNumber: row.invoiceNumber,
    mrn: row.mrn,
    patientId: row.patientId,
    patientName: row.patientName,
    lineItemCount: row.lineItemCount,
    sourceLineItemCount: row.sourceLineItemCount,
    totalAmount: row.totalAmount,
    sourceTotalAmount: row.sourceTotalAmount,
    payloadAttachmentCount: row.payloadAttachmentCount,
    declaredAttachmentCount: row.declaredAttachmentCount,
    reportStatus: row.reportStatus,
    dryRunPass: row.dryRunPass,
    failedChecks: row.failedChecks.join(";"),
  }));

  writeCsv(args.outputCsv, csvRows, [
    "checklistId",
    "invoiceNumber",
    "mrn",
    "patientId",
    "patientName",
    "lineItemCount",
    "sourceLineItemCount",
    "totalAmount",
    "sourceTotalAmount",
    "payloadAttachmentCount",
    "declaredAttachmentCount",
    "reportStatus",
    "dryRunPass",
    "failedChecks",
  ]);

  console.log(`Checked submissions: ${summary.submissionsChecked}`);
  console.log(`Dry-run pass: ${summary.passCount}`);
  console.log(`Dry-run fail: ${summary.failCount}`);
  console.log(`JSON: ${resolve(args.outputJson)}`);
  console.log(`CSV: ${resolve(args.outputCsv)}`);
}

run();
