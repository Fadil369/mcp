import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

function clean(value) {
  return String(value ?? "").trim();
}

function timestampId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function parseArgs(argv) {
  const args = {
    selection: "",
    portalUrl: process.env.NPHIES_PORTAL_URL || "https://portal.nphies.sa",
    submitUrl: process.env.NPHIES_SUBMIT_URL || "",
    artifactsDir: process.env.NPHIES_SUBMIT_ARTIFACTS_DIR || "artifacts/nphies-submit",
    headless: !["0", "false", "no"].includes(String(process.env.NPHIES_HEADLESS || "false").toLowerCase()),
    successRegex: process.env.NPHIES_SUCCESS_REGEX || "success|submitted|تم|نجاح|تم الإرسال|تم ارسال",
    timeoutMs: Math.max(60_000, Number(process.env.NPHIES_SUBMIT_TIMEOUT_MS || 15 * 60_000)),
    betweenClaimsWaitMs: Math.max(0, Number(process.env.NPHIES_BETWEEN_CLAIMS_WAIT_MS || 3000)),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === "--selection" && next) {
      args.selection = next;
      i += 1;
    } else if (key === "--portal-url" && next) {
      args.portalUrl = next;
      i += 1;
    } else if (key === "--submit-url" && next) {
      args.submitUrl = next;
      i += 1;
    } else if (key === "--artifacts-dir" && next) {
      args.artifactsDir = next;
      i += 1;
    } else if (key === "--success-regex" && next) {
      args.successRegex = next;
      i += 1;
    } else if (key === "--timeout-ms" && next) {
      args.timeoutMs = Math.max(60_000, Number.parseInt(next, 10) || args.timeoutMs);
      i += 1;
    } else if (key === "--headless" && next) {
      args.headless = ["1", "true", "yes"].includes(String(next).toLowerCase());
      i += 1;
    }
  }

  if (!args.selection) {
    throw new Error("--selection is required (JSON from scripts/select-go-for-submission.ps1)");
  }
  return args;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function safeScreenshot(page, filePath) {
  try {
    await page.screenshot({ path: filePath, fullPage: true, timeout: 60_000 });
    return true;
  } catch {
    try {
      await page.screenshot({ path: filePath, fullPage: false, timeout: 15_000 });
      return true;
    } catch {
      return false;
    }
  }
}

async function waitForSuccessText(page, regexSource, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const bodyText = await page.locator("body").innerText().catch(() => "");
    try {
      const re = new RegExp(regexSource, "i");
      if (re.test(bodyText)) return true;
    } catch {
      // ignore invalid regex
    }
    await page.waitForTimeout(1000);
  }
  return false;
}

function summarizeClaim(claim) {
  const invoiceNumber = clean(claim.invoiceNumber);
  const mrn = clean(claim.mrn);
  const attachments = Array.isArray(claim?.manifest?.attachments) ? claim.manifest.attachments : [];
  const ready = attachments.filter((a) => a && a.status === "ready" && a.filePath);
  return { invoiceNumber, mrn, ready };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const selectionPath = path.resolve(args.selection);
  const selected = JSON.parse(await fs.readFile(selectionPath, "utf8"));
  const claims = Array.isArray(selected) ? selected : [];
  if (claims.length === 0) {
    throw new Error("Selection file contains 0 claims.");
  }

  const runDir = path.resolve(args.artifactsDir, `run-${timestampId()}`);
  await ensureDir(runDir);

  const browser = await chromium.launch({ headless: args.headless });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const summary = {
    startedAt: new Date().toISOString(),
    selection: selectionPath,
    portalUrl: args.portalUrl,
    submitUrl: args.submitUrl,
    successRegex: args.successRegex,
    artifactsDir: runDir,
    claims: [],
    notes: [
      "This is an assisted flow: you complete the submission manually in the browser window.",
      "The script waits for a success message (regex) on the page, then captures a screenshot per claim.",
    ],
  };

  try {
    console.log(`Artifacts: ${runDir}`);
    console.log(`Opening: ${args.portalUrl}`);
    await page.goto(args.portalUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await safeScreenshot(page, path.join(runDir, "00-open.png"));

    if (args.submitUrl) {
      console.log(`Navigating to submit URL: ${args.submitUrl}`);
      await page.goto(args.submitUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
      await safeScreenshot(page, path.join(runDir, "01-submit-page.png"));
    }

    console.log("");
    console.log("Login if needed, then submit claims one-by-one.");
    console.log(`Success detection regex: /${args.successRegex}/i`);
    console.log("");

    for (let i = 0; i < claims.length; i += 1) {
      const claim = claims[i];
      const { invoiceNumber, mrn, ready } = summarizeClaim(claim);
      const claimDir = path.join(runDir, `${invoiceNumber}_${mrn}`);
      await ensureDir(claimDir);

      console.log("═".repeat(60));
      console.log(`Claim ${i + 1}/${claims.length}: invoice=${invoiceNumber} mrn=${mrn}`);
      console.log("Upload these attachments:");
      for (const att of ready) {
        console.log(`- ${att.requiredType}: ${att.filePath}`);
      }
      console.log("Submit in the browser now. Waiting for success message...");

      const ok = await waitForSuccessText(page, args.successRegex, args.timeoutMs);
      const successShot = path.join(claimDir, `success-${timestampId()}.png`);
      const captured = ok ? await safeScreenshot(page, successShot) : false;

      summary.claims.push({
        invoiceNumber,
        mrn,
        attachmentCount: ready.length,
        detectedSuccessText: ok,
        successScreenshot: captured ? successShot : "",
        url: page.url(),
        finishedAt: new Date().toISOString(),
      });

      if (ok) {
        console.log(`Success detected. Screenshot: ${captured ? successShot : "(failed to capture)"}`);
      } else {
        console.log(`Timed out waiting for success for invoice=${invoiceNumber}.`);
        await safeScreenshot(page, path.join(claimDir, `timeout-${timestampId()}.png`));
      }

      if (args.betweenClaimsWaitMs) {
        await page.waitForTimeout(args.betweenClaimsWaitMs);
      }
    }
  } finally {
    summary.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`nphies-assisted-submit failed: ${error.message}`);
  process.exit(1);
});

