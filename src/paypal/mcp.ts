/**
 * PayPal's hosted MCP server, read tools only (spec A5.3 (b)). The access token is minted from this app's own client id
 * and secret (client credentials). The hosted server lists 46 tools and marks none read-only, so the allowlist below is
 * the only thing the agent loop sees, and `callPayPalRead` refuses any other name in code. No tool here moves money.
 *
 * Transport: the sandbox server answers on its SSE endpoint (`/sse`); the streamable HTTP path in PayPal's docs
 * (`/http`) returned 404 when this was written (11 Nov 2026), so SSE is used.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { config, paypalBaseUrl } from "../config.js";

/** Read-only PayPal MCP tools. Every name was checked against the hosted server's list; none creates, sends, pays, refunds or cancels. */
export const PAYPAL_MCP_READ = [
  "get_order",
  "list_transactions",
  "list_invoices",
  "get_invoice",
  "get_refund",
  "show_subscription_details",
  "list_subscription_plans",
  "show_subscription_plan_details",
  "list_disputes",
  "get_dispute",
  "get_merchant_insights",
] as const;
const READ = new Set<string>(PAYPAL_MCP_READ);

export const paypalMcpUrl = () => process.env.PAYPAL_MCP_URL || (config.paypal.env === "live" ? "https://mcp.paypal.com/sse" : "https://mcp.sandbox.paypal.com/sse");
export const paypalMcpReady = () => Boolean(config.paypal.clientId && config.paypal.clientSecret) && process.env.PAYPAL_MCP !== "off";

let token: { v: string; exp: number } | null = null;
async function accessToken(): Promise<string> {
  if (token && Date.now() < token.exp - 60_000) return token.v;
  const r = await fetch(`${paypalBaseUrl()}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${config.paypal.clientId}:${config.paypal.clientSecret}`).toString("base64"), "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(10_000),
  });
  const d = (await r.json().catch(() => ({}))) as any;
  if (!r.ok || !d.access_token) throw new Error(`PayPal sign-in for MCP failed (${r.status})`);
  token = { v: String(d.access_token), exp: Date.now() + Number(d.expires_in ?? 3000) * 1000 };
  return token.v;
}

let conn: { client: Client; at: number; tools: { name: string; description: string; inputSchema: any }[] } | null = null;
async function connect() {
  if (conn && Date.now() - conn.at < 10 * 60_000) return conn;
  if (conn) await conn.client.close().catch(() => undefined);
  conn = null;
  const auth = { Authorization: `Bearer ${await accessToken()}` };
  const transport = new SSEClientTransport(new URL(paypalMcpUrl()), {
    eventSourceInit: { fetch: (u: any, i: any) => fetch(u, { ...i, headers: { ...(i?.headers ?? {}), ...auth } }) } as any,
    requestInit: { headers: auth },
  });
  const client = new Client({ name: "callback", version: "1.0.0" });
  await Promise.race([client.connect(transport), new Promise((_, bad) => setTimeout(() => bad(new Error("PayPal MCP did not answer in 10 s")), 10_000))]);
  const all = (await client.listTools()).tools;
  const tools = all.filter((t) => READ.has(t.name)).map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema }));
  conn = { client, at: Date.now(), tools };
  return conn;
}

/** The read tools the hosted server offers right now (the allowlist, intersected with what it lists). */
export async function paypalReadTools() {
  if (!paypalMcpReady()) return [];
  return (await connect()).tools;
}

/** Call one read tool. Any name outside the allowlist is refused here, before anything is sent. */
export async function callPayPalRead(name: string, args: Record<string, unknown>): Promise<string> {
  if (!READ.has(name)) throw new Error(`${name} is not a read-only PayPal tool; the agent may not call it`);
  const c = await connect();
  const r: any = await Promise.race([c.client.callTool({ name, arguments: args }), new Promise((_, bad) => setTimeout(() => bad(new Error("PayPal MCP timed out")), 15_000))]);
  const text = (r?.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n");
  if (r?.isError) throw new Error(text.slice(0, 300) || "PayPal MCP returned an error");
  return text;
}
