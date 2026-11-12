import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, KeyRound, Loader2, Smartphone, Store, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PublicShell } from "@/components/app/public-shell";
import { Panel } from "@/components/app/bits";
import { act, getJson } from "@/lib/api";
import { useData, useSession, useTitle } from "@/lib/hooks";
import { startStory, storyContext } from "@/tour/story";

import { t } from "@/i18n";
interface DemoInfo { demo: boolean; seeded: boolean; business: { name: string } | null; people: { name: string; role: string }[] }

export default function Try() {
  useTitle(t("Try the demo"));
  const nav = useNavigate();
  const [q] = useSearchParams();
  const next = q.get("next");
  const { reload } = useSession();
  const { data } = useData<DemoInfo>("/api/app/demo");
  const [busy, setBusy] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const owner = data?.people.find((p) => p.role === "owner")?.name ?? t("the owner");
  const staff = data?.people.find((p) => p.role === "staff")?.name ?? t("the front desk");

  const go = async (who: "owner" | "staff" | "customer", guided = true) => {
    setBusy(who + (guided ? "" : "-own"));
    try {
      const info = data ?? (await getJson<DemoInfo>("/api/app/demo")); // a fast click can beat the first load
      void info;
      await act("/demo/signin-as", { role: who === "staff" ? "staff" : "owner" });
      await reload();
      // Owner and customer start the guided walkthrough (tour/story.ts): first a card saying who you are, then the steps.
      if (who === "customer") {
        const ctx = await storyContext();
        if (!ctx.token) throw new Error(t("No customer page to show yet. Reset the demo from Demo controls."));
        if (guided) startStory("customer", ctx);
        else nav(`/c/${ctx.token}`);
        return;
      }
      if (who === "owner" && guided && !next) {
        startStory("owner", await storyContext());
        return;
      }
      nav(next && next.startsWith("/") ? next : who === "owner" ? "/today" : "/calls");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const people = [
    { id: "owner" as const, icon: Store, t: t("{0}, the owner", [owner]), badge: t("Guided, about 3 minutes"), d: t("Live one day of the studio: your agent calls a customer about a deposit, a charge over your limit waits for you, and PayPal settles it."), cta: t("Start as the owner"), own: true },
    { id: "customer" as const, icon: Smartphone, t: t("A customer"), badge: t("Guided, about 1 minute"), d: t("Open the studio's text, pay on PayPal and check a suspicious message before you pay."), cta: t("Start as the customer"), own: false },
    { id: "staff" as const, icon: UserRound, t: t("{0}, front desk", [staff]), badge: t("On your own"), d: t("Runs calls and sees customers. Can't move money or change rules."), cta: t("Be the front desk"), own: false },
  ];

  return (
    <PublicShell>
      <div className="mx-auto max-w-[720px] px-4 py-10">
        <h1 className="font-display text-h1 font-[800]" style={{ fontStretch: "115%" }}>{t("Who do you want to be?")}</h1>
        <p className="mt-2 text-lead text-ink-2">{t("Pick a role. We'll tell you who you are, then walk you through what your day looks like with Callback.")}</p>
        <p className="mt-2 text-ink-2">{data?.business?.name ?? t("The demo studio")}{" "}{t("is a demo studio in Sydney. Your first tap builds your own private copy of it (a few seconds): nobody else sees what you do, and it is removed after two days without a visit. Payments go through the real PayPal sandbox; nothing real is charged.")}</p>
        {data && !data.demo ? <p className="mt-3 rounded-[8px] bg-hold-soft p-3 text-sm">{t("Demo mode is off on this server. Sign in with your access key below.")}</p> : null}
        <ul className="mt-6 grid gap-3">
          {people.map((p) => (
            <li key={p.id}>
              <Panel className={`flex flex-col gap-3 p-4 sm:flex-row sm:items-center ${p.id === "owner" ? "border-2 border-brand" : ""}`}>
                <span className="flex size-11 flex-none items-center justify-center rounded-full bg-brand-soft"><p.icon className="size-5" aria-hidden="true" /></span>
                <div className="min-w-0 flex-1">
                  <h2 className="text-lg font-semibold">{p.t}</h2>
                  <p className="text-xs font-medium uppercase tracking-wide text-ink-2">{p.badge}</p>
                  <p className="text-sm text-ink-2">{p.d}</p>
                </div>
                <div className="flex flex-col gap-1 sm:items-end">
                  <Button onClick={() => go(p.id)} disabled={busy !== null || (data ? !data.demo : false)} aria-busy={busy === p.id} className="sm:w-auto">
                    {busy === p.id ? <Loader2 className="animate-spin" /> : null}
                    {p.cta} <ArrowRight />
                  </Button>
                  {p.own ? (
                    <Button variant="link" size="sm" className="h-auto min-h-11 px-0" onClick={() => go(p.id, false)} disabled={busy !== null || (data ? !data.demo : false)}>
                      {busy === `${p.id}-own` ? <Loader2 className="animate-spin" /> : null}
                      {t("Skip the walkthrough")}
                    </Button>
                  ) : null}
                </div>
              </Panel>
            </li>
          ))}
        </ul>
        <Panel className="mt-8 p-4">
          <form
            className="flex flex-col gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy("key");
              try {
                const r = await act("/login", { key, next: next ?? "/today" });
                await reload();
                nav(r.to && r.to.startsWith("/") ? r.to : "/today");
              } catch (err) {
                toast.error((err as Error).message);
              } finally {
                setBusy(null);
              }
            }}
          >
            <div className="flex items-center gap-2 font-semibold"><KeyRound className="size-4" aria-hidden="true" />{t("Have an access key?")}</div>
            <div className="grid gap-1.5">
              <Label htmlFor="key">{t("Owner or staff key")}</Label>
              <Input id="key" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" required className="h-11" />
            </div>
            <div><Button type="submit" variant="outline" disabled={busy !== null || !key}>{t("Sign in")}</Button></div>
          </form>
        </Panel>
      </div>
    </PublicShell>
  );
}
