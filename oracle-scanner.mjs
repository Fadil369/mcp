import { chromium } from "playwright";
import dotenv from "dotenv";
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, appendFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Load .env from the current working directory (Windows users often run via different shells).
dotenv.config({ path: resolve(process.cwd(), ".env") });

const execFileAsync = promisify(execFile);

function timestampId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function cssEscapeId(id) {
  return `#${id.replace(/([:.\\])/g, "\\$1")}`;
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return String(value).toLowerCase() === "true";
}

function parseArgs(argv) {
  const args = {
    payload: process.env.NPHIES_PAYLOAD_PATH || "",
    limit: 0,
    artifactsDir: process.env.ORACLE_ARTIFACTS_DIR || "artifacts/oracle-portal",
    maxDocsPerClaim: 0,
    enableMrnCache: true,
    mrnCacheDir: process.env.ORACLE_MRN_CACHE_DIR || "",
    dedupeByMrn: true,
    headless: parseBool(process.env.ORACLE_HEADLESS, true),
    url: process.env.ORACLE_PORTAL_URL || "https://128.1.1.185/prod/faces/Home",
    username: process.env.ORACLE_USERNAME || "",
    password: process.env.ORACLE_PASSWORD || "",
    batchSize: 10,
    screenshots: null, // null = auto (on if not headless)
    resume: false,
    dryRun: false,
    retries: 3,
    skipVisits: false,
    concurrency: 1,
    downloadTimeout: 45000,
    mrnTimeoutMs: Number.parseInt(process.env.ORACLE_MRN_TIMEOUT_MS || "", 10) || 0,
    mrnHeartbeatMs: Number.parseInt(process.env.ORACLE_MRN_HEARTBEAT_MS || "", 10) || 0,
    daemon: false,
    daemonIntervalMs: Number.parseInt(process.env.ORACLE_DAEMON_INTERVAL_MS || "", 10) || 0,
    daemonMaxRuns: 0,
    metrics: parseBool(process.env.ORACLE_METRICS, false),
    metricsIntervalMs: Number.parseInt(process.env.ORACLE_METRICS_INTERVAL_MS || "", 10) || 0,
    metricsExtraPids: [],
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === "--payload" && next) {
      args.payload = next;
      i += 1;
    } else if (key === "--limit" && next) {
      args.limit = Number.parseInt(next, 10) || 0;
      i += 1;
    } else if (key === "--artifacts-dir" && next) {
      args.artifactsDir = next;
      i += 1;
    } else if (key === "--headless" && next) {
      args.headless = parseBool(next, args.headless);
      i += 1;
    } else if (key === "--url" && next) {
      args.url = next;
      i += 1;
    } else if (key === "--max-docs" && next) {
      args.maxDocsPerClaim = Number.parseInt(next, 10) || 0;
      i += 1;
    } else if (key === "--mrn-cache" && next) {
      args.enableMrnCache = parseBool(next, args.enableMrnCache);
      i += 1;
    } else if (key === "--mrn-cache-dir" && next) {
      args.mrnCacheDir = next;
      i += 1;
    } else if (key === "--dedupe-mrn" && next) {
      args.dedupeByMrn = parseBool(next, args.dedupeByMrn);
      i += 1;
    } else if (key === "--batch-size" && next) {
      args.batchSize = Number.parseInt(next, 10) || 10;
      i += 1;
    } else if (key === "--screenshots" && next) {
      args.screenshots = parseBool(next, true);
      i += 1;
    } else if (key === "--resume") {
      args.resume = true;
    } else if (key === "--dry-run") {
      args.dryRun = true;
    } else if (key === "--retries" && next) {
      args.retries = Number.parseInt(next, 10) || 3;
      i += 1;
    } else if (key === "--skip-visits") {
      args.skipVisits = true;
    } else if (key === "--concurrency" && next) {
      args.concurrency = Math.max(1, Number.parseInt(next, 10) || 1);
      i += 1;
    } else if (key === "--mrn-timeout-ms" && next) {
      args.mrnTimeoutMs = Math.max(0, Number.parseInt(next, 10) || 0);
      i += 1;
    } else if (key === "--mrn-heartbeat-ms" && next) {
      args.mrnHeartbeatMs = Math.max(0, Number.parseInt(next, 10) || 0);
      i += 1;
    } else if (key === "--daemon") {
      args.daemon = true;
    } else if (key === "--daemon-interval-ms" && next) {
      args.daemonIntervalMs = Math.max(0, Number.parseInt(next, 10) || 0);
      i += 1;
    } else if (key === "--daemon-max-runs" && next) {
      args.daemonMaxRuns = Math.max(0, Number.parseInt(next, 10) || 0);
      i += 1;
    } else if (key === "--metrics") {
      args.metrics = true;
    } else if (key === "--metrics-interval-ms" && next) {
      args.metricsIntervalMs = Math.max(1000, Number.parseInt(next, 10) || 0);
      i += 1;
    } else if (key === "--metrics-extra-pids" && next) {
      args.metricsExtraPids = String(next)
        .split(",")
        .map((p) => Number.parseInt(p.trim(), 10))
        .filter((p) => Number.isFinite(p) && p > 0);
      i += 1;
    } else if (key === "--help" || key === "-h") {
      args.help = true;
    } else if (key === "--fast") {
      args.skipVisits = true;
      args.downloadTimeout = 12000;
      args.screenshots = false;
    }
  }

  // Auto-resolve screenshots: off in headless mode unless explicitly enabled
  if (args.screenshots === null) {
    args.screenshots = !args.headless;
  }

  // Defaults (0 means "use built-in defaults").
  if (!args.mrnTimeoutMs) args.mrnTimeoutMs = 20 * 60 * 1000;
  if (!args.mrnHeartbeatMs) args.mrnHeartbeatMs = 60 * 1000;
  if (!args.daemonIntervalMs) args.daemonIntervalMs = 5 * 60 * 1000;
  if (!args.metricsIntervalMs) args.metricsIntervalMs = 60 * 1000;

  return args;
}

function printHelp() {
  console.log("oracle-scanner.mjs");
  console.log("");
  console.log("Usage:");
  console.log("  node oracle-scanner.mjs [options]");
  console.log("");
  console.log("Options:");
  console.log("  --payload <path>              Payload JSON path");
  console.log("  --limit <n>                   Limit submissions processed");
  console.log("  --resume                      Resume latest run with checkpoint");
  console.log("  --dry-run                     Validate config/payload only");
  console.log("  --concurrency <n>             Concurrent workers (default 1)");
  console.log("  --fast                        Skip visits, shorter timeouts");
  console.log("  --retries <n>                 Retry attempts (default 3)");
  console.log("  --daemon                      Keep running (loop forever)");
  console.log("  --daemon-interval-ms <ms>     Sleep between runs (default 300000)");
  console.log("  --daemon-max-runs <n>         Stop after N runs (0 = infinite)");
  console.log("  --metrics                     Periodic CPU/memory logging (Windows)");
  console.log("  --metrics-interval-ms <ms>    Metrics interval (default 60000)");
  console.log("  --metrics-extra-pids <csv>    Extra PIDs to log (e.g. 10352,9999)");
  console.log("  --help, -h                    Show help");
  console.log("");
  console.log("Env (.env):");
  console.log("  ORACLE_USERNAME, ORACLE_PASSWORD, ORACLE_PORTAL_URL");
  console.log("  ORACLE_DAEMON_INTERVAL_MS, ORACLE_METRICS, ORACLE_METRICS_INTERVAL_MS");
}

function loadPayload(payloadPath) {
  if (!payloadPath) {
    return [];
  }
  const raw = readFileSync(resolve(payloadPath), "utf8");
  const data = JSON.parse(raw);
  if (Array.isArray(data)) {
    return data;
  }
  if (Array.isArray(data.submissions)) {
    return data.submissions;
  }
  if (Array.isArray(data.patients)) {
    const submissions = [];
    for (const patient of data.patients) {
      const patientDocTypes = Array.isArray(patient.documents)
        ? [...new Set(patient.documents.map((d) => d.documentType).filter(Boolean))]
        : [];
      const patientSubs = Array.isArray(patient.submissions) ? patient.submissions : [];
      for (const sub of patientSubs) {
        const attachmentCount = Number(sub.attachments) || 0;
        const attachmentTypes = patientDocTypes.slice(0, attachmentCount);
        const attachments = attachmentTypes.map((type) => ({
          type,
          fileName: `${sanitizeFileComponent(sub.mrn || patient.mrn)}_${sanitizeFileComponent(type)}.pdf`,
          contentType: "application/pdf",
          description: `Supporting documentation for ${type}`,
        }));
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
    return submissions;
  }
  return [];
}

async function safeScreenshot(page, path, config) {
  if (config && config.screenshots === false) return;
  try {
    await page.screenshot({ path, fullPage: true });
  } catch {
    // Keep processing even if screenshot fails.
  }
}

async function waitForAdfUnblocked(page, timeout = 60000) {
  // Oracle ADF frequently shows a "glass pane" overlay while server requests are in flight.
  // Clicking during that time causes pointer interception failures.
  await page
    .waitForFunction(() => {
      const panes = Array.from(document.querySelectorAll(".AFBlockingGlassPane"));
      const visible = panes.some((p) => {
        const style = window.getComputedStyle(p);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
        const rect = p.getBoundingClientRect();
        return rect.width > 5 && rect.height > 5 && style.pointerEvents !== "none";
      });
      return !visible;
    }, { timeout })
    .catch(() => {});
}

async function dismissBlockingDialogs(page) {
  // Best-effort dismissal of ADF/oasis dialogs. Prefer "Yes/OK" equivalents.
  // This is intentionally tolerant: dialogs can appear in different regions or languages.
  const candidates = [
    { label: "Yes", selector: 'button:has-text("Yes"), a:has-text("Yes")' },
    { label: "OK", selector: 'button:has-text("OK"), a:has-text("OK")' },
    { label: "ArabicYes", selector: 'button:has-text("نعم"), a:has-text("نعم")' },
    { label: "ArabicOk", selector: 'button:has-text("موافق"), a:has-text("موافق")' },
  ];

  // Known ADF dirty-transaction dialog id conventions.
  await page.evaluate(() => {
    const dirty = document.getElementById("pt1:dDirtyTransaction");
    const dirtyText = (dirty?.textContent || "").toLowerCase();
    if (dirty && (dirtyText.includes("unsaved") || dirtyText.includes("تغييرات") || dirtyText.includes("حفظ"))) {
      const yes = document.getElementById("pt1:dDirtyTransaction_yes");
      if (yes) yes.click();
    }
    const oasisYes = document.querySelector('[id$="oasis_message_dialog_yes"]');
    if (oasisYes) oasisYes.click();
    const oasisOk = document.querySelector('[id$="oasis_message_dialog_ok"], [id$="oasis_message_dialog_okBtn"]');
    if (oasisOk) oasisOk.click();
  }).catch(() => {});

  for (const c of candidates) {
    const loc = page.locator(c.selector).first();
    if (await loc.count()) {
      try {
        await waitForAdfUnblocked(page, 15000);
        await loc.click({ timeout: 3000 });
        await page.waitForTimeout(350);
      } catch {
        // Ignore and continue.
      }
    }
  }

  // Escape sometimes closes transient dialogs.
  await page.keyboard.press("Escape").catch(() => {});
  await waitForAdfUnblocked(page, 15000);
}

async function login(page, config, runDir) {
  let hasLoginForm = false;
  let hasHome = false;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.goto(config.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2000);
    hasLoginForm = (await page.locator(cssEscapeId("it1::content")).count()) > 0;
    hasHome = (await page.locator(cssEscapeId("pt1:OasisHedarToolBar:hamburgerBtn")).count()) > 0;
    if (hasLoginForm || hasHome) {
      break;
    }
    await page.waitForTimeout(3000);
  }

  if (!hasLoginForm && !hasHome) {
    throw new Error("Unable to detect Oracle login form or home page.");
  }

  if (hasLoginForm) {
    await page.fill(cssEscapeId("it1::content"), config.username);
    await page.fill(cssEscapeId("it2::content"), config.password);
    await page.click("#login");
    await page.waitForTimeout(2500);
  }

  // Oracle session prompt: "Previous session(s) already found..."
  const sessionYes = page.locator("a:has-text(\"Yes\")").first();
  if (await sessionYes.count()) {
    try {
      await sessionYes.click({ timeout: 5000 });
      await page.waitForTimeout(4000);
    } catch {
      // Some pages render hidden "Yes" controls; ignore click failure.
    }
  }

  await page.waitForTimeout(4000);
  await dismissBlockingDialogs(page);
  await waitForAdfUnblocked(page, 60000);
  await safeScreenshot(page, join(runDir, "01_after_login.png"), config);
  return {
    url: page.url(),
    title: await page.title(),
  };
}

async function openMenuItem(page, menuId, waitMs = 9000) {
  // Some navigations trigger a modal: "You have unsaved changes..."
  // It is often rendered with zero-size nodes, so use DOM click as a fallback.
  async function dismissUnsavedChanges() {
    await page.evaluate(() => {
      const dirty = document.getElementById("pt1:dDirtyTransaction");
      const dirtyText = (dirty?.textContent || "").toLowerCase();
      if (dirty && dirtyText.includes("unsaved")) {
        const yes = document.getElementById("pt1:dDirtyTransaction_yes");
        if (yes) yes.click();
      }

      // Sometimes the confirm dialog is scoped under the current region.
      const oasisYes = document.querySelector('[id$="oasis_message_dialog_yes"]');
      const oasisDialog = document.querySelector('[id$="oasis_message_dialog"]');
      const oasisText = (oasisDialog?.textContent || "").toLowerCase();
      if (oasisYes && (oasisText.includes("unsaved") || oasisText.includes("continue"))) {
        oasisYes.click();
      }
    });
    await page.waitForTimeout(900);
  }

  await dismissUnsavedChanges();
  await dismissBlockingDialogs(page);

  // Open menu and wait for it to actually render items.
  await page.click(cssEscapeId("pt1:OasisHedarToolBar:hamburgerBtn"));
  await page.waitForFunction(() => {
    const el = document.getElementById("pt1:r1:0:os-mainmenu-container");
    if (!el) return false;
    return el.classList.contains("openMainMenu") || el.getBoundingClientRect().width > 50;
  }, { timeout: 30000 });

  const itemSelector = `[id="${menuId}-T"]`;
  await page.waitForSelector(itemSelector, { timeout: 30000 });
  await page.locator(itemSelector).click();
  await page.waitForTimeout(900);
  await dismissUnsavedChanges();
  await dismissBlockingDialogs(page);
  await waitForAdfUnblocked(page, 60000);
  await page.waitForTimeout(waitMs);
}

async function openMenuBySearch(page, query, itemText, waitMs = 9000) {
  await dismissBlockingDialogs(page);
  await page.click(cssEscapeId("pt1:OasisHedarToolBar:hamburgerBtn"));
  await page.waitForFunction(() => {
    const el = document.getElementById("pt1:r1:0:os-mainmenu-container");
    if (!el) return false;
    return el.classList.contains("openMainMenu") || el.getBoundingClientRect().width > 50;
  }, { timeout: 30000 });

  const menu = page.locator(cssEscapeId("pt1:r1:0:os-mainmenu-container"));
  const searchBox = menu
    .locator('input[placeholder*="Search"], input[aria-label*="Search"], input[type="text"]')
    .first();
  if (await searchBox.count()) {
    await searchBox.fill(String(query || ""));
    await page.keyboard.press("Enter");
    await page.waitForTimeout(900);
  }

  // Click the menu item by visible text (English/Arabic). This is more stable than transient tool IDs.
  const candidate = menu.locator(`text=${itemText}`).first();
  await candidate.waitFor({ timeout: 30000 });
  await candidate.click();
  await dismissBlockingDialogs(page);
  await waitForAdfUnblocked(page, 60000);
  await page.waitForTimeout(waitMs);
}

async function openPatientSearch(page) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await openMenuItem(page, "8736", 3000);
      const searchInput = page
        .locator('input[placeholder*="Search IDs"], input[id$=":ff1:fi1:it1::content"]')
        .first();
      await searchInput.waitFor({ timeout: 60000 });
      const id = (await searchInput.getAttribute("id")) || "";
      const regionMatch = id.match(/CntRgn:(\d+):/);
      const regionIndex = regionMatch ? Number.parseInt(regionMatch[1], 10) : null;
      return { searchInput, searchInputId: id, regionIndex };
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(1500);
    }
  }
  throw lastError || new Error("Failed to open Patient Search.");
}

async function openDocumentsPanel(page) {
  await openMenuItem(page, "8903", 5000);
  // IDs vary by ADF region; placeholders are stable.
  await page.locator('input[placeholder="MrNo."]').first().waitFor({ timeout: 60000 });
  await dismissBlockingDialogs(page);
}

function sanitizeFileComponent(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 120);
}

function csvEscape(value) {
  const raw = value === undefined || value === null ? "" : String(value);
  if (/[",\r\n]/.test(raw)) {
    return `"${raw.replaceAll('"', '""')}"`;
  }
  return raw;
}

function writeCsv(path, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    writeFileSync(path, "", "utf8");
    return;
  }
  const headers = Object.keys(rows[0]);
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  }
  writeFileSync(path, lines.join("\n"), "utf8");
}

function parseCsv(text) {
  // Minimal RFC4180-ish parser (enough for our generated CSVs and most simple exports).
  const rows = [];
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.length > 0);
  if (!lines.length) return rows;

  const parseLine = (line) => {
    const out = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i += 1;
          } else {
            inQuotes = false;
          }
        } else {
          cur += ch;
        }
      } else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else if (ch === '"') {
        inQuotes = true;
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out;
  };

  const headers = parseLine(lines[0]).map((h) => h.trim());
  for (let i = 1; i < lines.length; i += 1) {
    const cols = parseLine(lines[i]);
    const row = {};
    for (let c = 0; c < headers.length; c += 1) {
      row[headers[c]] = cols[c] ?? "";
    }
    rows.push(row);
  }
  return rows;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hashFileSha256(path) {
  try {
    const content = readFileSync(path);
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return "";
  }
}

function isPdfBuffer(buffer) {
  if (!buffer || buffer.length < 5) return false;
  return buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46 && buffer[4] === 0x2d; // %PDF-
}

function isPdfFile(path) {
  try {
    const buf = readFileSync(path);
    return isPdfBuffer(buf);
  } catch {
    return false;
  }
}

function formatDdMmYyyy(date) {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = String(date.getFullYear());
  return `${dd}-${mm}-${yyyy}`;
}

async function setLabeledInputValue(page, labelText, value) {
  const labeled = page.getByLabel(labelText).first();
  if (await labeled.count()) {
    await labeled.fill(value);
    return true;
  }

  const byFor = await page.evaluate(({ labelText: lt }) => {
    const labels = Array.from(document.querySelectorAll("label"));
    const label = labels.find((l) => (l.textContent || "").trim() === lt);
    const htmlFor = label?.getAttribute("for") || "";
    return htmlFor;
  }, { labelText });

  if (byFor) {
    const input = page.locator(cssEscapeId(byFor)).first();
    if (await input.count()) {
      await input.fill(value);
      return true;
    }
  }

  return false;
}

async function setDocumentsPanelDateRange(page) {
  // Many users leave narrow defaults (e.g., current month), which hides older claim documents.
  // Try to set a wide range using accessible labels first, then fall back to value-pattern inputs.
  const today = new Date();
  const end = formatDdMmYyyy(today);
  const start = "01-01-2018";

  const startOk = await setLabeledInputValue(page, "Start Date", start);
  const endOk = await setLabeledInputValue(page, "End Date", end);
  if (startOk && endOk) return;

  // Fallback: pick the first two date-ish inputs in the "Search for documents" area.
  // This is heuristic, but better than silently running with a narrow date range.
  const dateInputs = page.locator('input[value*="-"]');
  const count = await dateInputs.count();
  if (count >= 2) {
    await dateInputs.nth(0).fill(start).catch(() => {});
    await dateInputs.nth(1).fill(end).catch(() => {});
  }
}

function attachmentKeywords(type) {
  const t = normalizeText(type);

  // NPHIES frequent attachment types (English + Arabic synonyms/variants).
  // Keep keywords reasonably specific to avoid false positives.
  if (t.includes("laboratory") || t.includes("lab")) {
    return [
      "laboratory result",
      "laboratory results",
      "lab result",
      "lab results",
      "lab report",
      "lab reports",
      "تحاليل",
      "مختبر",
      "مخبر",
      "نتائج التحاليل",
      "نتائج المختبر",
    ];
  }
  if (t.includes("radiology")) {
    return [
      "radiology",
      "radiology report",
      "radiology reports",
      "x ray",
      "xray",
      "ct",
      "mri",
      "ultrasound",
      "sonar",
      "اشعة",
      "أشعة",
      "تقرير أشعة",
      "تقرير اشعة",
      "طبقي",
      "رنين",
      "سونار",
    ];
  }
  if (t.includes("imaging")) {
    return [
      "imaging",
      "imaging study",
      "imaging studies",
      "imaging report",
      "x ray",
      "xray",
      "ct",
      "mri",
      "ultrasound",
      "sonar",
      "تصوير",
      "فحوصات تصوير",
      "اشعة",
      "أشعة",
    ];
  }
  if (t.includes("clinical") && t.includes("note")) {
    return [
      "clinical note",
      "clinical notes",
      "clinic note",
      "physician note",
      "doctor note",
      "soap note",
      "ملاحظات سريرية",
      "ملاحظات الطبيب",
      "ملاحظات",
      "مذكرة",
    ];
  }
  if (t.includes("progress")) {
    return [
      "progress note",
      "progress notes",
      "follow up note",
      "daily note",
      "متابعة",
      "ملاحظات متابعة",
      "تطور الحالة",
      "ملاحظة متابعة",
    ];
  }
  if (t.includes("doctor") && t.includes("assessment")) {
    return ["doctor assessment"]; // handled by matchAttachmentToDoc scoring to reduce false positives
  }
  if (t.includes("assessment")) {
    return ["assessment"]; // handled by matchAttachmentToDoc scoring to reduce false positives
  }
  if (t.includes("medical justification") || t.includes("justification")) {
    return ["medical justification letter"]; // handled by matchAttachmentToDoc scoring to reduce false positives
  }
  if (t.includes("treatment") && t.includes("plan")) {
    return ["treatment plan"]; // handled by matchAttachmentToDoc scoring to reduce false positives
  }
  if (t.includes("prescription")) {
    return ["prescription", "rx", "medication order", "وصفة", "وصفة طبية", "روشتة", "أدوية", "ادوية"];
  }
  if (t.includes("medication justification")) {
    return ["medication justification", "drug justification", "تبرير دواء", "تبرير دوائي", "مبرر الدواء"];
  }
  if (t.includes("procedure")) {
    return ["procedure note", "procedure notes", "intervention note", "إجراء", "مذكرة إجراء", "ملاحظات إجراء"];
  }
  if (t.includes("operative")) {
    return ["operative report", "operation report", "surgery report", "تقرير عملية", "تقرير جراحة", "تقرير عمليات"];
  }

  return t ? [t] : [];
}

function includesAny(text, needles) {
  return needles.some((n) => n && text.includes(normalizeText(n)));
}

function matchAttachmentToDoc(requiredType, docText) {
  const rt = normalizeText(requiredType);
  const text = normalizeText(docText);

  // Scoring-style matching for the most frequently missing, high-risk attachment types.
  // We intentionally require stronger signals here to avoid false positives.
  if (rt.includes("medical justification") || rt.includes("justification")) {
    const hasJustificationSignal = includesAny(text, [
      "justification",
      "clinical justification",
      "medical justification",
      "medical necessity",
      "necessity",
      "prior authorization",
      "pre authorization",
      "pre-authorization",
      "appeal",
      "authorization",
      "تبرير",
      "ضرورة",
      "الضرورة الطبية",
      "موافقة",
      "موافقة مسبقة",
      "طلب موافقة",
    ]);
    const hasLetterSignal = includesAny(text, ["letter", "memo", "statement", "خطاب", "رسالة", "مذكرة", "بيان"]);
    return hasJustificationSignal && hasLetterSignal;
  }

  if (rt.includes("treatment") && rt.includes("plan")) {
    const hasPlan = includesAny(text, ["plan", "care plan", "plan of care", "management plan", "خطة"]);
    const hasTreatment = includesAny(text, [
      "treatment",
      "care",
      "management",
      "follow up",
      "rehab",
      "therapy",
      "علاج",
      "رعاية",
      "متابعة",
      "تدبير",
      "إدارة",
      "ادارة",
      "تأهيل",
      "علاج طبيعي",
    ]);
    return hasPlan && hasTreatment;
  }

  if ((rt.includes("doctor") && rt.includes("assessment")) || rt === "assessment") {
    return includesAny(text, [
      "assessment",
      "clinical assessment",
      "physician assessment",
      "doctor assessment",
      "medical report",
      "physician report",
      "initial assessment",
      "evaluation",
      "consult",
      "consultation",
      "consult note",
      "treating physician",
      "attending physician",
      "تقييم",
      "تقييم الطبيب",
      "تقرير تقييم",
      "تقرير طبي",
      "تقرير الطبيب",
      "استشارة",
      "تقرير استشاري",
      "استشاري",
      "معاينة",
    ]);
  }

  const keys = attachmentKeywords(requiredType);
  if (!keys.length) return false;
  return keys.some((k) => k && text.includes(normalizeText(k)));
}

function getClaimRequiredTypes(submission) {
  const required = Array.isArray(submission.attachments)
    ? submission.attachments.map((item) => item.type || item.fileName || "Unknown")
    : [];
  // Preserve order but remove empty/duplicates.
  const out = [];
  const seen = new Set();
  for (const t of required) {
    const key = String(t || "").trim();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function mrnCachePathForType(config, mrn, requiredType) {
  if (!config.enableMrnCache) return "";
  const root = config.mrnCacheDir ? resolve(config.mrnCacheDir) : "";
  if (!root) return "";
  return join(root, sanitizeFileComponent(mrn), `${sanitizeFileComponent(requiredType)}.pdf`);
}

function evaluateAttachmentAudit(config, mrn, requiredTypes, retrievedDocs) {
  const required = Array.isArray(requiredTypes) ? requiredTypes : [];
  const retrieved = Array.isArray(retrievedDocs) ? retrievedDocs : [];

  const matched = new Set();
  const usedDocs = new Set();
  for (const req of required) {
    const cachePath = mrnCachePathForType(config, mrn, req);
    const hasCached = cachePath && existsSync(cachePath) && isPdfFile(cachePath);
    if (hasCached) {
      matched.add(req);
      continue;
    }
    for (let di = 0; di < retrieved.length; di++) {
      const doc = retrieved[di];
      const explicitMatch = doc.matchedRequiredType && doc.matchedRequiredType === req;
      const textMatch = matchAttachmentToDoc(req, doc.rowText || doc.fileName || "");
      if (doc.filePath && (explicitMatch || textMatch)) {
        matched.add(req);
        usedDocs.add(di);
        break;
      }
    }
  }

  // Greedy assignment: assign remaining docs to unmatched required types positionally.
  // Oracle often labels documents generically ("Medical Report") so text matching fails.
  const unmatched = required.filter((r) => !matched.has(r));
  const unusedDocs = retrieved.filter((_, i) => !usedDocs.has(i) && retrieved[i].filePath);
  for (let i = 0; i < Math.min(unmatched.length, unusedDocs.length); i++) {
    const req = unmatched[i];
    const doc = unusedDocs[i];
    doc.matchedRequiredType = req;
    doc._greedyAssigned = true;
    matched.add(req);
    // Copy to MRN cache under the assigned type
    if (config.enableMrnCache && doc.filePath) {
      const cachePath = mrnCachePathForType(config, mrn, req);
      if (cachePath && !existsSync(cachePath)) {
        try { copyFileSync(doc.filePath, cachePath); } catch { /* ignore */ }
      }
    }
  }

  const audit = required.map((type) => {
    const matchedDoc = retrieved.find(
      (doc) =>
        doc.filePath
        && ((doc.matchedRequiredType && doc.matchedRequiredType === type)
          || matchAttachmentToDoc(type, doc.rowText || doc.fileName || "")),
    );
    const cachePath = mrnCachePathForType(config, mrn, type);
    const hasCached = cachePath && existsSync(cachePath) && isPdfFile(cachePath);
    return {
      type,
      status: matchedDoc ? "matched" : hasCached ? "matched" : "missing",
      filePath: matchedDoc?.filePath || (hasCached ? cachePath : ""),
      fileName: matchedDoc?.fileName || (hasCached ? `${sanitizeFileComponent(type)}.pdf` : ""),
      method: matchedDoc?.method || (hasCached ? "mrn-cache" : ""),
    };
  });

  return {
    matchedCount: matched.size,
    requiredCount: required.length,
    nphiesReady: matched.size === required.length,
    attachmentAudit: audit,
  };
}

async function detectDocumentTypeFromDetails(page) {
  try {
    const docType = await page.evaluate(() => {
      const text = (document.body?.innerText || "").replace(/\u00a0/g, " ");
      const match = text.match(/Document Type\s+([^\r\n]+)/i);
      return match ? match[1].trim() : "";
    });
    return docType || "";
  } catch {
    return "";
  }
}

async function tryDownloadFromViewer(page, outPath) {
  // Best-effort: if the "View/Edit" action opens an iframe/embed with a direct URL, fetch it with the same session.
  try {
    const src = await page.evaluate(() => {
      const embed = document.querySelector('embed[type="application/pdf"]');
      if (embed && embed.getAttribute("src")) return embed.getAttribute("src");
      const iframe = document.querySelector("iframe");
      if (iframe && iframe.getAttribute("src")) return iframe.getAttribute("src");
      const obj = document.querySelector("object");
      if (obj && obj.getAttribute("data")) return obj.getAttribute("data");
      return "";
    });
    if (!src || src.startsWith("blob:") || src.startsWith("about:")) {
      return { ok: false, note: "No fetchable PDF src found." };
    }
    const url = new URL(src, page.url()).toString();
    const response = await page.request.get(url);
    if (!response.ok()) {
      return { ok: false, note: `PDF fetch failed (${response.status()}).` };
    }
    const contentType = (response.headers()["content-type"] || "").toLowerCase();
    const body = await response.body();
    if (!contentType.includes("pdf") && !isPdfBuffer(body)) {
      return { ok: false, note: `Viewer src fetch did not return PDF (content-type=${contentType || "unknown"}).` };
    }
    writeFileSync(outPath, body);
    return { ok: true, note: "Saved via viewer src fetch." };
  } catch (error) {
    return { ok: false, note: `Viewer fetch error: ${error.message}` };
  }
}

async function downloadFromDocDetails(page, downloadsDir, baseName) {
  await waitForAdfUnblocked(page, 60000);
  const preview = page.locator('button:has-text("Preview"), a:has-text("Preview")').first();
  const printBtn = page.locator('button:has-text("Print"), a:has-text("Print")').first();
  if ((await preview.count()) === 0 && (await printBtn.count()) === 0) {
    return { ok: false, filePath: "", note: "Preview/Print button not found on Document Details." };
  }

  const attemptClick = async (btn) => {
    const downloadPromise = page.waitForEvent("download", { timeout: 60000 }).catch(() => null);
    const popupPromise = page.waitForEvent("popup", { timeout: 60000 }).catch(() => null);
    await waitForAdfUnblocked(page, 60000);
    try {
      await btn.click({ timeout: 30000 });
    } catch {
      await btn.evaluate((el) => el.click()).catch(() => {});
    }
    await page.waitForTimeout(1200);
    const popup = await popupPromise;
    let download = await downloadPromise;

    if (!download && popup) {
      await popup.waitForLoadState("domcontentloaded").catch(() => {});
      download = await popup.waitForEvent("download", { timeout: 60000 }).catch(() => null);
    }

    if (download) {
      const suggested = sanitizeFileComponent(download.suggestedFilename() || `${baseName}.pdf`);
      const outPath = join(downloadsDir, suggested);
      await download.saveAs(outPath);
      if (popup) await popup.close().catch(() => {});
      if (isPdfFile(outPath)) {
        return { ok: true, filePath: outPath, note: "Saved via download event." };
      }
      return { ok: false, filePath: "", note: "Download event produced a non-PDF file." };
    }

    // No direct download; try to save from popup/page viewer.
    const outPath = join(downloadsDir, `${baseName}.pdf`);
    if (popup) {
      // If the popup is already a PDF URL, fetch it directly.
      const u = popup.url();
      if (u && /^https?:/i.test(u)) {
        const resp = await popup.request.get(u).catch(() => null);
        if (resp && resp.ok()) {
          const contentType = (resp.headers()["content-type"] || "").toLowerCase();
          const body = await resp.body();
          if (contentType.includes("pdf") || isPdfBuffer(body)) {
            writeFileSync(outPath, body);
            await popup.close().catch(() => {});
            return { ok: true, filePath: outPath, note: "Saved via popup URL fetch." };
          }
        }
      }

      const viewer = await tryDownloadFromViewer(popup, outPath);
      await popup.close().catch(() => {});
      if (viewer.ok) return { ok: true, filePath: outPath, note: viewer.note };
      return { ok: false, filePath: "", note: viewer.note };
    }

    const viewer = await tryDownloadFromViewer(page, outPath);
    if (viewer.ok) return { ok: true, filePath: outPath, note: viewer.note };
    return { ok: false, filePath: "", note: viewer.note };
  };

  if ((await preview.count()) > 0) {
    const res = await attemptClick(preview);
    if (res.ok) return res;
  }
  if ((await printBtn.count()) > 0) {
    const res = await attemptClick(printBtn);
    if (res.ok) return res;
    return res;
  }

  return { ok: false, filePath: "", note: "Preview/Print attempts did not yield a downloadable file." };
}

async function saveDocDetailsAsPdf(page, outPath) {
  // Fallback: generate a PDF from the rendered Document Details page.
  // This is often the only deterministic way when the portal does not expose a direct PDF download.
  await waitForAdfUnblocked(page, 60000);

  const expandAll = page.locator('button:has-text("Expand All"), a:has-text("Expand All")').first();
  if (await expandAll.count()) {
    try {
      await expandAll.click({ timeout: 15000 });
    } catch {
      await expandAll.evaluate((el) => el.click()).catch(() => {});
    }
    await waitForAdfUnblocked(page, 60000);
    await page.waitForTimeout(1200);
  }

  // Chromium-only; requires headless.
  await page.pdf({
    path: outPath,
    format: "A4",
    printBackground: true,
    preferCSSPageSize: true,
    margin: { top: "12mm", bottom: "12mm", left: "10mm", right: "10mm" },
  });
}

async function retrieveDocumentsFromPanel(page, claimResult, runDir, config) {
  const mrn = claimResult.mrn;
  const invoice = claimResult.invoiceNumber || "unknown";
  const patientId = claimResult.oraclePatient?.patientId || claimResult.payloadPatientId || "";
  const requiredAll = Array.isArray(claimResult.requiredAttachments) ? claimResult.requiredAttachments : [];

  if (requiredAll.length === 0) {
    claimResult.documentsRetrieved = [];
    claimResult.attachmentAudit = [];
    claimResult.nphiesReady = true;
    claimResult.notes.push("No required attachments declared in payload; skipped Documents Panel download.");
    return;
  }

  const downloadsDir = join(runDir, "downloads", `${sanitizeFileComponent(invoice)}_${sanitizeFileComponent(mrn)}`);
  mkdirSync(downloadsDir, { recursive: true });
  if (config.enableMrnCache) {
    mkdirSync(resolve(config.mrnCacheDir), { recursive: true });
    mkdirSync(join(resolve(config.mrnCacheDir), sanitizeFileComponent(mrn)), { recursive: true });
  }

  const mrnInput = page.locator('input[placeholder="MrNo."]').first();
  const pidInput = page.locator('input[placeholder="Patient ID"]').first();

  // Fill MRN and search — keep it simple, same approach that worked before
  await waitForAdfUnblocked(page, 60000);
  await mrnInput.fill(mrn || "");
  if (await pidInput.count()) {
    await pidInput.fill(patientId || "");
  }
  await page.keyboard.press("Enter");
  await waitForAdfUnblocked(page, 60000);
  await page.waitForTimeout(1500);

  // If no results, try setting a wider date range and searching again
  const dbFirst = page.locator('div[id$="ddt_t1::db"]').first();
  const firstText = (await dbFirst.count()) ? await dbFirst.innerText().catch(() => "") : "";
  if (!firstText || /No data to display/i.test(firstText) || !firstText.includes(String(mrn))) {
    await setDocumentsPanelDateRange(page);
    await mrnInput.fill(mrn || "");
    if (await pidInput.count()) await pidInput.fill("");
    await page.keyboard.press("Enter");
    await waitForAdfUnblocked(page, 60000);
    await page.waitForTimeout(1500);
  }

  const db = page.locator('div[id$="ddt_t1::db"]').first();
  if ((await db.count()) === 0) {
    claimResult.notes.push("Documents Panel table not found for download.");
    return;
  }
  const dbText = await db.innerText().catch(() => "");
  if (!dbText || /No data to display/i.test(dbText)) {
    claimResult.notes.push("Documents Panel shows no documents to display.");
    return;
  }

  // Prefer the real ADF action button id (ends with ":obt1:b5"). The visible label may be on an inner <a>.
  let viewButtons = db.locator('[id*="ddt_t1:"][id$=":obt1:b5"]');
  if ((await viewButtons.count()) === 0) {
    viewButtons = db.locator('[id$=":b5"]:has-text("View / Edit")');
  }
  const rowCount = await viewButtons.count();
  const rowEntries = [];
  for (let i = 0; i < rowCount; i += 1) {
    const rowText = await viewButtons.nth(i).evaluate((el) => {
      const tr = el.closest("tr");
      if (tr) return tr.innerText || "";
      const parent = el.parentElement;
      return parent ? parent.innerText || "" : "";
    }).catch(() => "");
    rowEntries.push({ index: i, rowText });
  }

  const mrnRows = rowEntries.filter((row) => row.rowText && row.rowText.includes(String(mrn)));
  if (!mrnRows.length) {
    claimResult.notes.push(`No document rows matched MRN ${mrn}. Found ${rowEntries.length} rows for other patients. Skipping to avoid wrong-patient downloads.`);
    claimResult.documentsRetrieved = [];
    const evald = evaluateAttachmentAudit(config, mrn, requiredAll, []);
    claimResult.attachmentAudit = evald.attachmentAudit;
    claimResult.nphiesReady = evald.nphiesReady;
    return;
  }
  const scopedRows = mrnRows;
  const enforceMrnMatch = true;

  // Only attempt to fetch types that are not already satisfied by the MRN cache.
  const requiredToFetch = requiredAll.filter((type) => {
    const cachePath = mrnCachePathForType(config, mrn, type);
    return !(cachePath && existsSync(cachePath) && isPdfFile(cachePath));
  });
  if (config.enableMrnCache && requiredAll.length && requiredToFetch.length === 0) {
    const evald = evaluateAttachmentAudit(config, mrn, requiredAll, []);
    claimResult.documentsRetrieved = [];
    claimResult.attachmentAudit = evald.attachmentAudit;
    claimResult.nphiesReady = evald.nphiesReady;
    claimResult.notes.push("All required attachments already present in MRN cache; skipped Documents Panel download.");
    return;
  }

  const orderedIndices = [];
  const addIndex = (idx) => {
    if (!orderedIndices.includes(idx)) orderedIndices.push(idx);
  };

  // Prioritize rows that match required attachment types.
  for (const req of requiredToFetch) {
    const hit = scopedRows.find((row) => matchAttachmentToDoc(req, row.rowText));
    if (hit) addIndex(hit.index);
  }
  // Then add other rows that still look relevant to required types.
  for (const row of scopedRows) {
    if (requiredToFetch.some((req) => matchAttachmentToDoc(req, row.rowText))) {
      addIndex(row.index);
    }
  }
  // Finally, add remaining scoped rows to keep best-effort behavior.
  for (const row of scopedRows) {
    addIndex(row.index);
  }

  const targetMax = config.maxDocsPerClaim > 0
    ? Math.min(orderedIndices.length, config.maxDocsPerClaim)
    : Math.min(orderedIndices.length, requiredToFetch.length ? Math.max(requiredToFetch.length * 4, 16) : 16);
  const toTryIndices = orderedIndices.slice(0, targetMax);

  const retrieved = [];
  const matchedRequiredFromRows = new Set();

  for (let attemptIndex = 0; attemptIndex < toTryIndices.length; attemptIndex += 1) {
    if (requiredToFetch.length > 0 && matchedRequiredFromRows.size >= requiredToFetch.length) {
      break;
    }
    const rowIndex = toTryIndices[attemptIndex];
    const viewBtn = viewButtons.nth(rowIndex);
    const rowText = rowEntries.find((row) => row.index === rowIndex)?.rowText || "";

    if (enforceMrnMatch && rowText && !rowText.includes(String(mrn))) {
      claimResult.notes.push(`Skipped row ${rowIndex + 1}: MRN did not match (${mrn}).`);
      continue;
    }
    let rowMatchedRequiredType = requiredToFetch.find(
      (req) => !matchedRequiredFromRows.has(req) && matchAttachmentToDoc(req, rowText),
    ) || "";

    const dlTimeout = config.downloadTimeout || 45000;
    const downloadPromise = page.waitForEvent("download", { timeout: dlTimeout }).catch(() => null);
    const popupPromise = page.waitForEvent("popup", { timeout: dlTimeout }).catch(() => null);

    await waitForAdfUnblocked(page, 60000);
    await viewBtn.scrollIntoViewIfNeeded().catch(() => {});
    try {
      await viewBtn.click({ timeout: 30000 });
    } catch {
      // Bypass pointer interception; still may fail if ADF is busy, but is often good enough.
      await viewBtn.evaluate((el) => el.click()).catch(() => {});
    }
    await page.waitForTimeout(1500);

    const popup = await popupPromise;
    let download = await downloadPromise;

    if (!download && popup) {
      await popup.waitForLoadState("domcontentloaded").catch(() => {});
      download = await popup.waitForEvent("download", { timeout: dlTimeout }).catch(() => null);
    }

    const baseName = `${sanitizeFileComponent(mrn)}_${sanitizeFileComponent(invoice)}_doc_${String(attemptIndex + 1).padStart(2, "0")}`;

    if (download) {
      const suggested = sanitizeFileComponent(download.suggestedFilename() || `${baseName}.bin`);
      const outPath = join(downloadsDir, suggested);
      await download.saveAs(outPath);
      if (!isPdfFile(outPath)) {
        retrieved.push({
          rowIndex,
          rowText: rowText.slice(0, 1200),
          filePath: "",
          fileName: "",
          method: "manual",
          note: "Download produced a non-PDF file.",
          matchedRequiredType: rowMatchedRequiredType,
        });
        if (popup) {
          await popup.close().catch(() => {});
        }
      } else {
        retrieved.push({
          rowIndex,
          rowText: rowText.slice(0, 1200),
          filePath: outPath,
          fileName: suggested,
          method: "download",
          matchedRequiredType: rowMatchedRequiredType,
        });
        if (config.enableMrnCache && rowMatchedRequiredType) {
          const cachePath = mrnCachePathForType(config, mrn, rowMatchedRequiredType);
          if (!existsSync(cachePath)) {
            copyFileSync(outPath, cachePath);
          }
        }
        if (rowMatchedRequiredType) {
          matchedRequiredFromRows.add(rowMatchedRequiredType);
        }
        if (popup) {
          await popup.close().catch(() => {});
        }
      }
    } else {
      // If click navigated within the same tab, use Preview/Print to get a PDF.
      if (!popup) {
        await page
          .locator('text=Document Details, h1:has-text("Document Details"), div:has-text("Document Details")')
          .first()
          .waitFor({ timeout: dlTimeout })
          .catch(() => {});

        if (!rowMatchedRequiredType) {
          const docType = await detectDocumentTypeFromDetails(page);
          const detected = requiredToFetch.find(
            (req) => !matchedRequiredFromRows.has(req) && matchAttachmentToDoc(req, docType),
          );
          if (detected) {
            rowMatchedRequiredType = detected;
          }
        }

        let saved = null;
        const dl = await downloadFromDocDetails(page, downloadsDir, baseName);
        if (dl.ok) {
          saved = {
            filePath: dl.filePath,
            fileName: sanitizeFileComponent(dl.filePath.split(/[\\/]/).pop() || `${baseName}.pdf`),
            method: "details-preview",
            note: dl.note,
            matchedRequiredType: rowMatchedRequiredType,
          };
        } else {
          // Last resort: print the HTML details page to PDF.
          const pdfPath = join(downloadsDir, `${baseName}_details.pdf`);
          try {
            await saveDocDetailsAsPdf(page, pdfPath);
            saved = {
              filePath: pdfPath,
              fileName: `${baseName}_details.pdf`,
              method: "page-pdf",
              note: "Saved via Playwright page.pdf fallback.",
              matchedRequiredType: rowMatchedRequiredType,
            };
          } catch (error) {
            saved = {
              filePath: "",
              fileName: "",
              method: "manual",
              note: `${dl.note} | page.pdf fallback failed: ${error.message}`,
              matchedRequiredType: rowMatchedRequiredType,
            };
          }
        }
        if (saved.filePath && rowMatchedRequiredType) {
          matchedRequiredFromRows.add(rowMatchedRequiredType);
        }

        retrieved.push({
          rowIndex,
          rowText: rowText.slice(0, 1200),
          ...saved,
        });
        if (config.enableMrnCache && saved.filePath && rowMatchedRequiredType) {
          const cachePath = mrnCachePathForType(config, mrn, rowMatchedRequiredType);
          if (!existsSync(cachePath)) {
            copyFileSync(saved.filePath, cachePath);
          }
        }
      } else {
        // If a popup opened, try to save from popup viewer.
        const fallbackPath = join(downloadsDir, `${baseName}.pdf`);
        if (!rowMatchedRequiredType) {
          const popupDocType = await detectDocumentTypeFromDetails(popup);
          const detected = requiredToFetch.find(
            (req) => !matchedRequiredFromRows.has(req) && matchAttachmentToDoc(req, popupDocType),
          );
          if (detected) {
            rowMatchedRequiredType = detected;
          }
        }
        let viewerSaved = await tryDownloadFromViewer(popup, fallbackPath);
        await popup.close().catch(() => {});
        if (viewerSaved.ok) {
          retrieved.push({
            rowIndex,
            rowText: rowText.slice(0, 1200),
            filePath: fallbackPath,
            fileName: `${baseName}.pdf`,
            method: "viewer-fetch",
            note: viewerSaved.note,
            matchedRequiredType: rowMatchedRequiredType,
          });
          if (config.enableMrnCache && rowMatchedRequiredType) {
            const cachePath = mrnCachePathForType(config, mrn, rowMatchedRequiredType);
            if (!existsSync(cachePath)) {
              copyFileSync(fallbackPath, cachePath);
            }
          }
          if (rowMatchedRequiredType) {
            matchedRequiredFromRows.add(rowMatchedRequiredType);
          }
        } else {
          retrieved.push({
            rowIndex,
            rowText: rowText.slice(0, 1200),
            filePath: "",
            fileName: "",
            method: "manual",
            note: viewerSaved.note,
            matchedRequiredType: rowMatchedRequiredType,
          });
        }
      }
    }

    // Always return to Documents Panel list for next row.
    const back = page.locator('button:has-text("Back"), a:has-text("Back")').first();
    if (await back.count()) {
      await waitForAdfUnblocked(page, 60000);
      try {
        await back.click({ timeout: 30000 });
      } catch {
        await back.evaluate((el) => el.click()).catch(() => {});
      }
      await waitForAdfUnblocked(page, 60000);
      await db.waitFor({ timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(1200);
    }
  }

  claimResult.documentsRetrieved = retrieved;

  const evald = evaluateAttachmentAudit(config, mrn, requiredAll, retrieved);
  claimResult.attachmentAudit = evald.attachmentAudit;
  claimResult.nphiesReady = requiredAll.length === 0 ? true : evald.nphiesReady;
  if (!claimResult.nphiesReady) {
    claimResult.notes.push(
      `Some required attachments were not confidently matched. Matched ${evald.matchedCount}/${evald.requiredCount}.`,
    );
    const missingTypes = (claimResult.attachmentAudit || [])
      .filter((item) => item.status !== "matched")
      .map((item) => item.type);
    const needsAltModule = missingTypes.some((t) => /(lab|laboratory|radiology|imaging)/i.test(String(t)));
    if (needsAltModule) {
      claimResult.notes.push("Missing lab/radiology/imaging types may require retrieval via specialized Oracle modules.");
    }
  }
}

async function tryDocsPanelLookup(page, mrn, patientId) {
  const result = { attempted: true, hasData: false, preview: "", notes: [] };

  const mrnInput = page.locator('input[placeholder="MrNo."]').first();
  const pidInput = page.locator('input[placeholder="Patient ID"]').first();
  const db = page.locator('div[id$="ddt_t1::db"]').first();

  const strategies = [
    { mrn, patientId: "" },
    { mrn: "", patientId },
    { mrn, patientId },
  ];

  for (let s = 0; s < strategies.length; s += 1) {
    const strat = strategies[s];
    await mrnInput.fill(strat.mrn || "");
    if (await pidInput.count()) {
      await pidInput.fill(strat.patientId || "");
    }
    await page.keyboard.press("Enter");
    await page.waitForTimeout(3000);
    await waitForAdfUnblocked(page, 30000);

    if ((await db.count()) === 0) {
      result.notes.push("Documents table not found.");
      continue;
    }
    const text = await db.innerText().catch(() => "");
    if (!text || /No data to display/i.test(text)) {
      result.notes.push(`No docs for strategy ${s + 1}.`);
      continue;
    }

    result.hasData = true;
    result.preview = text.slice(0, 2500);
    return result;
  }

  return result;
}

function extractPatientSummary(tableText) {
  const lines = tableText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const firstLine = lines.length ? lines[0] : "";
  const patientId = (tableText.match(/Patient ID\s*([0-9]+)/i) || [])[1] || "";
  const lastVisitDate = (tableText.match(/Last Visit Date\s*([0-9-]+)/i) || [])[1] || "";
  const mrn = (tableText.match(/MRN\s*([0-9]+)/i) || [])[1] || "";
  return {
    displayName: firstLine,
    patientId,
    lastVisitDate,
    mrn,
  };
}

async function extractVisits(page) {
  const tableDb = page
    .locator('div[id*="PatientAttendanceTab"][id$="::db"], div[id$="PatientAttendanceTab::db"]')
    .first();
  const visitsText = (await tableDb.count()) ? await tableDb.innerText().catch(() => "") : "";

  return {
    preview: visitsText.slice(0, 1800),
  };
}

async function processSubmission(page, submission, runDir, index, config) {
  const invoiceNumber = String(submission.invoiceNumber ?? "");
  const mrn = String(submission.mrn ?? "");
  const requiredAttachments = getClaimRequiredTypes(submission);

  const claimResult = {
    invoiceNumber,
    mrn,
    payloadPatientId: String(submission.patientId ?? ""),
    payloadPatientName: String(submission.patientName ?? ""),
    payloadAttachmentCount: requiredAttachments.length,
    requiredAttachments,
    oracleFound: false,
    oraclePatient: {},
    visits: {},
    documentsRetrieved: [],
    nphiesReady: false,
    notes: [],
  };

  if (!mrn) {
    claimResult.notes.push("Skipped: MRN missing in payload.");
    return claimResult;
  }

  if (config._logAction) {
    config._logAction(`claim.start invoice=${invoiceNumber} mrn=${mrn}`);
  }

  const patientSearch = await openPatientSearch(page);

  await patientSearch.searchInput.fill(mrn);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(9000);
  await safeScreenshot(page, join(runDir, `claim_${index + 1}_${mrn}_patient_search.png`), config);

  const regionIndex = patientSearch.regionIndex;
  const patientTableLocator = regionIndex !== null
    ? page.locator(cssEscapeId(`pt1:contrRg:0:CntRgn:${regionIndex}:pt1:TableB`))
    : page.locator('[id$=":pt1:TableB"], [id$=":TableB"]').first();

  const hasTable = await patientTableLocator.count();
  if (!hasTable) {
    claimResult.notes.push("Patient table not available after MRN search.");
    return claimResult;
  }

  const tableText = await patientTableLocator.innerText();
  if (/No data to display/i.test(tableText)) {
    claimResult.notes.push("No patient row found for MRN in Oracle.");
    return claimResult;
  }

  claimResult.oracleFound = true;
  claimResult.oraclePatient = extractPatientSummary(tableText);

  const patientVisitsButtonSelector = regionIndex !== null
    ? cssEscapeId(`pt1:contrRg:0:CntRgn:${regionIndex}:pt1:TableB:0:ot7:obt5:b1`)
    : '[id$=":TableB:0:ot7:obt5:b1"]';
  const patientVisitsButton = page.locator(patientVisitsButtonSelector).first();
  if (await patientVisitsButton.count()) {
    await patientVisitsButton.click();
    await page.waitForTimeout(9000);
    claimResult.visits = await extractVisits(page);
    await safeScreenshot(page, join(runDir, `claim_${index + 1}_${mrn}_patient_visits.png`), config);
  } else {
    claimResult.notes.push("Patient Visits button not found.");
  }

  try {
    await openDocumentsPanel(page);
    claimResult.documentsPanel = await tryDocsPanelLookup(
      page,
      mrn,
      claimResult.oraclePatient.patientId || claimResult.payloadPatientId,
    );
    await safeScreenshot(page, join(runDir, `claim_${index + 1}_${mrn}_documents_panel.png`), config);
    try {
      await retrieveDocumentsFromPanel(page, claimResult, runDir, config);
      await safeScreenshot(page, join(runDir, `claim_${index + 1}_${mrn}_documents_downloads.png`), config);
    } catch (error) {
      claimResult.notes.push(`Documents retrieval failed: ${error.message}`);
      await safeScreenshot(page, join(runDir, `claim_${index + 1}_${mrn}_documents_downloads_failed.png`), config);
    }
  } catch (error) {
    claimResult.notes.push(`Documents Panel lookup failed: ${error.message}`);
  }

  if (claimResult.requiredAttachments.length === 0) {
    claimResult.nphiesReady = true;
  }
  if (config._logAction) {
    config._logAction(
      `claim.end invoice=${invoiceNumber} mrn=${mrn} oracleFound=${claimResult.oracleFound} nphiesReady=${claimResult.nphiesReady}`,
    );
  }
  return claimResult;
}

async function processMrnOnce(page, mrn, representative, runDir, groupIndex, requiredUnion, config) {
  const invoiceHint = String(representative?.invoiceNumber ?? "") || "MRN_GROUP";
  const patientIdHint = String(representative?.patientId ?? "");
  const requiredAttachments = Array.isArray(requiredUnion) ? requiredUnion : [];

  const mrnResult = {
    invoiceNumber: invoiceHint,
    mrn,
    payloadPatientId: patientIdHint,
    payloadPatientName: String(representative?.patientName ?? ""),
    payloadAttachmentCount: requiredAttachments.length,
    requiredAttachments,
    oracleFound: false,
    oraclePatient: {},
    visits: {},
    documentsRetrieved: [],
    documentsPanel: {},
    nphiesReady: false,
    notes: [],
  };

  if (!mrn) {
    mrnResult.notes.push("Skipped: MRN missing in payload.");
    return mrnResult;
  }

  const logAction = typeof config._logAction === "function" ? config._logAction : null;
  const startedAt = Date.now();
  let currentStep = "start";
  let heartbeatId = null;

  const logStep = (step) => {
    currentStep = step;
    if (logAction) logAction(`mrn.step mrn=${mrn} step=${step}`);
  };

  if (logAction) {
    logAction(`mrn.start mrn=${mrn}`);
    const heartbeatMs = Number(config.mrnHeartbeatMs || 60000);
    heartbeatId = setInterval(() => {
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      logAction(`mrn.heartbeat mrn=${mrn} step=${currentStep} elapsedSec=${elapsedSec}`);
    }, heartbeatMs);
    heartbeatId.unref?.();
  }

  try {
    logStep("patient_search");
    const patientSearch = await openPatientSearch(page);

    await patientSearch.searchInput.fill(mrn);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(3000);
    await waitForAdfUnblocked(page, 30000);
    logStep("patient_found");
    await safeScreenshot(page, join(runDir, `mrn_${groupIndex + 1}_${mrn}_patient_search.png`), config);

    const regionIndex = patientSearch.regionIndex;
    const patientTableLocator = regionIndex !== null
      ? page.locator(cssEscapeId(`pt1:contrRg:0:CntRgn:${regionIndex}:pt1:TableB`))
      : page.locator('[id$=":pt1:TableB"], [id$=":TableB"]').first();

    const hasTable = await patientTableLocator.count();
    if (!hasTable) {
      mrnResult.notes.push("Patient table not available after MRN search.");
      return mrnResult;
    }

    logStep("patient_table");
    const tableText = await patientTableLocator.innerText();
    if (/No data to display/i.test(tableText)) {
      mrnResult.notes.push("No patient row found for MRN in Oracle.");
      return mrnResult;
    }

    mrnResult.oracleFound = true;
    mrnResult.oraclePatient = extractPatientSummary(tableText);

    // Skip visits extraction in fast/skip-visits mode (saves ~18s per MRN)
    if (!config.skipVisits) {
      logStep("visits");
      const patientVisitsButtonSelector = regionIndex !== null
        ? cssEscapeId(`pt1:contrRg:0:CntRgn:${regionIndex}:pt1:TableB:0:ot7:obt5:b1`)
        : '[id$=":TableB:0:ot7:obt5:b1"]';
      const patientVisitsButton = page.locator(patientVisitsButtonSelector).first();
      if (await patientVisitsButton.count()) {
        await patientVisitsButton.click();
        await page.waitForTimeout(3000);
        await waitForAdfUnblocked(page, 30000);
        mrnResult.visits = await extractVisits(page);
        await safeScreenshot(page, join(runDir, `mrn_${groupIndex + 1}_${mrn}_patient_visits.png`), config);
      } else {
        mrnResult.notes.push("Patient Visits button not found.");
      }
    }

    try {
      logStep("open_docs_panel");
      await openDocumentsPanel(page);
      await safeScreenshot(page, join(runDir, `mrn_${groupIndex + 1}_${mrn}_documents_panel.png`), config);
      try {
        logStep("retrieve_docs");
        await retrieveDocumentsFromPanel(page, mrnResult, runDir, config);
        logStep(`docs_done count=${(mrnResult.documentsRetrieved || []).length}`);
        await safeScreenshot(page, join(runDir, `mrn_${groupIndex + 1}_${mrn}_documents_downloads.png`), config);
      } catch (error) {
        mrnResult.notes.push(`Documents retrieval failed: ${error.message}`);
        await safeScreenshot(page, join(runDir, `mrn_${groupIndex + 1}_${mrn}_documents_downloads_failed.png`), config);
      }
    } catch (error) {
      mrnResult.notes.push(`Documents Panel lookup failed: ${error.message}`);
    }

    return mrnResult;
  } finally {
    if (heartbeatId) clearInterval(heartbeatId);
    if (logAction) {
      logAction(`mrn.end mrn=${mrn} oracleFound=${mrnResult.oracleFound} nphiesReady=${mrnResult.nphiesReady}`);
    }
  }
}

async function checkLabReportModule(page, runDir, config) {
  try {
    await openMenuItem(page, "8970", 9000);
    const expandPatientFullReport = cssEscapeId(
      "pt1:contrRg:0:CntRgn:2:or1:oc3:oc8:r2:0:cnt:sdh1::_afrDscl",
    );
    if (await page.locator(expandPatientFullReport).count()) {
      await page.click(expandPatientFullReport);
      await page.waitForTimeout(4000);
    }
    await safeScreenshot(page, join(runDir, "02_laboratory_reports_module.png"), config);
    return {
      available: true,
      note: "Laboratory Reports and Patient Full Report card detected.",
    };
  } catch (error) {
    return {
      available: false,
      note: `Laboratory Reports module check failed: ${error.message}`,
    };
  }
}

// Checkpoint helpers for resume support
function loadCheckpoint(runDir) {
  const cpPath = join(runDir, "checkpoint.json");
  if (!existsSync(cpPath)) return { completedMrns: new Set(), claims: [] };
  try {
    const data = JSON.parse(readFileSync(cpPath, "utf8"));
    return {
      completedMrns: new Set(data.completedMrns || []),
      claims: Array.isArray(data.claims) ? data.claims : [],
    };
  } catch {
    return { completedMrns: new Set(), claims: [] };
  }
}

function saveCheckpoint(runDir, completedMrns, claims) {
  const cpPath = join(runDir, "checkpoint.json");
  writeFileSync(cpPath, JSON.stringify({
    updatedAt: new Date().toISOString(),
    completedMrns: Array.from(completedMrns),
    completedCount: completedMrns.size,
    claimCount: claims.length,
    claims,
  }, null, 2), "utf8");
}

async function isSessionAlive(page, config) {
  try {
    const hamburger = page.locator(cssEscapeId("pt1:OasisHedarToolBar:hamburgerBtn"));
    return (await hamburger.count()) > 0;
  } catch {
    return false;
  }
}

async function ensureSession(page, config, runDir) {
  try {
    const alive = await isSessionAlive(page, config);
    if (!alive) {
      console.log("Session expired or crashed, re-logging in...");
      // Navigate to a blank page first to recover from potential crash state
      await page.goto("about:blank", { timeout: 10000 }).catch(() => {});
      await login(page, config, runDir);
    }
  } catch (error) {
    console.log(`Session recovery needed: ${error.message}`);
    await page.goto("about:blank", { timeout: 10000 }).catch(() => {});
    await login(page, config, runDir);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function snapshotWindowsProcesses(pids) {
  const uniq = Array.from(new Set((pids || []).filter((p) => Number.isFinite(p) && p > 0)));
  if (uniq.length === 0) return [];
  const ps = [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `$pids=@(${uniq.join(",")}); ` +
      "Get-Process -Id $pids -ErrorAction SilentlyContinue | " +
      "Select-Object Id,ProcessName,CPU,WorkingSet64 | " +
      "ConvertTo-Json -Compress",
  ];
  const { stdout } = await execFileAsync("powershell", ps, { timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024 });
  const raw = String(stdout || "").trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list
    .map((p) => ({
      pid: Number(p.Id) || 0,
      name: String(p.ProcessName || ""),
      cpuSeconds: Number(p.CPU) || 0,
      workingSetBytes: Number(p.WorkingSet64) || 0,
    }))
    .filter((p) => p.pid > 0);
}

function startWindowsMetricsLogger({ pids, intervalMs, label }) {
  if (process.platform !== "win32") return () => {};
  let stopped = false;
  const cores = Math.max(1, os.cpus()?.length || 1);
  let lastAt = Date.now();
  const lastCpu = new Map(); // pid -> cpuSeconds

  async function tick() {
    if (stopped) return;
    let snapshot = [];
    try {
      snapshot = await snapshotWindowsProcesses(pids);
    } catch (error) {
      console.error(`metrics: failed to query processes: ${error.message}`);
      return;
    }

    const now = Date.now();
    const dtSeconds = Math.max(1, (now - lastAt) / 1000);
    lastAt = now;

    const lines = [];
    for (const proc of snapshot) {
      const prevCpu = lastCpu.get(proc.pid);
      lastCpu.set(proc.pid, proc.cpuSeconds);

      const deltaCpu = prevCpu === undefined ? null : Math.max(0, proc.cpuSeconds - prevCpu);
      const cpuPct = deltaCpu === null ? null : (deltaCpu / (dtSeconds * cores)) * 100;
      const memMb = proc.workingSetBytes > 0 ? proc.workingSetBytes / (1024 * 1024) : 0;

      lines.push({
        cpuPct,
        memMb,
        pid: proc.pid,
        name: proc.name,
      });
    }

    if (lines.length === 0) return;
    const title = label ? `Metrics (${label})` : "Metrics";
    console.log(`─── ${title} ───`);
    console.log("CPU(%)\tMemory(MB)\tPID\tName");
    for (const row of lines.sort((a, b) => (b.cpuPct ?? 0) - (a.cpuPct ?? 0))) {
      const cpu = row.cpuPct === null ? "?" : row.cpuPct.toFixed(1);
      console.log(`${cpu}\t${row.memMb.toFixed(0)}\t${row.pid}\t${row.name}`);
    }
  }

  const timer = setInterval(() => {
    tick().catch(() => {});
  }, intervalMs);

  // First tick immediately (best-effort).
  tick().catch(() => {});

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function closeExtraPages(context, keepPage) {
  try {
    const pages = typeof context?.pages === "function" ? context.pages() : [];
    const extras = pages.filter((p) => p && p !== keepPage);
    await Promise.all(extras.map((p) => p.close().catch(() => {})));
  } catch {
    // ignore
  }
}

async function withTimeout(promise, ms, label, onTimeout) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        if (typeof onTimeout === "function") onTimeout();
      } catch {
        // ignore
      }
      reject(new Error(`Timeout: ${label} exceeded ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function processMrnWithRetry(workerPage, mrn, representative, runDir, groupIndex, unionRequired, config) {
  const maxRetries = config.retries || 3;
  const mrnTimeout = Number(config.mrnTimeoutMs || (20 * 60 * 1000)); // 20 min max per MRN attempt
  let lastError = null;
  let page = workerPage;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      await ensureSession(page, config, runDir);
      if (config._logAction) config._logAction(`mrn.attempt mrn=${mrn} attempt=${attempt}`);

      const result = await withTimeout(
        processMrnOnce(page, mrn, representative, runDir, groupIndex, unionRequired, config),
        mrnTimeout,
        `MRN ${mrn} attempt ${attempt}`,
        () => {
          if (config._logAction) config._logAction(`mrn.timeout mrn=${mrn} attempt=${attempt} timeoutMs=${mrnTimeout}`);
          page?.close().catch(() => {});
        },
      );
      await closeExtraPages(page.context(), page);
      return { page, mrnContext: result };
    } catch (error) {
      lastError = error;
      console.log(`  Attempt ${attempt}/${maxRetries} failed for MRN=${mrn}: ${error.message}`);
      if (config._logAction) config._logAction(`mrn.retry mrn=${mrn} attempt=${attempt} error=${error.message.slice(0, 200)}`);

      // Reset the tab for the next attempt (also cancels any stuck in-flight Playwright ops).
      try {
        const ctx = page.context();
        await page.close().catch(() => {});
        const newPage = await ctx.newPage();
        await login(newPage, config, runDir);
        await closeExtraPages(ctx, newPage);
        page = newPage;
      } catch {
        // If recovery fails, fall through to retry/backoff and let the outer code handle eventual failure.
      }

      if (attempt < maxRetries) {
        const backoff = Math.min(5000 * Math.pow(2, attempt - 1), 30000);
        await sleep(backoff);
      }
    }
  }
  return {
    page,
    mrnContext: {
      mrn,
      oracleFound: false,
      documentsRetrieved: [],
      nphiesReady: false,
      oraclePatient: {},
      visits: {},
      documentsPanel: {},
      notes: [`MRN group processing failed after ${maxRetries} attempts: ${lastError?.message || "unknown"}`],
    },
  };
}

async function processSubmissionWithRetry(page, claim, runDir, index, config) {
  const maxRetries = config.retries || 3;
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      await ensureSession(page, config, runDir);
      return await processSubmission(page, claim, runDir, index, config);
    } catch (error) {
      lastError = error;
      console.log(`  Attempt ${attempt}/${maxRetries} failed: ${error.message}`);
      if (attempt < maxRetries) {
        const backoff = Math.min(5000 * Math.pow(2, attempt - 1), 30000);
        await sleep(backoff);
        await ensureSession(page, config, runDir);
      }
    }
  }
  return {
    invoiceNumber: String(claim.invoiceNumber ?? ""),
    mrn: String(claim.mrn ?? ""),
    oracleFound: false,
    documentsRetrieved: [],
    nphiesReady: false,
    notes: [`Claim processing failed after ${maxRetries} attempts: ${lastError?.message || "unknown"}`],
  };
}

function writeReports(claims, runDir, config, allSubmissions, submissions, loginResult) {
  const readyCount = claims.filter((c) => c.nphiesReady).length;
  const foundCount = claims.filter((c) => c.oracleFound).length;

  const report = {
    runAt: new Date().toISOString(),
    login: loginResult,
    payloadPath: config.payload ? resolve(config.payload) : "",
    payloadTotal: allSubmissions.length,
    processedCount: submissions.length,
    oraclePatientMatches: foundCount,
    nphiesReadyCount: readyCount,
    labReportsModule: { available: false, note: "Skipped." },
    claims,
    summary: {
      manualActionRequired: true,
      reason:
        "Patient search and visit extraction are automated. Document report LOV selection still requires manual selector confirmation for full PDF download automation.",
    },
  };

  const reportPath = join(runDir, "claims_processing_report.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");

  const prepQueue = claims.map((claim) => ({
    invoiceNumber: claim.invoiceNumber,
    mrn: claim.mrn,
    oracleFound: claim.oracleFound,
    payloadAttachmentCount: claim.payloadAttachmentCount,
    documentsRetrievedCount: (claim.documentsRetrieved || []).length,
    nphiesReady: claim.nphiesReady,
    requiredAttachments: claim.requiredAttachments,
    missingRequiredAttachments: (claim.attachmentAudit || [])
      .filter((item) => item.status !== "matched")
      .map((item) => item.type),
    documentsRetrieved: (claim.documentsRetrieved || []).map((d) => ({
      fileName: d.fileName,
      filePath: d.filePath,
      method: d.method,
      note: d.note,
      matchedRequiredType: d.matchedRequiredType,
    })),
    action:
      claim.oracleFound && !claim.nphiesReady
        ? "Attach required Oracle documents and submit to NPHIES"
        : claim.oracleFound && claim.nphiesReady
          ? "Ready to submit to NPHIES"
          : "Resolve MRN/patient match in Oracle",
  }));
  const prepPath = join(runDir, "nphies_submission_preparation.json");
  writeFileSync(prepPath, JSON.stringify(prepQueue, null, 2), "utf8");

  const bundleManifest = claims.map((claim) => {
    const requiredEntries = (claim.requiredAttachments || []).map((requiredType) => {
      const auditHit = (claim.attachmentAudit || []).find((a) => a.type === requiredType && a.status === "matched");
      const filePath = auditHit?.filePath || "";
      const sha256 = filePath ? hashFileSha256(filePath) : "";
      return {
        requiredType,
        status: filePath ? "ready" : "missing",
        filePath,
        fileName: auditHit?.fileName || "",
        sourceType: auditHit?.method || "",
        sha256,
      };
    });
    return {
      invoiceNumber: claim.invoiceNumber,
      mrn: claim.mrn,
      oracleFound: claim.oracleFound,
      nphiesReady: claim.nphiesReady,
      requiredAttachmentCount: (claim.requiredAttachments || []).length,
      resolvedAttachmentCount: requiredEntries.filter((e) => e.status === "ready").length,
      attachments: requiredEntries,
    };
  });
  const manifestPath = join(runDir, "nphies_submission_bundle_manifest.json");
  writeFileSync(manifestPath, JSON.stringify(bundleManifest, null, 2), "utf8");

  const validationQueue = claims.map((claim) => {
    const missing = (claim.attachmentAudit || []).filter((a) => a.status !== "matched").map((a) => a.type);
    const status = !claim.oracleFound
      ? "NO_PATIENT_MATCH"
      : claim.nphiesReady
        ? "READY"
        : "MISSING_ATTACHMENTS";
    return {
      invoiceNumber: claim.invoiceNumber,
      mrn: claim.mrn,
      status,
      oracleFound: claim.oracleFound,
      nphiesReady: claim.nphiesReady,
      requiredAttachmentCount: (claim.requiredAttachments || []).length,
      missingAttachmentCount: missing.length,
      missingAttachmentTypes: missing,
    };
  });
  const validationPath = join(runDir, "validation_queue.json");
  writeFileSync(validationPath, JSON.stringify(validationQueue, null, 2), "utf8");

  const validationCsvPath = join(runDir, "validation_queue.csv");
  writeCsv(
    validationCsvPath,
    validationQueue.map((q) => ({
      invoiceNumber: q.invoiceNumber,
      mrn: q.mrn,
      status: q.status,
      oracleFound: q.oracleFound,
      nphiesReady: q.nphiesReady,
      requiredAttachmentCount: q.requiredAttachmentCount,
      missingAttachmentCount: q.missingAttachmentCount,
      missingAttachmentTypes: (q.missingAttachmentTypes || []).join(" | "),
    })),
  );

  const dryRunChecklistPath = resolve(process.cwd(), "dry_run_nphies_checklist.json");
  let dryRunMap = new Map();
  if (existsSync(dryRunChecklistPath)) {
    try {
      const dry = JSON.parse(readFileSync(dryRunChecklistPath, "utf8"));
      const checklist = Array.isArray(dry.checklist) ? dry.checklist : [];
      dryRunMap = new Map(checklist.map((c) => [String(c.invoiceNumber ?? ""), Boolean(c.dryRunPass)]));
    } catch {
      // Ignore parsing failures.
    }
  }

  const submissionGate = validationQueue.map((q) => ({
    invoiceNumber: q.invoiceNumber,
    mrn: q.mrn,
    dryRunPass: dryRunMap.has(String(q.invoiceNumber)) ? dryRunMap.get(String(q.invoiceNumber)) : "",
    oracleFound: q.oracleFound,
    nphiesReady: q.nphiesReady,
    gateStatus: q.oracleFound && q.nphiesReady && (dryRunMap.get(String(q.invoiceNumber)) !== false) ? "GO" : "NO_GO",
    missingAttachmentCount: q.missingAttachmentCount,
    missingAttachmentTypes: (q.missingAttachmentTypes || []).join(" | "),
  }));
  writeFileSync(join(runDir, "submission_gate.json"), JSON.stringify(submissionGate, null, 2), "utf8");
  writeCsv(join(runDir, "submission_gate.csv"), submissionGate);

  const operatorTasksPath = resolve(process.cwd(), "oracle_operator_tasks.csv");
  if (existsSync(operatorTasksPath)) {
    try {
      const tasks = parseCsv(readFileSync(operatorTasksPath, "utf8"));
      const claimByInvoice = new Map(claims.map((c) => [String(c.invoiceNumber), c]));
      const updated = tasks.map((t) => {
        const inv = String(t.invoiceNumber || "");
        const claim = claimByInvoice.get(inv);
        if (!claim) return t;
        const type = String(t.attachmentType || "");
        const hit = (claim.attachmentAudit || []).find((a) => a.type === type);
        if (hit && hit.status === "matched") {
          return {
            ...t,
            oracleFound: String(Boolean(claim.oracleFound)),
            status: "DONE",
            notes: `matched=${hit.method || ""} file=${hit.fileName || ""}`.trim(),
          };
        }
        return {
          ...t,
          oracleFound: String(Boolean(claim.oracleFound)),
        };
      });
      const out = join(runDir, "oracle_operator_tasks.updated.csv");
      writeCsv(out, updated);
    } catch {
      // Ignore failures; operator tasks are optional artifacts.
    }
  }

  const goCount = submissionGate.filter((g) => g.gateStatus === "GO").length;
  const noGoCount = submissionGate.filter((g) => g.gateStatus === "NO_GO").length;

  console.log("─── Run Summary ───");
  console.log(`Artifacts:       ${runDir}`);
  console.log(`Main report:     ${reportPath}`);
  console.log(`Bundle manifest: ${manifestPath}`);
  console.log(`Processed:       ${submissions.length} submissions`);
  console.log(`Oracle matches:  ${foundCount}/${submissions.length}`);
  console.log(`NPHIES ready:    ${readyCount}/${submissions.length}`);
  console.log(`Gate GO:         ${goCount}  |  NO_GO: ${noGoCount}`);
  if (noGoCount > 0) {
    console.log(`Next: Review ${validationPath} for missing attachments.`);
  }
}

async function scanOnce(config) {
  if (!config.username || !config.password) {
    throw new Error("ORACLE_USERNAME and ORACLE_PASSWORD are required.");
  }

  if (!config.mrnCacheDir) {
    config.mrnCacheDir = join(resolve(config.artifactsDir), "mrn-cache");
  }

  const allSubmissions = loadPayload(config.payload);
  const submissions = config.limit > 0 ? allSubmissions.slice(0, config.limit) : allSubmissions;

  console.log(`Payload: ${submissions.length} submissions (of ${allSubmissions.length} total)`);
  console.log(`Config: headless=${config.headless} screenshots=${config.screenshots} batch=${config.batchSize} retries=${config.retries} resume=${config.resume} concurrency=${config.concurrency} fast=${config.downloadTimeout < 45000}`);

  // Dry-run mode: validate config and payload without launching browser
  if (config.dryRun) {
    console.log("─── Dry Run ───");
    console.log(`Portal URL:  ${config.url}`);
    console.log(`Username:    ${config.username}`);
    console.log(`Submissions: ${submissions.length}`);
    const mrnSet = new Set(submissions.map((s) => String(s.mrn ?? "").trim()).filter(Boolean));
    console.log(`Unique MRNs: ${mrnSet.size}`);
    const totalAttachments = submissions.reduce((sum, s) => sum + (Array.isArray(s.attachments) ? s.attachments.length : 0), 0);
    console.log(`Total required attachments: ${totalAttachments}`);
    console.log("Dry run complete. Remove --dry-run to execute.");
    return;
  }

  // Resume support: find latest run dir or create new
  let runDir;
  if (config.resume) {
    // Find latest run directory with a checkpoint
    const base = resolve(config.artifactsDir);
    let latestDir = "";
    if (existsSync(base)) {
      try {
        const dirs = readdirSync(base)
          .filter((d) => d.startsWith("run-"))
          .sort()
          .reverse();
        for (const d of dirs) {
          if (existsSync(join(base, d, "checkpoint.json"))) {
            latestDir = join(base, d);
            break;
          }
        }
      } catch { /* ignore */ }
    }
    if (latestDir) {
      runDir = latestDir;
      console.log(`Resuming from: ${runDir}`);
    } else {
      runDir = join(resolve(config.artifactsDir), `run-${timestampId()}`);
      console.log("No checkpoint found, starting fresh run.");
    }
  } else {
    runDir = join(resolve(config.artifactsDir), `run-${timestampId()}`);
  }
  mkdirSync(runDir, { recursive: true });

  const actionLogPath = join(runDir, "actions.log");
  config._logAction = (message) => {
    const line = `${new Date().toISOString()} ${message}\n`;
    try {
      appendFileSync(actionLogPath, line, "utf8");
    } catch (error) {
      // Do not let transient filesystem/backpressure issues kill the scan.
      // This can happen under heavy load or if the file is temporarily locked.
      try {
        console.error(`actions.log write failed: ${error.message}`);
      } catch {
        // ignore
      }
    }
  };

  // Load checkpoint for resume
  const checkpoint = loadCheckpoint(runDir);
  const claims = checkpoint.claims;
  const completedMrns = checkpoint.completedMrns;
  if (completedMrns.size > 0) {
    console.log(`Checkpoint loaded: ${completedMrns.size} MRNs already processed, ${claims.length} claims recorded.`);
  }

  let browser;
  let stopMetrics = () => {};
  try {
    browser = await chromium.launch({
      headless: config.headless,
      args: [
        "--ignore-certificate-errors",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-sandbox",
        "--js-flags=--max-old-space-size=2048",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-default-apps",
        "--disable-sync",
        "--disable-translate",
        "--mute-audio",
        "--single-process",
      ],
    });

    if (config.metrics) {
      const browserPid = browser.process()?.pid || 0;
      const pids = [process.pid, browserPid, ...(config.metricsExtraPids || [])].filter(Boolean);
      stopMetrics = startWindowsMetricsLogger({
        pids,
        intervalMs: config.metricsIntervalMs,
        label: `run=${runDir}`,
      });
    }

    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1920, height: 1080 },
      acceptDownloads: true,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();

    const loginResult = await login(page, config, runDir);
    config._logAction("login.success");

    // Create additional pages for concurrent processing
    const pages = [page];
    for (let w = 1; w < config.concurrency; w += 1) {
      const ctx = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width: 1920, height: 1080 },
        acceptDownloads: true,
        reducedMotion: "reduce",
      });
      const p = await ctx.newPage();
      await login(p, config, runDir);
      config._logAction(`login.success worker=${w}`);
      pages.push(p);
    }

    if (config.dedupeByMrn) {
      const mrnGroups = new Map();
      for (const sub of submissions) {
        const mrn = String(sub.mrn ?? "").trim();
        const key = mrn || `__missing__:${String(sub.invoiceNumber ?? "")}`;
        const group = mrnGroups.get(key) || { mrn, submissions: [], requiredUnion: new Set() };
        group.submissions.push(sub);
        for (const t of getClaimRequiredTypes(sub)) group.requiredUnion.add(t);
        mrnGroups.set(key, group);
      }

      const groupList = Array.from(mrnGroups.values());
      const totalGroups = groupList.length;
      let processedInBatch = 0;
      let nextGroupIdx = 0;

      // Worker function for concurrent MRN processing
      async function processWorker(workerPage, workerId) {
        let currentPage = workerPage;
        while (true) {
          const g = nextGroupIdx++;
          if (g >= totalGroups) break;

          const group = groupList[g];
          const mrn = group.mrn;

          if (completedMrns.has(mrn)) continue;

          const unionRequired = Array.from(group.requiredUnion);
          const representative = group.submissions[0] || {};

          console.log(`[W${workerId}] Processing MRN group ${g + 1}/${totalGroups} (MRN=${mrn}, invoices=${group.submissions.length})`);

          const mrnRun = await processMrnWithRetry(currentPage, mrn, representative, runDir, g, unionRequired, config);
          currentPage = mrnRun.page;
          const mrnContext = mrnRun.mrnContext;

          for (const sub of group.submissions) {
            const invoiceNumber = String(sub.invoiceNumber ?? "");
            const requiredAttachments = getClaimRequiredTypes(sub);

            const claimResult = {
              invoiceNumber,
              mrn: String(sub.mrn ?? ""),
              payloadPatientId: String(sub.patientId ?? ""),
              payloadPatientName: String(sub.patientName ?? ""),
              payloadAttachmentCount: requiredAttachments.length,
              requiredAttachments,
              oracleFound: Boolean(mrnContext.oracleFound),
              oraclePatient: mrnContext.oraclePatient || {},
              visits: mrnContext.visits || {},
              documentsPanel: mrnContext.documentsPanel || {},
              documentsRetrieved: mrnContext.documentsRetrieved || [],
              nphiesReady: false,
              notes: Array.isArray(mrnContext.notes) ? [...mrnContext.notes] : [],
            };

            claimResult.notes.push(
              "MRN dedupe enabled: attachments retrieved once per MRN and reused across invoices via MRN cache.",
            );

            const evald = evaluateAttachmentAudit(config, claimResult.mrn, requiredAttachments, claimResult.documentsRetrieved);
            claimResult.attachmentAudit = evald.attachmentAudit;
            claimResult.nphiesReady = requiredAttachments.length === 0 ? true : evald.nphiesReady;

            if (config._logAction) {
              config._logAction(
                `claim.end invoice=${invoiceNumber} mrn=${claimResult.mrn} oracleFound=${claimResult.oracleFound} nphiesReady=${claimResult.nphiesReady} deduped=true`,
              );
            }

            claims.push(claimResult);
          }

          completedMrns.add(mrn);
          saveCheckpoint(runDir, completedMrns, claims);
          processedInBatch += 1;

          if (config.batchSize > 0 && processedInBatch >= config.batchSize) {
            console.log(`Batch of ${config.batchSize} complete. Writing intermediate reports...`);
            writeReports(claims, runDir, config, allSubmissions, submissions, loginResult);
            processedInBatch = 0;
            if (global.gc) global.gc();
          }
        }
      }

      // Launch workers concurrently
      await Promise.all(pages.map((p, i) => processWorker(p, i)));
    } else {
      for (let i = 0; i < submissions.length; i += 1) {
        const claim = submissions[i];
        const mrn = String(claim.mrn ?? "").trim();

        // Skip already-completed (resume support)
        if (completedMrns.has(`__sub__:${claim.invoiceNumber}`)) {
          continue;
        }

        console.log(`Processing ${i + 1}/${submissions.length} (MRN=${mrn}, invoice=${claim.invoiceNumber})`);
        const result = await processSubmissionWithRetry(page, claim, runDir, i, config);
        claims.push(result);

        completedMrns.add(`__sub__:${claim.invoiceNumber}`);
        saveCheckpoint(runDir, completedMrns, claims);
      }
    }

    // Final reports
    writeReports(claims, runDir, config, allSubmissions, submissions, loginResult);
    console.log("Run completed successfully.");
  } finally {
    try {
      stopMetrics();
    } catch {
      // ignore
    }
    try {
      if (browser) {
        await withTimeout(browser.close(), 20000, "browser.close()");
      }
    } catch {
      // ignore
    }
  }
}

async function runDaemon(argv) {
  let stopRequested = false;
  process.on("SIGINT", () => { stopRequested = true; });
  process.on("SIGTERM", () => { stopRequested = true; });

  let runCount = 0;
  let backoffMs = 2000;

  while (!stopRequested) {
    const config = parseArgs(argv);
    if (config.help) {
      printHelp();
      return;
    }

    runCount += 1;
    const label = `daemon run ${runCount}${config.daemonMaxRuns ? `/${config.daemonMaxRuns}` : ""}`;
    console.log(`─── ${label} ───`);

    try {
      await scanOnce(config);
      backoffMs = 2000;
    } catch (error) {
      console.error(`Scan failed (will retry): ${error.message}`);
      const waitMs = Math.min(backoffMs, 5 * 60 * 1000);
      backoffMs = Math.min(backoffMs * 2, 5 * 60 * 1000);
      await sleep(waitMs);
      continue;
    }

    if (config.daemonMaxRuns > 0 && runCount >= config.daemonMaxRuns) {
      console.log("Daemon max runs reached; exiting.");
      return;
    }

    const intervalMs = Math.max(1000, config.daemonIntervalMs);
    console.log(`Sleeping ${Math.round(intervalMs / 1000)}s before next run... (Ctrl+C to stop)`);
    await sleep(intervalMs);
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (isMain) {
  const argv = process.argv.slice(2);
  const config = parseArgs(argv);
  if (config.help) {
    printHelp();
  } else if (config.daemon) {
    runDaemon(argv).catch((error) => {
      console.error("Oracle scanner daemon failed:", error.message);
      process.exit(1);
    });
  } else {
    scanOnce(config).catch((error) => {
      console.error("Oracle scanner failed:", error.message);
      process.exit(1);
    });
  }
}
