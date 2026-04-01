import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

function parseArgs(argv) {
  const args = {
    manifest: "",
    payload: "nphies_normalized_submissions.json",
    outputDir: "nphies_upload_package",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === "--manifest" && next) {
      args.manifest = next;
      i += 1;
    } else if (key === "--payload" && next) {
      args.payload = next;
      i += 1;
    } else if (key === "--output-dir" && next) {
      args.outputDir = next;
      i += 1;
    }
  }

  if (!args.manifest) {
    throw new Error("--manifest is required");
  }
  return args;
}

function timestampId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sanitize(value) {
  return String(value || "").replace(/[\\/:*?"<>|]+/g, "_").trim();
}

function run() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(resolve(args.manifest), "utf8"));
  const payload = JSON.parse(readFileSync(resolve(args.payload), "utf8"));
  const claims = Array.isArray(manifest) ? manifest : [];
  const submissions = Array.isArray(payload.submissions) ? payload.submissions : [];

  const submissionMap = new Map(
    submissions.map((s) => [`${String(s.invoiceNumber)}|${String(s.mrn)}`, s]),
  );

  const outRoot = resolve(args.outputDir, `package-${timestampId()}`);
  mkdirSync(outRoot, { recursive: true });
  const attachmentsRoot = join(outRoot, "attachments");
  mkdirSync(attachmentsRoot, { recursive: true });

  const readyClaims = claims.filter((c) => c.nphiesReady);
  const packageClaims = [];

  for (const claim of readyClaims) {
    const key = `${String(claim.invoiceNumber)}|${String(claim.mrn)}`;
    const submission = submissionMap.get(key) || {};
    const claimDirName = `${sanitize(claim.invoiceNumber)}_${sanitize(claim.mrn)}`;
    const claimDir = join(attachmentsRoot, claimDirName);
    mkdirSync(claimDir, { recursive: true });

    const readyAttachments = (claim.attachments || []).filter((a) => a.status === "ready" && a.filePath);
    const copied = [];
    for (const att of readyAttachments) {
      if (!existsSync(att.filePath)) continue;
      const fileName = basename(att.filePath);
      const targetPath = join(claimDir, fileName);
      copyFileSync(att.filePath, targetPath);
      copied.push({
        requiredType: att.requiredType,
        fileName,
        sourceType: att.sourceType,
        sha256: att.sha256,
        packagePath: targetPath,
      });
    }

    packageClaims.push({
      invoiceNumber: claim.invoiceNumber,
      mrn: claim.mrn,
      patientId: submission.patientId || "",
      patientName: submission.patientName || "",
      totalAmount: submission.totalAmount ?? "",
      requiredAttachmentCount: claim.requiredAttachmentCount,
      resolvedAttachmentCount: claim.resolvedAttachmentCount,
      packagedAttachmentCount: copied.length,
      attachments: copied,
    });
  }

  const summary = {
    runAt: new Date().toISOString(),
    sourceManifest: resolve(args.manifest),
    sourcePayload: resolve(args.payload),
    totalClaimsInManifest: claims.length,
    readyClaimsInManifest: readyClaims.length,
    packagedClaims: packageClaims.length,
    packagedAttachments: packageClaims.reduce((sum, c) => sum + c.packagedAttachmentCount, 0),
  };

  writeFileSync(join(outRoot, "package_summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  writeFileSync(join(outRoot, "package_manifest.json"), `${JSON.stringify(packageClaims, null, 2)}\n`, "utf8");

  console.log(`Output: ${outRoot}`);
  console.log(`Ready claims in manifest: ${summary.readyClaimsInManifest}`);
  console.log(`Packaged claims: ${summary.packagedClaims}`);
  console.log(`Packaged attachments: ${summary.packagedAttachments}`);
}

run();
