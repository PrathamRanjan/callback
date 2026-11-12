/**
 * "Connect your assistant" on /agents (spec C): the owner's demo MCP key, a config to paste into an MCP client, a
 * button that makes one real MCP call from this page, and a panel that shows every MCP request as it arrives.
 * The key is the demo workspace's own owner key, shown only to its owner; a demo reset issues new keys.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Copy, Eye, EyeOff, Plug } from "lucide-react";
import { toast } from "sonner";
import { t } from "@/i18n";
import { getJson } from "@/lib/api";
import { useSession } from "@/lib/hooks";
import { when } from "@/lib/format";

interface McpRow { server: string; agent_id: string; method: string; tool: string | null; args: string | null; status: number | null; ms: number | null; at: string }

export function ConnectAssistant() {
  const { session } = useSession();
  const owner = session?.me?.role === "owner";
  const [key, setKey] = useState<string | null | undefined>(undefined); // undefined while loading
  const [show, setShow] = useState(false);
  const [rows, setRows] = useState<McpRow[] | null>(null);
  const [trying, setTrying] = useState(false);
  const url = `${location.origin}/mcp`;

  useEffect(() => {
    if (!owner) return;
    getJson<{ keys: { owner: string } | null }>("/api/app/demo").then((d) => setKey(d.keys?.owner ?? null), () => setKey(null));
  }, [owner]);
  useEffect(() => {
    if (!owner) return;
    let alive = true;
    const pull = () => getJson<{ calls: McpRow[] }>("/api/app/agents/log").then((d) => alive && setRows(d.calls), () => undefined);
    void pull();
    const iv = setInterval(() => { if (document.visibilityState === "visible") void pull(); }, 3000);
    return () => { alive = false; clearInterval(iv); };
  }, [owner]);

  if (!owner) {
    return (
      <div className="rounded-[12px] border border-line bg-surface p-4 text-sm">
        <h2 className="flex items-center gap-2 text-h2 font-semibold"><Plug className="size-5" aria-hidden="true" />{t("Connect your assistant")}</h2>
        <p className="mt-1">{t("Start a demo as the owner to get a demo key for your own workspace, a config to paste into your MCP client, and a live view of every tool call it makes.")}</p>
        <Link to="/try" className="mt-3 inline-flex min-h-11 items-center rounded-[8px] bg-ink px-4 font-medium text-paper">{t("Be the owner")}</Link>
      </div>
    );
  }
  const shown = key && show ? key : "••••••••••••";
  const config = JSON.stringify({ mcpServers: { callback: { type: "http", url, headers: { Authorization: `Bearer ${shown}`, "X-Agent-Id": "my-assistant" } } } }, null, 2);
  const copy = async (s: string, what: string) => {
    try {
      await navigator.clipboard.writeText(s);
      toast.success(t("Copied: {0}", [what]));
    } catch {
      toast.error(t("This browser didn't allow copying. Select the text instead."));
    }
  };
  const tryIt = async () => {
    if (!key) return;
    setTrying(true);
    try {
      const r = await fetch("/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${key}`, "x-agent-id": "agents-page-test" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_plan", arguments: {} } }) });
      const j = await r.json();
      const n = (() => { try { return JSON.parse(j.result.content[0].text).length as number; } catch { return null; } })();
      if (!r.ok || j.error) throw new Error(j.error?.message ?? `HTTP ${r.status}`);
      toast.success(n === null ? t("get_plan answered.") : t("get_plan answered: {0} call candidates.", [n]));
      const d = await getJson<{ calls: McpRow[] }>("/api/app/agents/log");
      setRows(d.calls);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setTrying(false);
    }
  };
  return (
    <div className="grid min-w-0 gap-3 rounded-[12px] border border-line bg-surface p-4 text-sm [&>*]:min-w-0" data-testid="connect-assistant">
      <h2 className="flex items-center gap-2 text-h2 font-semibold"><Plug className="size-5" aria-hidden="true" />{t("Connect your assistant")}</h2>
      <p>{t("Your demo workspace's owner key. It works only on this workspace, gets the same gate and limits as you, and a demo reset issues a new one.")}</p>
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ink-2">{t("Server")}</span>
          <code className="rounded bg-surface-2 px-2 py-1 font-mono text-xs">{url}</code>
          <button type="button" className="min-h-11 rounded-[8px] border border-line px-3" onClick={() => copy(url, t("server address"))}><Copy className="inline size-4" aria-hidden="true" /> {t("Copy")}</button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ink-2">{t("Demo key")}</span>
          <code className="rounded bg-surface-2 px-2 py-1 font-mono text-xs" data-testid="demo-key">{key === undefined ? t("Loading…") : key ? shown : t("not available (not a demo workspace)")}</code>
          {key ? (
            <>
              <button type="button" className="min-h-11 rounded-[8px] border border-line px-3" aria-pressed={show} onClick={() => setShow((v) => !v)}>{show ? <EyeOff className="inline size-4" aria-hidden="true" /> : <Eye className="inline size-4" aria-hidden="true" />} {show ? t("Hide") : t("Show")}</button>
              <button type="button" className="min-h-11 rounded-[8px] border border-line px-3" onClick={() => copy(key, t("demo key"))}><Copy className="inline size-4" aria-hidden="true" /> {t("Copy")}</button>
            </>
          ) : null}
        </div>
      </div>
      <div>
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2"><span className="text-ink-2">{t("MCP client config (Streamable HTTP)")}</span><button type="button" className="min-h-11 rounded-[8px] border border-line px-3" disabled={!key} onClick={() => key && copy(config.replace(shown, key), t("config"))}><Copy className="inline size-4" aria-hidden="true" /> {t("Copy with key")}</button></div>
        <pre className="max-w-full overflow-x-auto rounded-[8px] bg-surface-2 p-3 font-mono text-xs" tabIndex={0} aria-label={t("MCP client config")}>{config}</pre>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="min-h-11 rounded-[8px] bg-ink px-4 font-medium text-paper" disabled={!key || trying} onClick={tryIt}>{trying ? t("Calling…") : t("Try it from here: call get_plan")}</button>
        <span className="text-xs text-ink-2">{t("A real MCP request from this page, with your key, read-only.")}</span>
      </div>
      <div>
        <h3 className="font-semibold">{t("Tool calls as they arrive")}</h3>
        <p className="text-xs text-ink-2">{t("Every MCP request to your workspace, newest first, refreshed every 3 seconds. Arguments are cut to 300 characters. Each tool's own steps are in the run traces.")}</p>
        {rows === null ? <p className="mt-2 text-ink-2">{t("Loading…")}</p> : rows.length === 0 ? <p className="mt-2 text-ink-2" data-testid="mcp-empty">{t("Nothing yet. Connect your assistant, or press Try it from here.")}</p> : (
          <div className="mt-2 overflow-x-auto" tabIndex={0} role="region" aria-label={t("MCP tool calls")}>
            <table className="w-full min-w-[560px] text-xs" data-testid="mcp-log">
              <thead><tr className="text-left text-ink-2"><th className="py-1 pr-2 font-medium">{t("When")}</th><th className="py-1 pr-2 font-medium">{t("Assistant")}</th><th className="py-1 pr-2 font-medium">{t("Server")}</th><th className="py-1 pr-2 font-medium">{t("Tool or method")}</th><th className="py-1 pr-2 font-medium">{t("Arguments")}</th><th className="py-1 font-medium">{t("Result")}</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.at}-${i}`} className="border-t border-line align-top">
                    <td className="py-1 pr-2 whitespace-nowrap">{when(r.at)}</td>
                    <td className="py-1 pr-2 font-mono">{r.agent_id}</td>
                    <td className="py-1 pr-2">{r.server === "owner" ? t("owner") : t("customer")}</td>
                    <td className="py-1 pr-2 font-mono">{r.tool ?? r.method}</td>
                    <td className="py-1 pr-2 font-mono">{r.args ?? ""}</td>
                    <td className="py-1 whitespace-nowrap">{r.status === null ? "—" : r.status < 300 ? t("{0} in {1} ms", ["OK", r.ms ?? 0]) : t("HTTP {0}", [r.status])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
