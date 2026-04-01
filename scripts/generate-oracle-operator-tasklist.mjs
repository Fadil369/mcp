import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import XLSX from "xlsx";

function parseArgs(argv) {
  const args = {
    queueJson: "manual_retrieval_queue.json",
    processingReportXlsx: "full_processing_report_1770723285649 (1).xlsx",
    outputXlsx: "oracle_operator_tasklist.xlsx",
    outputTasksCsv: "oracle_operator_tasks.csv",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === "--queue-json" && next) {
      args.queueJson = next;
      i += 1;
    } else if (key === "--processing-report-xlsx" && next) {
      args.processingReportXlsx = next;
      i += 1;
    } else if (key === "--output-xlsx" && next) {
      args.outputXlsx = next;
      i += 1;
    } else if (key === "--output-tasks-csv" && next) {
      args.outputTasksCsv = next;
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

function normalizePriority(value) {
  const p = String(value || "").trim().toUpperCase();
  if (p === "HIGH" || p === "MEDIUM" || p === "LOW") return p;
  return "UNKNOWN";
}

function priorityRank(priority) {
  if (priority === "HIGH") return 1;
  if (priority === "MEDIUM") return 2;
  if (priority === "LOW") return 3;
  return 9;
}

function suggestModule(type) {
  const t = String(type || "").toLowerCase();
  if (t.includes("lab") || t.includes("laboratory")) return "Laboratory Reports module";
  if (t.includes("radiology") || t.includes("imaging")) return "Radiology/Imaging module";
  if (t.includes("prescription") || t.includes("medication")) return "Medication/Prescription module";
  if (t.includes("operative") || t.includes("procedure")) return "Procedure/Operative notes module";
  if (t.includes("clinical") || t.includes("progress") || t.includes("assessment")) return "Documents Panel (notes)";
  if (t.includes("justification") || t.includes("treatment")) return "Documents Panel (letters/plans)";
  return "Documents Panel";
}

function run() {
  const args = parseArgs(process.argv.slice(2));
  const queue = JSON.parse(readFileSync(resolve(args.queueJson), "utf8"));
  const claimQueue = Array.isArray(queue.queue) ? queue.queue : [];

  const wb = XLSX.readFile(resolve(args.processingReportXlsx), { cellDates: false });
  const reportRows = XLSX.utils.sheet_to_json(wb.Sheets["All Submissions"], { defval: null });
  const reportByInvoice = new Map();
  for (const row of reportRows) {
    const invoice = String(row["Invoice"] ?? row["Invoice Number"] ?? "").trim();
    if (!invoice) continue;
    reportByInvoice.set(invoice, row);
  }

  const claimRows = claimQueue.map((c) => {
    const invoice = String(c.invoiceNumber ?? "");
    const rr = reportByInvoice.get(invoice);
    const priority = normalizePriority(rr?.Priority);
    return {
      invoiceNumber: invoice,
      mrn: String(c.mrn ?? ""),
      priority,
      oracleFound: Boolean(c.oracleFound),
      requiredAttachmentCount: Number(c.requiredAttachmentCount || 0),
      resolvedAttachmentCount: Number(c.resolvedAttachmentCount || 0),
      missingAttachmentCount: Number(c.missingAttachmentCount || 0),
      missingAttachmentTypes: Array.isArray(c.missingAttachmentTypes) ? c.missingAttachmentTypes.join("; ") : "",
      reportStatus: String(rr?.Status ?? ""),
      reportAttachments: rr ? Number(rr["Attachments"] || 0) : "",
      reportLineItems: rr ? Number(rr["Line Items"] || 0) : "",
      reportTotalAmount: rr ? rr["Total Amount"] : "",
      recommendedAction: String(c.recommendedAction ?? ""),
    };
  });

  const taskRows = [];
  let taskId = 1;
  for (const c of claimQueue) {
    const invoice = String(c.invoiceNumber ?? "");
    const rr = reportByInvoice.get(invoice);
    const priority = normalizePriority(rr?.Priority);
    const missing = Array.isArray(c.missingAttachmentTypes) ? c.missingAttachmentTypes : [];
    for (const type of missing) {
      taskRows.push({
        taskId,
        priority,
        invoiceNumber: invoice,
        mrn: String(c.mrn ?? ""),
        attachmentType: String(type || ""),
        suggestedModule: suggestModule(type),
        oracleFound: Boolean(c.oracleFound),
        status: "TODO",
        notes: "",
      });
      taskId += 1;
    }
  }

  taskRows.sort((a, b) => {
    const pr = priorityRank(a.priority) - priorityRank(b.priority);
    if (pr !== 0) return pr;
    const inv = a.invoiceNumber.localeCompare(b.invoiceNumber);
    if (inv !== 0) return inv;
    return a.attachmentType.localeCompare(b.attachmentType);
  });

  claimRows.sort((a, b) => {
    const pr = priorityRank(a.priority) - priorityRank(b.priority);
    if (pr !== 0) return pr;
    const miss = b.missingAttachmentCount - a.missingAttachmentCount;
    if (miss !== 0) return miss;
    return a.invoiceNumber.localeCompare(b.invoiceNumber);
  });

  const outWb = XLSX.utils.book_new();
  const wsClaims = XLSX.utils.json_to_sheet(claimRows);
  const wsTasks = XLSX.utils.json_to_sheet(taskRows);
  XLSX.utils.book_append_sheet(outWb, wsClaims, "Claims");
  XLSX.utils.book_append_sheet(outWb, wsTasks, "Tasks");
  XLSX.writeFile(outWb, resolve(args.outputXlsx));

  writeCsv(resolve(args.outputTasksCsv), taskRows, [
    "taskId",
    "priority",
    "invoiceNumber",
    "mrn",
    "attachmentType",
    "suggestedModule",
    "oracleFound",
    "status",
    "notes",
  ]);

  console.log(`Claims: ${claimRows.length}`);
  console.log(`Tasks: ${taskRows.length}`);
  console.log(`XLSX: ${resolve(args.outputXlsx)}`);
  console.log(`CSV: ${resolve(args.outputTasksCsv)}`);
}

run();

