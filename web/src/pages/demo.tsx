import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Clock, Compass, RotateCcw, UserRound, Zap } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ActButton, ErrorState, PageHead, Panel, Rows, Section, StateChip } from "@/components/app/bits";
import { NativeSelect } from "@/components/app/form";
import { act } from "@/lib/api";
import { useData, useSession, useTitle } from "@/lib/hooks";

import { locale, t } from "@/i18n";
interface DemoData { demo: boolean; seeded: boolean; business: { name: string; clock: string | null; tz: string } | null; people: { name: string; role: string }[]; customers: { id: string; name: string }[]; calls: { id: string; label: string }[]; personas: { id: string; purpose: string }[]; faultable: string[]; keys: { owner: string; staff: string } | null }

export default function DemoPage() {
  useTitle(t("Demo controls"));
  const nav = useNavigate();
  const { session, reload: reloadSession } = useSession();
  const owner = session?.me?.role === "owner";
  const { data: d, error, loading, reload } = useData<DemoData>("/api/app/demo");
  const [clock, setClock] = useState("");
  const [cust, setCust] = useState("");
  const [method, setMethod] = useState("");
  const [kind, setKind] = useState("fail_503");
  const [showKeys, setShowKeys] = useState(false);
  const refresh = async () => { await reload(); await reloadSession(); };
  if (error && !d) return <ErrorState error={error} retry={reload} />;
  if (loading && !d) return <Rows n={4} />;
  if (!d) return null;
  if (!d.demo) return <PageHead title={t("Demo controls")} happened={t("Demo mode is off on this server, so these controls are hidden.")} />;
  const switchTo = async (role: "owner" | "staff") => {
    try {
      await act("/demo/signin-as", { role });
      await reloadSession();
      toast.success(t("You're now {0}.", [d.people.find((p) => p.role === role)?.name ?? role]));
      nav(role === "owner" ? "/today" : "/calls");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <>
      <PageHead
        title={t("Demo controls")}
        happened={`${d.business?.name ?? t("The demo studio")}, ${d.business?.clock ? t("clock pinned to {0} studio time", [new Date(d.business.clock).toLocaleString(locale() === "en-US" ? "en-AU" : locale(), { timeZone: d.business.tz, dateStyle: "medium", timeStyle: "short" })]) : t("on real time")}.`}
        next={t("Switch persona, reset the data, move the clock, or make PayPal fail on purpose.")}
        actions={<Button variant="outline" asChild><Link to="/judge"><Compass />{" "}{t("For judges")}</Link></Button>}
      />
      <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <Section id="persona" title={t("Be someone else")}>
          <Panel className="space-y-2 p-4">
            {d.people.map((p) => (
              <div key={p.role} className="flex items-center gap-3">
                <UserRound className="size-4" aria-hidden="true" />
                <span className="flex-1">{p.name} <span className="text-sm text-ink-2">· {p.role === "owner" ? t("owner") : t("front desk")}</span></span>
                {session?.me?.name === p.name ? <StateChip s="done">{t("You")}</StateChip> : <Button size="sm" variant="outline" onClick={() => switchTo(p.role as "owner" | "staff")}>{t("Switch")}</Button>}
              </div>
            ))}
            <p className="pt-1 text-sm text-ink-2">{t("The customer's view opens from any call: \"Their page\".")}</p>
          </Panel>
        </Section>
        <Section id="reset" title={t("Fresh data")}>
          <Panel className="space-y-3 p-4">
            <p className="text-sm">{t("Wipes every demo call, payment record and approval, reseeds the studio and re-plans. PayPal sandbox records already created stay in PayPal.")}</p>
            <div className="flex flex-wrap gap-2">
              <ActButton path="/demo/reset" fields={{ pin: "1" }} icon={<RotateCcw />} confirmText={t("Reset the demo studio? Every demo record is wiped.")} onDone={refresh} disabled={!owner && d.seeded}>{t("Reset, demo morning")}</ActButton>
              <ActButton path="/demo/reset" fields={{ pin: "0" }} variant="outline" confirmText={t("Reset on real time? Some calls may be outside calling hours right now.")} onDone={refresh} disabled={!owner && d.seeded}>{t("Reset, real time")}</ActButton>
            </div>
            {!owner ? <p className="text-xs text-ink-2">{t("Only the owner can reset.")}</p> : null}
          </Panel>
        </Section>
        {owner ? (
          <Section id="again" title={t("Call someone again today")}>
            <Panel className="flex flex-col gap-2 p-4 sm:flex-row sm:items-end">
              <div className="flex-1"><NativeSelect id="cust" label={t("Customer")} value={cust} onChange={(e) => setCust(e.target.value)}><option value="">{t("Pick one")}</option>{d.customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</NativeSelect></div>
              <ActButton path="/demo/call-again" fields={{ customer: cust }} disabled={!cust} variant="outline" follow>{t("Allow again")}</ActButton>
            </Panel>
          </Section>
        ) : null}
        <Section id="clock" title={t("Studio clock")}>
          <Panel className="flex flex-col gap-2 p-4 sm:flex-row sm:items-end">
            <div className="grid flex-1 gap-1.5"><Label htmlFor="clock">{t("Pin to (your device's time zone)")}</Label><Input id="clock" type="datetime-local" value={clock} onChange={(e) => setClock(e.target.value)} className="h-11" /></div>
            <ActButton path="/demo/clock" fields={{ now: clock ? new Date(clock).toISOString() : "" }} variant="outline" icon={<Clock />} onDone={refresh}>{clock ? t("Pin clock") : t("Use real time")}</ActButton>
            <ActButton path="/demo/plan" variant="ghost" onDone={refresh}>{t("Re-plan")}</ActButton>
          </Panel>
        </Section>
        {owner ? (
          <Section id="faults" title={t("Make PayPal fail")} hint={t("Arms one failure on the next call to that PayPal method, to show retries and honest wording.")}>
            <Panel className="flex flex-col gap-2 p-4 sm:flex-row sm:items-end">
              <div className="flex-1"><NativeSelect id="method" label={t("PayPal method")} value={method} onChange={(e) => setMethod(e.target.value)}><option value="">{t("Pick one")}</option>{d.faultable.map((m) => <option key={m}>{m}</option>)}</NativeSelect></div>
              <div className="flex-1"><NativeSelect id="kind" label={t("Failure")} value={kind} onChange={(e) => setKind(e.target.value)}><option value="fail_503">{t("PayPal returns 503")}</option><option value="lose_response">{t("Response lost after PayPal acted")}</option></NativeSelect></div>
              <ActButton path="/demo/fault" fields={{ method, kind }} disabled={!method} variant="outline" icon={<Zap />}>{t("Arm")}</ActButton>
            </Panel>
          </Section>
        ) : null}
        {owner ? (
          <Section id="ai-fault" title={t("Make the AI fail")} hint={t("For two minutes every model call in your demo fails, as if OpenAI were down. Calls end with a fixed line and the outcome ai_failed, Ask says it can't answer, and the scam check says its AI reader did not run. Nothing falls back to rules.")}>
            <Panel className="flex flex-wrap gap-2 p-4">
              <ActButton path="/demo/fault-ai" variant="outline" icon={<Zap />}>{t("Make the AI fail for 2 minutes")}</ActButton>
              <ActButton path="/demo/fault-ai" fields={{ off: "1" }} variant="ghost">{t("Turn the AI back on")}</ActButton>
            </Panel>
          </Section>
        ) : null}
        {owner && d.keys ? (
          <Section id="keys" title={t("Access keys")} hint={t("For the MCP server and the sign-in page. Demo only; shown to the owner.")}>
            <Panel className="p-4">
              {showKeys ? (
                <dl className="grid gap-1 font-mono text-xs"><dt className="font-sans text-sm font-medium">{t("Owner")}</dt><dd className="break-all">{d.keys.owner}</dd><dt className="font-sans text-sm font-medium">{t("Front desk")}</dt><dd className="break-all">{d.keys.staff}</dd></dl>
              ) : <Button variant="outline" size="sm" onClick={() => setShowKeys(true)}>{t("Show demo keys")}</Button>}
            </Panel>
          </Section>
        ) : null}
      </div>
    </>
  );
}
