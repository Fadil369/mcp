import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

// ─── Domain types ────────────────────────────────────────────────────────────

interface ClaimRecord {
	bundleId: string;
	memberName: string;
	nationalId: string;
	serviceDate: string;
	serviceCode: string;
	serviceName: string;
	serviceCategory: string;
	rejectionCode: string;
	rejectionDescription: string;
	claimedAmount: number;
}

interface PortalClaimDetail {
	mrn: string;
	episodeNumber: string;
	invoiceNumber: string;
	claimStatus: string;
	detailedRejectionReason: string;
}

interface EnrichedClaim extends ClaimRecord {
	portalDetail: PortalClaimDetail | null;
	approvalLimit: number | null;
	rejectionValidation: "VALID" | "INVALID_CONTRACTUAL_VIOLATION" | "NEEDS_REVIEW";
	appealable: "YES" | "PARTIALLY" | "NO";
	protocolReference: string;
	missingDocuments: string[];
	nphiesAction: string;
}

// ─── Helper functions ─────────────────────────────────────────────────────────

function deriveServiceCategory(serviceName: string): string {
	const name = serviceName.toLowerCase();
	if (
		name.includes("lab") ||
		name.includes("test") ||
		name.includes("culture") ||
		name.includes("cbc") ||
		name.includes("blood")
	)
		return "Lab";
	if (
		name.includes("dent") ||
		name.includes("tooth") ||
		name.includes("oral") ||
		name.includes("panoram")
	)
		return "Dental";
	if (name.includes("consult") || name.includes("visit") || name.includes("exam"))
		return "Consultation";
	if (
		name.includes("drug") ||
		name.includes("tablet") ||
		name.includes("capsule") ||
		name.includes("injection") ||
		name.includes("medic")
	)
		return "Pharmacy";
	if (
		name.includes("xray") ||
		name.includes("x-ray") ||
		name.includes("radiol") ||
		name.includes("imag")
	)
		return "Radiology";
	if (name.includes("nebuliz") || name.includes("device") || name.includes("equipment"))
		return "Medical Device";
	if (name.includes("physiother") || name.includes("therapy")) return "Physiotherapy";
	return "Other";
}

function splitRejectionReason(raw: string): { code: string; description: string } {
	// Format observed: "BE-1-4 Preauthorization is required" or "SE-1-6 Dental requires auth"
	const match = raw.match(/^([A-Z]{1,3}-\d+-\d+)\s+(.+)$/);
	if (match) return { code: match[1], description: match[2] };
	return { code: raw, description: raw };
}

function getProtocolReference(
	rejectionCode: string,
	serviceName: string,
	serviceCategory: string,
): string {
	if (rejectionCode === "BE-1-4") {
		if (serviceCategory === "Dental")
			return "ART Dental Protocol – Dental services require prior authorization.";
		if (serviceCategory === "Medical Device")
			return "ART Protocol – Durable medical equipment (e.g. nebulizers) requires prior authorization.";
		if (serviceCategory === "Pharmacy")
			return "ART Protocol – Chronic medications require prior authorization.";
		if (serviceCategory === "Lab")
			return "ART Protocol – Specialized lab panels require prior authorization.";
		return "ART PreAuth Protocol – Service requires prior authorization before delivery.";
	}
	if (rejectionCode === "SE-1-6")
		return "ART Dental Protocol – Section SE-1-6: Specific dental procedures require PreAuth.";
	if (rejectionCode === "BE-1-2")
		return "ART Protocol – Service not covered under current policy.";
	if (rejectionCode === "BE-1-3") return "ART Protocol – Duplicate claim submission.";
	return `ART PreAuth Protocol – Refer to code ${rejectionCode} for applicable policy section.`;
}

function getMissingDocuments(rejectionCode: string, serviceCategory: string): string[] {
	if (rejectionCode === "BE-1-4") {
		const common = ["Copy of patient medical record", "Clinical justification letter"];
		if (serviceCategory === "Dental")
			return [...common, "Panoramic X-ray", "Dental treatment plan"];
		if (serviceCategory === "Medical Device")
			return [...common, "Physician prescription", "Device specification sheet"];
		if (serviceCategory === "Lab") return [...common, "Physician referral order"];
		return common;
	}
	if (rejectionCode === "SE-1-6")
		return ["Panoramic X-ray", "Dental treatment plan", "PreAuth approval copy"];
	if (rejectionCode === "BE-1-6")
		return ["Progress notes", "Diagnosis report", "Supporting clinical evidence"];
	return ["Supporting clinical documentation"];
}

function determineAppealability(
	rejectionCode: string,
	rejectionValidation: "VALID" | "INVALID_CONTRACTUAL_VIOLATION" | "NEEDS_REVIEW",
): "YES" | "PARTIALLY" | "NO" {
	if (rejectionValidation === "INVALID_CONTRACTUAL_VIOLATION") return "YES";
	if (rejectionCode === "BE-1-4") return "PARTIALLY";
	if (rejectionCode === "BE-1-2") return "NO";
	return "PARTIALLY";
}

function determineNphiesAction(
	rejectionCode: string,
	rejectionValidation: "VALID" | "INVALID_CONTRACTUAL_VIOLATION" | "NEEDS_REVIEW",
	missingDocuments: string[],
): string {
	if (rejectionValidation === "INVALID_CONTRACTUAL_VIOLATION") {
		return "Appeal – Contractual Violation: Submit formal dispute citing approval limit contract clause.";
	}
	if (rejectionCode === "BE-1-4") {
		return `Resubmit with Supporting Information (Claim.related.relationship = "prior"). Attach: ${missingDocuments.join(", ")}.`;
	}
	if (rejectionCode === "SE-1-6") {
		return `New PreAuth request (relationship = "prior"). Attach: ${missingDocuments.join(", ")}.`;
	}
	return `Review and resubmit with required documentation: ${missingDocuments.join(", ")}.`;
}

// ─── MCP Agent ────────────────────────────────────────────────────────────────

export class MyMCP extends McpAgent {
	server = new McpServer({
		name: "Medical Claims Analysis & NPHIES Preparation",
		version: "2.0.0",
	});

	async init() {
		// ── Tool 1: extract_claims ──────────────────────────────────────────────
		this.server.tool(
			"extract_claims",
			{
				batch_text: z
					.string()
					.describe(
						"Raw text content extracted from the batch rejection PDF (e.g. BAT-2026-NB-00004295-OT.pdf). " +
							"Each claim should be on its own line with fields separated by '|': " +
							"BundleID|MemberName|NationalID|ServiceDate|ServiceCode|ServiceName|RejectionReason|ClaimedAmount",
					),
			},
			async ({ batch_text }) => {
				const lines = batch_text
					.split("\n")
					.map((l) => l.trim())
					.filter((l) => l.length > 0 && !l.startsWith("#"));

				const claims: ClaimRecord[] = [];
				const errors: string[] = [];

				for (const [i, line] of lines.entries()) {
					const parts = line.split("|").map((p) => p.trim());
					if (parts.length < 7) {
						errors.push(
							`Line ${i + 1}: expected ≥7 fields, got ${parts.length} – skipped.`,
						);
						continue;
					}
					const [
						bundleId,
						memberName,
						nationalId,
						serviceDate,
						serviceCode,
						serviceName,
						rawRejection,
						rawAmount,
					] = parts;
					const { code: rejectionCode, description: rejectionDescription } =
						splitRejectionReason(rawRejection);
					const serviceCategory = deriveServiceCategory(serviceName);
					const claimedAmount = rawAmount
						? parseFloat(rawAmount.replace(/[^0-9.]/g, "")) || 0
						: 0;

					claims.push({
						bundleId,
						memberName,
						nationalId,
						serviceDate,
						serviceCode,
						serviceName,
						serviceCategory,
						rejectionCode,
						rejectionDescription,
						claimedAmount,
					});
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									totalExtracted: claims.length,
									parseErrors: errors,
									claims,
								},
								null,
								2,
							),
						},
					],
				};
			},
		);

		// ── Tool 2: validate_preauth_rejection ─────────────────────────────────
		this.server.tool(
			"validate_preauth_rejection",
			{
				rejection_code: z.string().describe("The rejection code, e.g. BE-1-4, SE-1-6."),
				service_code: z.string().describe("The medical service code."),
				service_name: z.string().describe("The human-readable service name."),
				claimed_amount: z
					.number()
					.describe("Total claimed amount for this service in SAR."),
				approval_limit: z
					.number()
					.describe(
						"Patient / policy approval limit in SAR. Claims below this threshold may not require PreAuth under the contract.",
					),
			},
			async ({ rejection_code, service_name, claimed_amount, approval_limit }) => {
				const serviceCategory = deriveServiceCategory(service_name);

				// Services that always require auth regardless of amount
				const alwaysRequireAuth = ["Dental", "Medical Device", "Radiology"];
				const requiresAuthByCategory = alwaysRequireAuth.includes(serviceCategory);

				let validation: "VALID" | "INVALID_CONTRACTUAL_VIOLATION" | "NEEDS_REVIEW";
				let rationale: string;

				if (rejection_code !== "BE-1-4") {
					validation = "NEEDS_REVIEW";
					rationale = `Rejection code ${rejection_code} is not a PreAuth rejection – manual review required.`;
				} else if (requiresAuthByCategory) {
					validation = "VALID";
					rationale = `${serviceCategory} services always require prior authorization under ART PreAuth Protocol, regardless of amount.`;
				} else if (claimed_amount < approval_limit) {
					validation = "INVALID_CONTRACTUAL_VIOLATION";
					rationale =
						`Claimed amount (SAR ${claimed_amount.toFixed(2)}) is below the patient approval limit (SAR ${approval_limit.toFixed(2)}). ` +
						`Under the contract, services below this threshold do not require PreAuth. ` +
						`This rejection may constitute a contractual violation by the payer.`;
				} else {
					validation = "VALID";
					rationale = `Claimed amount (SAR ${claimed_amount.toFixed(2)}) exceeds approval limit (SAR ${approval_limit.toFixed(2)}). PreAuth was required.`;
				}

				const protocolRef = getProtocolReference(
					rejection_code,
					service_name,
					serviceCategory,
				);
				const missingDocs = getMissingDocuments(rejection_code, serviceCategory);
				const appealable = determineAppealability(rejection_code, validation);
				const nphiesAction = determineNphiesAction(rejection_code, validation, missingDocs);

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									rejectionCode: rejection_code,
									serviceCategory,
									claimedAmount: claimed_amount,
									approvalLimit: approval_limit,
									validation,
									rationale,
									protocolReference: protocolRef,
									appealable,
									missingDocuments: missingDocs,
									nphiesAction,
								},
								null,
								2,
							),
						},
					],
				};
			},
		);

		// ── Tool 3: search_portal_claim ────────────────────────────────────────
		this.server.tool(
			"search_portal_claim",
			{
				portal_url: z
					.string()
					.url()
					.describe("Base URL of the claims portal, e.g. https://portals.elfadil.com"),
				username: z.string().describe("Portal login username."),
				password: z.string().describe("Portal login password."),
				bundle_id: z.string().describe("Batch bundle ID from the rejection report."),
				national_id: z.string().describe("Patient national ID."),
			},
			async ({ portal_url, username, password, bundle_id, national_id }) => {
				try {
					// Step 1: Authenticate
					const loginUrl = `${portal_url.replace(/\/$/, "")}/login`;
					const loginResponse = await fetch(loginUrl, {
						method: "POST",
						headers: { "Content-Type": "application/x-www-form-urlencoded" },
						body: new URLSearchParams({ username, password }),
						redirect: "manual",
					});

					const authCookie = loginResponse.headers.get("set-cookie") ?? "";
					if (!authCookie && loginResponse.status >= 400) {
						return {
							content: [
								{
									type: "text",
									text: JSON.stringify({
										success: false,
										error: `Authentication failed – HTTP ${loginResponse.status}. Verify credentials and portal URL.`,
									}),
								},
							],
						};
					}

					// Step 2: Search for the claim
					const searchUrl = `${portal_url.replace(/\/$/, "")}/claims/search`;
					const searchResponse = await fetch(searchUrl, {
						method: "POST",
						headers: {
							"Content-Type": "application/x-www-form-urlencoded",
							Cookie: authCookie,
						},
						body: new URLSearchParams({ bundleId: bundle_id, nationalId: national_id }),
					});

					if (!searchResponse.ok) {
						return {
							content: [
								{
									type: "text",
									text: JSON.stringify({
										success: false,
										error: `Portal search failed – HTTP ${searchResponse.status}.`,
									}),
								},
							],
						};
					}

					const rawText = await searchResponse.text();

					// Extract key fields from the HTML / JSON response using simple heuristics.
					// Real implementations should parse the portal-specific HTML/JSON structure.
					const mrnMatch = rawText.match(/MRN[:\s]+([A-Z0-9]+)/i);
					const episodeMatch = rawText.match(/Episode[:\s#]+([A-Z0-9]+)/i);
					const invoiceMatch = rawText.match(/Invoice[:\s#]+([A-Z0-9]+)/i);
					const statusMatch = rawText.match(
						/Status[:\s]+(Approved|Rejected|Partially Approved|Pending)/i,
					);
					const reasonMatch = rawText.match(/Rejection Reason[:\s]+([^\n<]+)/i);

					const detail: PortalClaimDetail = {
						mrn: mrnMatch?.[1] ?? "NOT_FOUND",
						episodeNumber: episodeMatch?.[1] ?? "NOT_FOUND",
						invoiceNumber: invoiceMatch?.[1] ?? "NOT_FOUND",
						claimStatus: statusMatch?.[1] ?? "UNKNOWN",
						detailedRejectionReason: reasonMatch?.[1]?.trim() ?? "Not available",
					};

					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										success: true,
										bundleId: bundle_id,
										nationalId: national_id,
										detail,
									},
									null,
									2,
								),
							},
						],
					};
				} catch (err) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									success: false,
									error: `Portal request error: ${err instanceof Error ? err.message : String(err)}`,
								}),
							},
						],
					};
				}
			},
		);

		// ── Tool 4: identify_missing_documents ─────────────────────────────────
		this.server.tool(
			"identify_missing_documents",
			{
				rejection_code: z.string().describe("Rejection code, e.g. BE-1-4."),
				service_category: z
					.string()
					.describe(
						"Service category: Lab, Dental, Pharmacy, Consultation, Radiology, Medical Device, etc.",
					),
				mrn: z
					.string()
					.optional()
					.describe("Patient MRN for Oracle portal lookup (if known)."),
			},
			async ({ rejection_code, service_category, mrn }) => {
				const docs = getMissingDocuments(rejection_code, service_category);

				const oracleModuleMapping: Record<string, string> = {
					"Copy of patient medical record": "Oracle Documents Panel (notes)",
					"Clinical justification letter": "Oracle Documents Panel (letters/plans)",
					"Progress notes": "Oracle Documents Panel (notes)",
					"Physician referral order": "Oracle Documents Panel (letters/plans)",
					"Physician prescription": "Oracle Documents Panel (letters/plans)",
					"Panoramic X-ray": "Oracle Radiology/Imaging module",
					"Dental treatment plan": "Oracle Documents Panel (letters/plans)",
					"PreAuth approval copy": "Oracle Documents Panel (notes)",
					"Diagnosis report": "Oracle Laboratory Reports module",
					"Supporting clinical evidence": "Oracle Documents Panel (notes)",
					"Device specification sheet": "Oracle Documents Panel (letters/plans)",
				};

				const docTaskList = docs.map((doc) => ({
					document: doc,
					oracleModule: oracleModuleMapping[doc] ?? "Oracle Documents Panel (general)",
					filename: mrn
						? `${mrn}_${doc.replace(/[^a-zA-Z0-9]/g, "_")}.pdf`
						: `{MRN}_${doc.replace(/[^a-zA-Z0-9]/g, "_")}.pdf`,
					searchDateRange: "01-01-2018 to present",
				}));

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									rejectionCode: rejection_code,
									serviceCategory: service_category,
									mrn: mrn ?? "unknown",
									requiredDocuments: docTaskList,
								},
								null,
								2,
							),
						},
					],
				};
			},
		);

		// ── Tool 5: build_claims_spreadsheet ───────────────────────────────────
		this.server.tool(
			"build_claims_spreadsheet",
			{
				enriched_claims_json: z
					.string()
					.describe(
						"JSON array of EnrichedClaim objects, as produced by combining extract_claims, " +
							"validate_preauth_rejection, search_portal_claim, and identify_missing_documents results.",
					),
				batch_id: z
					.string()
					.describe("The batch identifier, e.g. BAT-2026-NB-00004295-OT."),
				total_claimed_sar: z
					.number()
					.describe("Total claimed amount from the batch summary page (e.g. 22729.41)."),
				total_claims_count: z
					.number()
					.describe("Total number of claims listed on the batch cover page (e.g. 202)."),
			},
			async ({ enriched_claims_json, batch_id, total_claimed_sar, total_claims_count }) => {
				let claims: EnrichedClaim[];
				try {
					claims = JSON.parse(enriched_claims_json) as EnrichedClaim[];
				} catch {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									error: "Invalid JSON in enriched_claims_json.",
								}),
							},
						],
					};
				}

				// ── Sheet 1: Batch Summary ─────────────────────────────────────────
				const totalRejected = claims.reduce((s, c) => s + c.claimedAmount, 0);
				const invalidRejections = claims.filter(
					(c) => c.rejectionValidation === "INVALID_CONTRACTUAL_VIOLATION",
				);
				const validRejections = claims.filter((c) => c.rejectionValidation === "VALID");
				const needsReview = claims.filter((c) => c.rejectionValidation === "NEEDS_REVIEW");
				const vatRate = 0.15;
				const vatAmount = totalRejected * vatRate;

				const batchSummary = {
					sheetName: "Batch Summary",
					batchId: batch_id,
					totalClaims: total_claims_count,
					totalClaimedSAR: total_claimed_sar,
					totalRejectedInBatch: totalRejected.toFixed(2),
					vatOnRejected: vatAmount.toFixed(2),
					invalidRejections: invalidRejections.length,
					validRejections: validRejections.length,
					needsReview: needsReview.length,
					estimatedRecoverableAmount: invalidRejections
						.reduce((s, c) => s + c.claimedAmount, 0)
						.toFixed(2),
				};

				// ── Sheet 2: Analysis & Insights ──────────────────────────────────
				const codeCounts = claims.reduce(
					(acc, c) => {
						acc[c.rejectionCode] = (acc[c.rejectionCode] ?? 0) + 1;
						return acc;
					},
					{} as Record<string, number>,
				);

				const analysisRows = Object.entries(codeCounts).map(([code, count]) => {
					const pct = ((count / claims.length) * 100).toFixed(1);
					const subtotal = claims
						.filter((c) => c.rejectionCode === code)
						.reduce((s, c) => s + c.claimedAmount, 0)
						.toFixed(2);
					const sampleClaim = claims.find((c) => c.rejectionCode === code);
					return {
						rejectionCode: code,
						count,
						percentageOfTotal: `${pct}%`,
						totalAmountSAR: subtotal,
						priorityAction: sampleClaim?.nphiesAction ?? "Review required",
					};
				});

				// ── Sheet 3: Claims Data (master) ──────────────────────────────────
				const claimsData = claims.map((c) => ({
					bundleId: c.bundleId,
					memberName: c.memberName,
					nationalId: c.nationalId,
					mrn: c.portalDetail?.mrn ?? "Pending portal lookup",
					episodeId: c.portalDetail?.episodeNumber ?? "Pending portal lookup",
					invoiceNumber: c.portalDetail?.invoiceNumber ?? "Pending portal lookup",
					serviceDate: c.serviceDate,
					serviceCode: c.serviceCode,
					serviceName: c.serviceName,
					serviceCategory: c.serviceCategory,
					claimedAmountSAR: c.claimedAmount.toFixed(2),
					rejectionCode: c.rejectionCode,
					rejectionDescription: c.rejectionDescription,
					portalRejectionReason: c.portalDetail?.detailedRejectionReason ?? "N/A",
					claimStatus: c.portalDetail?.claimStatus ?? "N/A",
					approvalLimit: c.approvalLimit != null ? c.approvalLimit.toFixed(2) : "N/A",
					rejectionValidation: c.rejectionValidation,
					protocolReference: c.protocolReference,
					appealable: c.appealable,
					nphiesAction: c.nphiesAction,
				}));

				// ── Sheet 4: Appeal Tracker ────────────────────────────────────────
				const appealTracker = claims
					.filter((c) => c.appealable !== "NO")
					.map((c) => ({
						bundleId: c.bundleId,
						memberName: c.memberName,
						mrn: c.portalDetail?.mrn ?? "Pending",
						episodeId: c.portalDetail?.episodeNumber ?? "Pending",
						rejectionCode: c.rejectionCode,
						rejectionValidation: c.rejectionValidation,
						appealable: c.appealable,
						requiredSupportingDocs: c.missingDocuments.join("; "),
						nphiesAction: c.nphiesAction,
						priority:
							c.rejectionValidation === "INVALID_CONTRACTUAL_VIOLATION"
								? "HIGH"
								: "MEDIUM",
					}));

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									spreadsheet: {
										batchSummary,
										analysisAndInsights: analysisRows,
										claimsData,
										appealTracker,
									},
								},
								null,
								2,
							),
						},
					],
				};
			},
		);

		// ── Tool 6: prepare_nphies_submission ──────────────────────────────────
		this.server.tool(
			"prepare_nphies_submission",
			{
				enriched_claims_json: z
					.string()
					.describe(
						"JSON array of EnrichedClaim objects to prepare for NPHIES submission.",
					),
				provider_nphies_id: z.string().describe("The provider's registered NPHIES ID."),
				submission_type: z
					.enum([
						"resubmission_with_supporting_info",
						"new_claim_prior_episode",
						"preauth_retroactive",
					])
					.describe("Type of NPHIES submission to prepare."),
			},
			async ({ enriched_claims_json, provider_nphies_id, submission_type }) => {
				let claims: EnrichedClaim[];
				try {
					claims = JSON.parse(enriched_claims_json) as EnrichedClaim[];
				} catch {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									error: "Invalid JSON in enriched_claims_json.",
								}),
							},
						],
					};
				}

				const submissions = claims.map((claim) => {
					const base = {
						claimIdentifier: claim.portalDetail?.invoiceNumber ?? claim.bundleId,
						episodeId: claim.portalDetail?.episodeNumber ?? "UNKNOWN",
						memberName: claim.memberName,
						nationalId: claim.nationalId,
						mrn: claim.portalDetail?.mrn ?? "UNKNOWN",
						serviceCode: claim.serviceCode,
						serviceName: claim.serviceName,
						serviceDate: claim.serviceDate,
						claimedAmount: claim.claimedAmount,
						rejectionCode: claim.rejectionCode,
						providerNphiesId: provider_nphies_id,
					};

					if (submission_type === "resubmission_with_supporting_info") {
						return {
							...base,
							submissionType: "Resubmission – Supporting Information",
							fhirMapping: {
								resourceType: "Claim",
								"claim.use": "claim",
								"claim.related.claim": base.claimIdentifier,
								"claim.related.relationship": {
									system: "http://terminology.hl7.org/CodeSystem/ex-relatedclaimrelationship",
									code: "prior",
								},
								"claim.supportingInfo": claim.missingDocuments.map((doc, idx) => ({
									sequence: idx + 1,
									category: "info",
									valueString: doc,
								})),
							},
							requiredDocuments: claim.missingDocuments,
						};
					}

					if (submission_type === "new_claim_prior_episode") {
						return {
							...base,
							submissionType: "New Claim – Linked to Prior Episode",
							fhirMapping: {
								resourceType: "Claim",
								"claim.use": "claim",
								"claim.related.claim": base.claimIdentifier,
								"claim.related.relationship": {
									system: "http://terminology.hl7.org/CodeSystem/ex-relatedclaimrelationship",
									code: "prior",
								},
								"encounter.episode": base.episodeId,
								note: "New services added to existing episode – do not overwrite original claim.",
							},
						};
					}

					// preauth_retroactive
					return {
						...base,
						submissionType: "Retroactive Pre-Authorization Request",
						fhirMapping: {
							resourceType: "ClaimResponse",
							"claim.use": "preauthorization",
							"claim.related.claim": base.claimIdentifier,
							"claim.related.relationship": {
								system: "http://terminology.hl7.org/CodeSystem/ex-relatedclaimrelationship",
								code: "prior",
							},
							"claim.supportingInfo": claim.missingDocuments.map((doc, idx) => ({
								sequence: idx + 1,
								category: "info",
								valueString: doc,
							})),
						},
						requiredDocuments: claim.missingDocuments,
					};
				});

				const highPriority = submissions.filter((s) => {
					const claim = claims.find(
						(c) => c.serviceCode === s.serviceCode && c.memberName === s.memberName,
					);
					return claim?.rejectionValidation === "INVALID_CONTRACTUAL_VIOLATION";
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									submissionType: submission_type,
									totalSubmissions: submissions.length,
									highPriorityCount: highPriority.length,
									submissions,
								},
								null,
								2,
							),
						},
					],
				};
			},
		);

		// ── Tool 7: analyze_claim_trends ───────────────────────────────────────
		this.server.tool(
			"analyze_claim_trends",
			{
				claims_json: z
					.string()
					.describe("JSON array of ClaimRecord or EnrichedClaim objects to analyze."),
				batch_id: z.string().describe("Batch identifier for labelling the report."),
				provider_name: z
					.string()
					.optional()
					.describe("Provider name for the executive summary."),
			},
			async ({ claims_json, batch_id, provider_name }) => {
				let claims: ClaimRecord[];
				try {
					claims = JSON.parse(claims_json) as ClaimRecord[];
				} catch {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({ error: "Invalid JSON in claims_json." }),
							},
						],
					};
				}

				const totalClaims = claims.length;
				if (totalClaims === 0) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({ error: "No claims provided for analysis." }),
							},
						],
					};
				}
				const totalAmount = claims.reduce((s, c) => s + c.claimedAmount, 0);

				// Rejection code breakdown
				const byCode = claims.reduce(
					(acc, c) => {
						if (!acc[c.rejectionCode]) acc[c.rejectionCode] = { count: 0, amount: 0 };
						acc[c.rejectionCode].count += 1;
						acc[c.rejectionCode].amount += c.claimedAmount;
						return acc;
					},
					{} as Record<string, { count: number; amount: number }>,
				);

				const rejectionBreakdown = Object.entries(byCode)
					.sort((a, b) => b[1].count - a[1].count)
					.map(([code, data]) => ({
						rejectionCode: code,
						count: data.count,
						percentageOfTotal: `${((data.count / totalClaims) * 100).toFixed(1)}%`,
						totalAmountSAR: data.amount.toFixed(2),
						percentageOfAmount: `${((data.amount / totalAmount) * 100).toFixed(1)}%`,
					}));

				// Category breakdown
				const byCategory = claims.reduce(
					(acc, c) => {
						if (!acc[c.serviceCategory])
							acc[c.serviceCategory] = { count: 0, amount: 0 };
						acc[c.serviceCategory].count += 1;
						acc[c.serviceCategory].amount += c.claimedAmount;
						return acc;
					},
					{} as Record<string, { count: number; amount: number }>,
				);

				const categoryBreakdown = Object.entries(byCategory)
					.sort((a, b) => b[1].amount - a[1].amount)
					.map(([cat, data]) => ({
						category: cat,
						count: data.count,
						totalAmountSAR: data.amount.toFixed(2),
					}));

				// Top 10 highest-value rejected claims
				const top10 = [...claims]
					.sort((a, b) => b.claimedAmount - a.claimedAmount)
					.slice(0, 10)
					.map((c) => ({
						memberName: c.memberName,
						serviceCode: c.serviceCode,
						serviceName: c.serviceName,
						rejectionCode: c.rejectionCode,
						amountSAR: c.claimedAmount.toFixed(2),
					}));

				// BE-1-4 specific analysis (most common code in these batches)
				const be14Claims = claims.filter((c) => c.rejectionCode === "BE-1-4");
				const be14Amount = be14Claims.reduce((s, c) => s + c.claimedAmount, 0);

				const executiveSummary = {
					batchId: batch_id,
					providerName: provider_name ?? "N/A",
					keyFindings: [
						`Total rejected claims: ${totalClaims}`,
						`Total rejected amount: SAR ${totalAmount.toFixed(2)}`,
						`Most common rejection: ${rejectionBreakdown[0]?.rejectionCode ?? "N/A"} (${rejectionBreakdown[0]?.percentageOfTotal ?? "0%"} of rejections)`,
						`BE-1-4 (No PreAuth) impact: ${be14Claims.length} claims worth SAR ${be14Amount.toFixed(2)}`,
						`Top rejected service category: ${categoryBreakdown[0]?.category ?? "N/A"}`,
					],
					financialOverview: {
						totalRejectedSAR: totalAmount.toFixed(2),
						vatExposureSAR: (totalAmount * 0.15).toFixed(2),
						be14ExposureSAR: be14Amount.toFixed(2),
						immediateActionRequired: `Review ${be14Claims.length} BE-1-4 rejections for retroactive PreAuth submission.`,
					},
				};

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									executiveSummary,
									rejectionCodeBreakdown: rejectionBreakdown,
									categoryBreakdown,
									top10HighestValueRejections: top10,
								},
								null,
								2,
							),
						},
					],
				};
			},
		);

		// ── Tool 8: add (kept for backward compatibility) ──────────────────────
		this.server.tool("add", { a: z.number(), b: z.number() }, async ({ a, b }) => ({
			content: [{ type: "text", text: String(a + b) }],
		}));

		// ── Tool 9: calculate (kept for backward compatibility) ─────────────────
		this.server.tool(
			"calculate",
			{
				operation: z.enum(["add", "subtract", "multiply", "divide"]),
				a: z.number(),
				b: z.number(),
			},
			async ({ operation, a, b }) => {
				let result: number;
				switch (operation) {
					case "add":
						result = a + b;
						break;
					case "subtract":
						result = a - b;
						break;
					case "multiply":
						result = a * b;
						break;
					case "divide":
						if (b === 0)
							return {
								content: [{ type: "text", text: "Error: Cannot divide by zero" }],
							};
						result = a / b;
						break;
				}
				return { content: [{ type: "text", text: String(result) }] };
			},
		);
	}
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname === "/mcp") {
			return MyMCP.serve("/mcp").fetch(request, env, ctx);
		}

		return new Response("Not found", { status: 404 });
	},
};
