import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

// Oracle portal routes configuration
const ORACLE_PORTALS = {
	riyadh: { host: 'localhost', path: '/prod', port: 80 },
	madinah: { host: 'localhost', path: '/Oasis', port: 80 },
	unaizah: { host: 'localhost', path: '/prod', port: 80 },
	khamis: { host: 'localhost', path: '/prod', port: 80 },
	jizan: { host: 'localhost', path: '/prod', port: 80 },
	abha: { host: 'localhost', path: '/prod', port: 80 },
};

// Define our MCP agent with Oracle portal tools
export class MyMCP extends McpAgent {
	server = new McpServer({
		name: "BrainSAIT Oracle Portal Router",
		version: "2.0.0",
	});

	async init() {
		// Get portal info
		this.server.tool(
			"get_portal_info",
			{ city: z.enum(["riyadh", "madinah", "unaizah", "khamis", "jizan", "abha"]) },
			async ({ city }) => {
				const portal = ORACLE_PORTALS[city];
				return {
					content: [{
						type: "text",
						text: JSON.stringify({
							city,
							url: `http://${portal.host}:${portal.port}${portal.path}`,
							...portal
						})
					}],
				};
			}
		);

		// List all portals
		this.server.tool("list_portals", {}, async () => ({
			content: [{
				type: "text",
				text: JSON.stringify(Object.keys(ORACLE_PORTALS))
			}],
		}));

		// Calculator tools (legacy, keep for compatibility)
		this.server.tool("add", { a: z.number(), b: z.number() }, async ({ a, b }) => ({
			content: [{ type: "text", text: String(a + b) }],
		}));
	}
}

// Oracle portal proxy handler
async function handleOracleProxy(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const pathParts = url.pathname.split('/').filter(Boolean);
	
	// Extract city from path: /oracle/riyadh/... or /portals/riyadh/...
	const city = pathParts[1] as keyof typeof ORACLE_PORTALS;
	
	if (!city || !ORACLE_PORTALS[city]) {
		return new Response(JSON.stringify({
			error: 'Invalid portal',
			available: Object.keys(ORACLE_PORTALS)
		}), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	const portal = ORACLE_PORTALS[city];
	const targetPath = pathParts.slice(2).join('/');
	const targetUrl = `http://${portal.host}:${portal.port}${portal.path}/${targetPath}${url.search}`;

	try {
		// Proxy to local Oracle instance
		const response = await fetch(targetUrl, {
			method: request.method,
			headers: request.headers,
			body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
		});

		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	} catch (error) {
		return new Response(JSON.stringify({
			error: 'Portal connection failed',
			city,
			message: error instanceof Error ? error.message : 'Unknown error'
		}), {
			status: 502,
			headers: { 'Content-Type': 'application/json' }
		});
	}
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		// MCP endpoint
		if (url.pathname === "/mcp") {
			return MyMCP.serve("/mcp").fetch(request, env, ctx);
		}

		// Oracle portal proxy
		if (url.pathname.startsWith("/oracle/") || url.pathname.startsWith("/portals/")) {
			return handleOracleProxy(request);
		}

		// API endpoint to list portals
		if (url.pathname === "/api/portals") {
			return new Response(JSON.stringify(ORACLE_PORTALS), {
				headers: { 'Content-Type': 'application/json' }
			});
		}

		return new Response("Not found", { status: 404 });
	},
};
