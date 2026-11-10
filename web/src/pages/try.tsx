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

interface DemoInfo { demo: boolean; seeded: boolean; business: { name: string } | null; people: { name: string; role: string }[] }

export default function Try() {
  useTitle("Try the demo");
  const nav = useNavigate();
  const [q] = useSearchParams();
  const next = q.get("next");
  const { reload } = useSession();
  const { data } = useData<DemoInfo>("/api/app/demo");
  const [busy, setBusy] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const owner = data?.people.find((p) => p.role === "owner")?.name ?? "the owner";
  const staff = data?.people.find((p) => p.role === "staff")?.name ?? "the front desk";

  const go = async (who: "owner" | "staff" | "customer") => {
    setBusy(who);
    try {
      if (!data?.seeded) await act("/demo/reset", { pin: "1" });
      await act("/demo/signin-as", { role: who === "staff" ? "staff" : "owner" });
      await reload();
      if (who === "customer") {
        const t = await getJson<{ ready: { id: string; purpose: string }[]; finished: { id: string }[] }>("/api/app/today");
        const c = t.ready.find((x) => x.purpose === "confirm_deposit") ?? t.ready[0] ?? t.finished[0];
        const d = c ? await getJson<{ customer: { token: string | null } }>(`/api/app/calls/${c.id}`) : null;
        if (!d?.customer.token) throw new Error("No customer page to show yet. Reset the demo from Demo controls.");
        nav(`/c/${d.customer.token}`);
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
    { id: "owner" as const, icon: Store, t: `${owner}, the owner`, d: "Sees everything: today's calls, money, approvals, rules and the scam guard. Can approve big moves.", cta: "Be the owner" },
    { id: "staff" as const, icon: UserRound, t: `${staff}, front desk`, d: "Runs calls and sees customers. Can't move money or change rules.", cta: "Be the front desk" },
    { id: "customer" as const, icon: Smartphone, t: "A customer", d: "The page a customer opens from Callback's text: what they owe, a PayPal button, a call-back time, a stop button.", cta: "Be the customer" },
  ];

  return (
    <PublicShell>
      <div className="mx-auto max-w-[720px] px-4 py-10">
        <h1 className="font-display text-h1 font-[800]" style={{ fontStretch: "115%" }}>Who do you want to be?</h1>
        <p className="mt-2 text-ink-2">{data?.business?.name ?? "The demo studio"} is a seeded demo studio in Sydney. Payments go through the real PayPal sandbox; nothing real is charged.</p>
        {data && !data.demo ? <p className="mt-3 rounded-[8px] bg-hold-soft p-3 text-sm">Demo mode is off on this server. Sign in with your access key below.</p> : null}
        <ul className="mt-6 grid gap-3">
          {people.map((p) => (
            <li key={p.id}>
              <Panel className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
                <span className="flex size-11 flex-none items-center justify-center rounded-full bg-brand-soft"><p.icon className="size-5" aria-hidden="true" /></span>
                <div className="min-w-0 flex-1">
                  <h2 className="text-lg font-semibold">{p.t}</h2>
                  <p className="text-sm text-ink-2">{p.d}</p>
                </div>
                <Button onClick={() => go(p.id)} disabled={busy !== null || (data ? !data.demo : false)} aria-busy={busy === p.id} className="sm:w-auto">
                  {busy === p.id ? <Loader2 className="animate-spin" /> : null}
                  {p.cta} <ArrowRight />
                </Button>
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
            <div className="flex items-center gap-2 font-semibold"><KeyRound className="size-4" aria-hidden="true" />Have an access key?</div>
            <div className="grid gap-1.5">
              <Label htmlFor="key">Owner or staff key</Label>
              <Input id="key" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" required className="h-11" />
            </div>
            <div><Button type="submit" variant="outline" disabled={busy !== null || !key}>Sign in</Button></div>
          </form>
        </Panel>
      </div>
    </PublicShell>
  );
}
