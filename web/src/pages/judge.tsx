import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, Check, CircleCheck, Copy, Loader2, QrCode } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PublicShell } from "@/components/app/public-shell";
import { ErrorState, Panel, Rows } from "@/components/app/bits";
import { act, getJson } from "@/lib/api";
import { useData, useSession, useTitle } from "@/lib/hooks";
import { when } from "@/lib/format";

interface Step { key: string; title: string; detail: string; href: string | null; button: string }
interface Path { id: string; title: string; minutes: number; needs_login: false | string; steps: Step[] }
export interface LiveRow { piece: string; live: boolean; detail: string }
interface Judge {
  app_url: string;
  demo: boolean;
  workspace: { expires_at: string; join_url: string | null; qr_svg: string | null } | null;
  signed_in_as: string | null;
  checklist: Record<string, string>;
  paths: Path[];
  live: LiveRow[];
  accounts: { buyer: { email: string; password: string | null } | null; note: string };
  pages: { href: string; title: string; body: string }[];
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={`Copy ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          toast.error("Couldn't copy here. Select the text instead.");
        }
      }}
    >
      {done ? <Check /> : <Copy />} {done ? "Copied" : "Copy"}
    </Button>
  );
}

export function LiveTable({ rows }: { rows: LiveRow[] }) {
  return (
    <Panel className="overflow-x-auto">
      <Table>
        <TableHeader><TableRow><TableHead>Piece</TableHead><TableHead>Now</TableHead><TableHead>Detail</TableHead></TableRow></TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.piece}>
              <TableCell className="font-medium">{r.piece}</TableCell>
              <TableCell><span className="inline-flex items-center gap-1.5 whitespace-nowrap"><span className="lamp" data-s={r.live ? "live" : "idle"} aria-hidden="true" />{r.live ? "Live" : "Simulated"}</span></TableCell>
              <TableCell className="text-ink-2">{r.detail}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
}

export default function JudgePage() {
  useTitle("For judges");
  const nav = useNavigate();
  const { reload: reloadSession } = useSession();
  const { data: d, error, loading, reload } = useData<Judge>("/api/public/judge", { poll: 4000 });
  const [busy, setBusy] = useState<string | null>(null);

  /** Opens a step's screen. Without a demo yet, it first builds the visitor's private copy (a few seconds). */
  const open = async (step: Step) => {
    setBusy(step.key);
    try {
      let href = step.href;
      if (d?.signed_in_as !== "owner") {
        await act("/demo/signin-as", { role: "owner" });
        await reloadSession();
        const fresh = await getJson<Judge>("/api/public/judge");
        href = fresh.paths.flatMap((p) => p.steps).find((s) => s.key === step.key)?.href ?? null;
        await reload();
      }
      if (!href) throw new Error("That screen isn't in your demo. Reset it from the ribbon at the top of the app, then try again.");
      nav(href);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <PublicShell wide>
      <div className="mx-auto max-w-[1080px] px-4 py-8">
        {error && !d ? <ErrorState error={error} retry={reload} /> : loading && !d ? <Rows n={6} /> : d ? (
          <>
            <h1 className="font-display text-h1 font-[800]" style={{ fontStretch: "115%" }}>For judges</h1>
            <p className="mt-2 max-w-[68ch] text-ink-2">Callback is an AI agent that phones a small studio's customers about money and settles it through PayPal. The AI talks; ordinary code decides what money may move; PayPal moves it. Pick a path below. Each step opens the exact screen, with any text already typed, and ticks itself here when the server records it.</p>
            <p className="mt-2 max-w-[68ch] text-sm text-ink-2">Three things to look at: a held move the owner approves while the customer waits on the line; the call's transcript decisions with their probabilities; and <a href="/accessibility" className="underline">accessibility</a> (axe on every journey, 200% text, keyboard only, voice input on Ask), with the dates each check ran.</p>

            <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_auto] [&>*]:min-w-0">
              <Panel className="p-4">
                <h2 className="text-lg font-semibold">Accounts</h2>
                <dl className="mt-2 grid gap-3 text-sm">
                  <div>
                    <dt className="font-medium">The studio owner</dt>
                    <dd className="text-ink-2">No password: the first step of any path signs you in to your own private copy of the demo studio. Nobody else sees it; it is deleted after two days without a visit.</dd>
                  </div>
                  <div>
                    <dt className="font-medium">PayPal sandbox buyer</dt>
                    <dd className="text-ink-2">{d.accounts.note}</dd>
                    {d.accounts.buyer ? (
                      <dd className="mt-2 flex flex-wrap items-center gap-2 font-mono text-xs">
                        <span className="break-all">{d.accounts.buyer.email}</span><CopyButton text={d.accounts.buyer.email} label="buyer email" />
                        {d.accounts.buyer.password ? <><span className="break-all">{d.accounts.buyer.password}</span><CopyButton text={d.accounts.buyer.password} label="buyer password" /></> : null}
                      </dd>
                    ) : null}
                  </div>
                </dl>
              </Panel>
              <Panel className="p-4 md:w-[260px]">
                <h2 className="flex items-center gap-2 text-lg font-semibold"><QrCode className="size-5" aria-hidden="true" /> On your phone</h2>
                {d.workspace?.qr_svg && d.workspace.join_url ? (
                  <>
                    <div className="mx-auto mt-2 w-[180px] rounded-md bg-white p-2" role="img" aria-label="QR code that opens your demo on a phone" dangerouslySetInnerHTML={{ __html: d.workspace.qr_svg }} />
                    <div className="mt-2 flex min-w-0 items-center gap-2"><span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-2">{d.workspace.join_url}</span><CopyButton text={d.workspace.join_url} label="phone link" /></div>
                  </>
                ) : <p className="mt-2 text-sm text-ink-2">Start any path and a QR code appears here that opens the same private demo on your phone.</p>}
              </Panel>
            </div>

            {d.signed_in_as === "staff" ? <p className="mt-4 rounded-md bg-hold-soft px-3 py-2 text-sm">You're signed in as the front desk. These paths use the owner; the first step switches you.</p> : null}

            <h2 className="mt-8 text-h2 font-semibold">Paths</h2>
            <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-3 [&>*]:min-w-0">
              {d.paths.map((p) => {
                const done = p.steps.filter((s) => d.checklist[s.key]).length;
                return (
                  <Panel key={p.id} className="flex flex-col p-4" data-path={p.id}>
                    <div className="flex items-baseline justify-between gap-2">
                      <h3 className="text-lg font-semibold">{p.title}</h3>
                      <span className="num whitespace-nowrap text-sm text-ink-2">about {p.minutes} min</span>
                    </div>
                    <p className="text-sm text-ink-2">{p.needs_login ? p.needs_login : "No PayPal login."} <span className="num" aria-live="polite">{done} of {p.steps.length} done</span></p>
                    <ol className="mt-3 grid gap-3">
                      {p.steps.map((s, i) => {
                        const at = d.checklist[s.key];
                        return (
                          <li key={s.key} className="flex gap-3" data-step={s.key} data-done={at ? "1" : "0"}>
                            <span style={at ? { color: "var(--lamp-done)" } : undefined} className={at ? "mt-0.5" : "num mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-line text-sm"} aria-hidden="true">{at ? <CircleCheck className="size-6" /> : i + 1}</span>
                            <div className="min-w-0 flex-1">
                              <p className="font-medium">{s.title}{at ? <span className="sr-only"> (done)</span> : null}</p>
                              <p className="text-sm text-ink-2">{s.detail}</p>
                              {at ? <p className="mt-1 text-xs text-ink-2">Done {when(at)}</p> : null}
                              <Button type="button" size="sm" variant={at ? "outline" : "default"} className="mt-2 h-auto min-h-11 max-w-full whitespace-normal py-2 text-left" disabled={busy !== null} onClick={() => void open(s)}>
                                {busy === s.key ? <Loader2 className="animate-spin" /> : <ArrowRight />} {s.button}
                              </Button>
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  </Panel>
                );
              })}
            </div>

            <h2 className="mt-8 text-h2 font-semibold">What is live, what is simulated</h2>
            <p className="mt-1 text-sm text-ink-2">Built from this server's configuration when you opened the page.</p>
            <div className="mt-3"><LiveTable rows={d.live} /></div>

            <h2 className="mt-8 text-h2 font-semibold">Pages you can read without signing in</h2>
            <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {d.pages.map((p) => (
                <li key={p.href}><Link to={p.href} className="block h-full rounded-lg border border-line bg-surface p-4 hover:bg-surface-2"><span className="font-medium">{p.title}</span><span className="mt-1 block text-sm text-ink-2">{p.body}</span></Link></li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </PublicShell>
  );
}
