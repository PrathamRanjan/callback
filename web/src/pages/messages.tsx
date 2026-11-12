import { useMemo, useState } from "react";
import { Bell, BellRing, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ActButton, Empty, ErrorState, PageHead, Panel, Rows, Section, StateChip } from "@/components/app/bits";
import { act } from "@/lib/api";
import { when, plural } from "@/lib/format";
import { useData, useSession, useTitle } from "@/lib/hooks";

import { t } from "@/i18n";
interface Msg { id: string; channel: string; direction: "in" | "out"; address: string; body: string; status: string; at: string }
interface MessagesData { owner_address: string; telegram_linked: number; recent: Msg[]; thread: { direction: string; body: string; channel: string; status: string; at: string }[]; address: string | null }
const who = (a: string) => (a.startsWith("owner:") ? "You (owner)" : a.startsWith("customer:") ? `Customer ${a.slice(9, 15)}…` : a);

export default function MessagesPage() {
  useTitle(t("Messages"));
  const { session } = useSession();
  const [addr, setAddr] = useState<string | null>(null);
  const { data: d, error, loading, reload } = useData<MessagesData>(`/api/app/messages${addr ? `?address=${encodeURIComponent(addr)}` : ""}`, { poll: 15000 });
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const threads = useMemo(() => {
    const m = new Map<string, Msg>();
    for (const x of d?.recent ?? []) if (!m.has(x.address)) m.set(x.address, x);
    return [...m.values()];
  }, [d]);
  if (error && !d) return <ErrorState error={error} retry={reload} />;
  if (loading && !d) return <Rows n={4} />;
  if (!d) return null;
  const current = addr ?? d.owner_address;
  const i = session?.integrations;
  return (
    <>
      <PageHead
        title={t("Messages")}
        happened={t("{messages} across {threads}.", { messages: plural(d.recent.length, "recent message"), threads: plural(threads.length, "conversation") })}
        next={d.telegram_linked ? t("Holds reach you on Telegram with Approve and Decline buttons.") : t("Connect Telegram so holds reach your phone and the customer isn't left waiting.")}
      />
      <Section id="alerts" title={t("Alerts on your phone")}>
        <Panel className="flex flex-col gap-3 p-4 md:flex-row md:items-center">
          <StateChip s={d.telegram_linked ? "done" : "idle"}>{d.telegram_linked ? t("Telegram connected") : t("Telegram not connected")}</StateChip>
          <p className="flex-1 text-sm text-ink-2">{t("Opens Telegram with a one-time code that expires in 15 minutes. Text messages")}{" "}{i?.sms ? t("go out through Twilio") : t("are shown here as previews (no SMS number connected)")}.</p>
          <ActButton path="/connect/telegram" icon={<BellRing />}>{d.telegram_linked ? t("Connect another chat") : t("Connect Telegram")}</ActButton>
        </Panel>
        {i?.push ? (
          <Panel className="mt-3 flex flex-col gap-3 p-4 md:flex-row md:items-center">
            <p className="flex-1 text-sm text-ink-2">{t("Or get a pop-up on this phone or computer when Callback holds a decision for you. No app to install.")}</p>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const { enablePush } = await import("@/lib/push");
                  toast.success(await enablePush());
                } catch (x) {
                  toast.error((x as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Bell />{" "}{t("Alerts on this device")}
            </Button>
          </Panel>
        ) : null}
      </Section>
      <div className="grid gap-6 lg:grid-cols-[300px_1fr] [&>*]:min-w-0">
        <Section id="threads" title={t("Conversations")}>
          {threads.length ? (
            <ul className="divide-y divide-line overflow-hidden rounded-[10px] border border-line bg-surface">
              {[{ address: d.owner_address } as Msg, ...threads.filter((t) => t.address !== d.owner_address)].map((t) => (
                <li key={t.address}>
                  <button type="button" onClick={() => setAddr(t.address)} aria-current={current === t.address} className={`w-full px-4 py-3 text-left hover:bg-surface-2 ${current === t.address ? "bg-brand-soft" : ""}`}>
                    <div className="truncate text-sm font-medium">{who(t.address)}</div>
                    {t.body ? <div className="truncate text-xs text-ink-2">{t.body}</div> : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : <Empty title={t("No messages yet")} />}
        </Section>
        <Section id="thread" title={who(current)} hint={t("Simulator: send a message as this person, the way it would arrive by Telegram or SMS. Type approve:<id> to decide a hold as the owner.")}>
          <Panel className="p-4">
            {d.thread.length ? (
              <ol className="mb-4 max-h-[420px] space-y-2 overflow-y-auto">
                {d.thread.map((m, k) => (
                  <li key={k} className={m.direction === "in" ? "pl-10 text-right" : "pr-10"}>
                    <span className={`inline-block max-w-full rounded-[10px] px-3 py-2 text-left text-sm [overflow-wrap:anywhere] ${m.direction === "in" ? "bg-surface-2" : "bg-brand-soft"}`}>{m.body}</span>
                    <div className="mt-0.5 text-[0.7rem] text-ink-2 [overflow-wrap:anywhere]">{m.channel} · {m.status} · {when(m.at)}</div>
                  </li>
                ))}
              </ol>
            ) : <p className="mb-4 text-sm text-ink-2">{t("Nothing in this conversation yet.")}</p>}
            <form
              className="flex flex-col gap-2 sm:flex-row sm:items-end"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                try {
                  const r = await act("/ops/channels/reply", { address: current, text });
                  toast.success(r.message || t("Received."));
                  setText("");
                  await reload();
                } catch (x) {
                  toast.error((x as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <div className="grid flex-1 gap-1.5"><Label htmlFor="msg">{t("Message from")}{" "}{who(current)}</Label><Input id="msg" value={text} onChange={(e) => setText(e.target.value)} required className="h-11" placeholder={t("Can you call me tomorrow?")} /></div>
              <Button type="submit" disabled={busy || !text.trim()}><Send />{" "}{t("Send inbound")}</Button>
            </form>
          </Panel>
        </Section>
      </div>
    </>
  );
}
