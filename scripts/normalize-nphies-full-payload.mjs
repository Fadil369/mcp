import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

function parseArgs(argv) {
  const args = {
    input: "nphies_full_payload.json",
    output: "nphies_normalized_submissions.json",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === "--input" && next) {
      args.input = next;
      i += 1;
    } else if (key === "--output" && next) {
      args.output = next;
      i += 1;
    }
  }

  return args;
}

function sanitizeFileComponent(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .trim();
}

function uniqueTypes(types) {
  const seen = new Set();
  const out = [];
  for (const type of types) {
    const key = String(type || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function buildAttachments(mrn, docTypes, requiredCount) {
  const needed = Math.max(0, Number(requiredCount) || 0);
  const selected = docTypes.slice(0, needed);
  const padded = [...selected];

  for (let i = selected.length; i < needed; i += 1) {
    padded.push(`Unknown Attachment ${i + 1}`);
  }

  return padded.map((type) => ({
    type,
    fileName: `${sanitizeFileComponent(mrn)}_${sanitizeFileComponent(type)}.pdf`,
    contentType: "application/pdf",
    description: `Supporting documentation for ${type}`,
  }));
}

function normalizePayload(data) {
  const patients = Array.isArray(data.patients) ? data.patients : [];
  const submissions = [];

  for (const patient of patients) {
    const patientDocs = uniqueTypes((patient.documents || []).map((item) => item.documentType));
    const patientSubmissions = Array.isArray(patient.submissions) ? patient.submissions : [];

    for (const sub of patientSubmissions) {
      const attachmentCount = Number(sub.attachments) || 0;
      const attachments = buildAttachments(sub.mrn || patient.mrn, patientDocs, attachmentCount);

      submissions.push({
        invoiceNumber: sub.invoiceNumber,
        mrn: String(sub.mrn || patient.mrn || ""),
        patientId: sub.patientId ?? "",
        patientName: sub.patientName || patient.patientName || "",
        nationalId: sub.nationalId || patient.nationalId || "",
        membershipNo: sub.membershipNo || "",
        policyHolder: sub.policyHolder || "",
        lineItems: [],
        lineItemCount: Number(sub.lineItems) || 0,
        totalAmount: Number(sub.totalAmount) || 0,
        attachments,
        sourceAttachmentCount: attachmentCount,
        sourceStatus: sub.status || "",
      });
    }
  }

  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      sourceGeneratedAt: data.metadata?.generatedAt || "",
      sourceWorkflow: data.metadata?.workflow || "",
      sourcePatients: patients.length,
      sourceSubmissions: submissions.length,
    },
    submissions,
  };
}

function run() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = resolve(args.input);
  const outputPath = resolve(args.output);

  const raw = readFileSync(inputPath, "utf8");
  const data = JSON.parse(raw);
  const normalized = normalizePayload(data);

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");

  const attachmentTotal = normalized.submissions.reduce((sum, s) => sum + (s.attachments?.length || 0), 0);
  console.log(`Normalized submissions: ${normalized.submissions.length}`);
  console.log(`Total required attachments: ${attachmentTotal}`);
  console.log(`Output: ${outputPath}`);
}

run();
