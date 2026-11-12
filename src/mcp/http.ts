import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Stateless Streamable HTTP: a fresh server + transport per request, as the MCP SDK recommends for horizontal scaling. */
export async function serveMcp(req: Request, res: Response, build: () => McpServer) {
  if (req.method !== "POST") {
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Use POST (stateless Streamable HTTP)." }, id: null });
    return;
  }
  const server = build();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close().catch(() => undefined);
    server.close().catch(() => undefined);
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: (e as Error).message }, id: null });
  }
}

/**
 * Notes each JSON-RPC message of an MCP request (method, tool name, arguments cut to 300 characters) once the response
 * is sent, for the "watch the tool calls" panel on /agents. Never throws into the request.
 */
export function logMcp(req: Request, res: Response, _who: { businessId: string; server: "owner" | "customer"; agentId: string }, write: (rows: { method: string; tool: string | null; args: string | null }[], status: number, ms: number) => Promise<void>) {
  const t0 = Date.now();
  const body = req.body;
  const msgs = (Array.isArray(body) ? body : [body]).filter((m) => m && typeof m === "object" && typeof m.method === "string") as { method: string; params?: { name?: unknown; arguments?: unknown } }[];
  if (!msgs.length) return;
  res.on("finish", () => {
    const rows = msgs.map((m) => ({
      method: m.method.slice(0, 60),
      tool: m.method === "tools/call" && typeof m.params?.name === "string" ? m.params.name.slice(0, 60) : null,
      args: m.method === "tools/call" && m.params?.arguments !== undefined ? JSON.stringify(m.params.arguments).slice(0, 300) : null,
    }));
    write(rows, res.statusCode, Date.now() - t0).catch((e) => console.warn("mcp log failed", (e as Error).message));
  });
}

/** Agent identity for audit and rate limits: X-Agent-Id header, else the User-Agent, else "anonymous-agent". */
export function agentIdOf(req: Request): string {
  const h = (req.header("x-agent-id") || req.header("user-agent") || "anonymous-agent").replace(/[^\w .:/@()-]/g, "").slice(0, 80);
  return h || "anonymous-agent";
}
