import { Bot, Phone, ShieldCheck, User, Wallet } from "lucide-react";
import { money, type LampState } from "@/lib/format";
import { cn } from "@/lib/utils";

import { t, tmap } from "@/i18n";
/**
 * The signature element: a three-lane call score. Voice (what was said), Rules (what the gate checked) and Money
 * (what PayPal did) share one time axis, so one row is one moment of the call seen three ways. On phones the
 * lanes collapse into a single column and each entry carries its lane name.
 */
export interface Turn { who: "agent" | "customer" | "system"; text: string; at: string; quarantined?: string[]; tool?: string | null }
export interface Step { seq: number; actor: string; tool: string; gate: string | null; policy: string | null; args: any; result: any; pp_request_id: string | null; pp_debug_id: string | null; duration_ms: number | null; at: string }

const TOOL: Record<string, string> = tmap({
  "orders.create": "PayPal order created", "orders.capture": "Payment captured", "orders.get": "Order read back",
  "invoices.create": "PayPal invoice drafted", "invoices.send": "Invoice sent", "invoices.get": "Invoice read back",
  "catalog.products.create": "Plan product created", "billing.plans.create": "Instalment plan created", "billing.subscriptions.create": "Subscription created",
  "payments.captures.refund": "Refund sent through PayPal", "refund.by_hand": "Refund to pay back by hand", "credit.apply": "Class credit applied",
  "gate.charge": "Money gate: charge", "gate.invoice": "Money gate: invoice", "gate.plan": "Money gate: plan", "gate.discount": "Money gate: discount", "gate.refund": "Money gate: refund",
  "consent.check": "Consent on file", "consent.allow": "Allowed to call", "consent.block": "Not allowed to call", "consent.revoke": "Customer said stop",
  "kill.check": "Kill switches clear", "planner.candidates": "Planner picked this call", "safety.agent_line": "Agent line replaced (unsafe wording)",
  "callback.schedule": "Call-back booked", "call.end": "Call ended", "read_back.done": "Read back from PayPal", "read_back.error": "Read-back failed", error: "Error",
});
export const toolWord = (tool: string) => TOOL[tool] ?? tool.replace(/^brain\./, "Brain: ").replace(/[._]/g, " ");

const GATE: Record<string, LampState> = { allowed: "done", held: "hold", denied: "off", dry_run_refused: "off", "n/a": "idle" };
const GATE_WORD: Record<string, string> = tmap({ allowed: "Allowed", held: "Held for you", denied: "Refused", dry_run_refused: "Refused before PayPal", "n/a": "Checked" });

type Lane = "voice" | "rules" | "money";
interface Row { at: string; lane: Lane; key: string; node: React.ReactNode }

function laneOf(s: Step): Lane | null {
  if (s.actor === "paypal" || /^(orders|invoices|billing|catalog|payments)\.|^refund\.|^credit\.|^read_back/.test(s.tool)) return "money";
  if (s.tool === "speech" || s.actor === "customer" || s.actor === "voice") return null; // already in the transcript
  if (s.tool.startsWith("brain.")) return "rules";
  return "rules";
}

function ids(s: Step) {
  const r = s.result ?? {};
  const id = r.id ?? r.order_id ?? r.capture_id ?? r.invoice_id ?? r.subscription_id ?? r.refund_id ?? null;
  return (
    <span className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[0.72rem] text-ink-2">
      {id ? <span>{t("id")}{" "}{String(id)}</span> : null}
      {r.status ? <span>{t("status")}{" "}{String(r.status)}</span> : null}
      {s.pp_debug_id ? <span>{t("debug")}{" "}{s.pp_debug_id}</span> : null}
    </span>
  );
}

function stepNode(s: Step, lane: Lane) {
  const cents = s.args?.cents ?? s.args?.amount_cents ?? s.result?.cents ?? null;
  if (s.tool.startsWith("brain.")) {
    const a = s.result ?? {};
    return (
      <div>
        <div className="flex items-center gap-1.5 text-sm font-medium"><Bot className="size-3.5" aria-hidden="true" />{s.tool === "brain.model" ? t("The model proposed") : s.tool === "signals.act" ? t("Code acted on a transcript decision") : t("Rules brain chose")}</div>
        <div className="text-xs text-ink-2">{a.tool && a.tool !== "none" ? t("tool {0}", [a.tool]) : t("no money tool")}{a.reason ? ` · ${String(a.reason).slice(0, 120)}` : ""}</div>
      </div>
    );
  }
  const gate = s.gate && s.gate !== "n/a" ? s.gate : null;
  return (
    <div>
      <div className="flex items-start gap-1.5 text-sm font-medium">
        {gate ? <span className="lamp mt-1 scale-75" data-s={GATE[gate] ?? "idle"} aria-hidden="true" /> : lane === "money" ? <Wallet className="mt-0.5 size-3.5 flex-none" aria-hidden="true" /> : <ShieldCheck className="mt-0.5 size-3.5 flex-none" aria-hidden="true" />}
        <span>{toolWord(s.tool)}{cents ? <span className="num"> · {money(Number(cents))}</span> : null}</span>
      </div>
      {gate ? <div className="text-xs text-ink-2">{GATE_WORD[gate]}{s.policy ? `: ${s.policy}` : ""}</div> : s.policy ? <div className="text-xs text-ink-2">{s.policy}</div> : null}
      {lane === "money" ? ids(s) : null}
    </div>
  );
}

function turnNode(tn: Turn) {
  const Icon = tn.who === "agent" ? Phone : User;
  return (
    <div className={cn("rounded-[10px] px-3 py-2", tn.who === "agent" ? "bg-brand-soft" : "bg-surface-2")}>
      <div className="mb-0.5 flex items-center gap-1.5 text-xs font-semibold text-ink-2"><Icon className="size-3.5" aria-hidden="true" />{tn.who === "agent" ? t("Callback") : t("Customer")}</div>
      <p className="text-[0.95rem] leading-snug">{tn.text}</p>
      {tn.quarantined?.length ? <p className="mt-1 text-xs font-medium text-hold">{t("Ignored as an instruction:")}{" "}{tn.quarantined.join(", ")}</p> : null}
    </div>
  );
}

export function CallScore({ transcript, trace, empty }: { transcript: Turn[]; trace: Step[]; empty?: React.ReactNode }) {
  const rows: Row[] = [];
  transcript.forEach((tn, i) => {
    if (tn.who === "system") rows.push({ at: tn.at, lane: "money", key: `t${i}`, node: <p className="text-sm">{tn.text}</p> });
    else rows.push({ at: tn.at, lane: "voice", key: `t${i}`, node: turnNode(tn) });
  });
  trace.forEach((s) => {
    const lane = laneOf(s);
    if (lane) rows.push({ at: s.at, lane, key: `s${s.seq}`, node: stepNode(s, lane) });
  });
  rows.sort((a, b) => String(a.at).localeCompare(String(b.at)) || (a.lane === "voice" ? -1 : 1));
  const t0 = rows.length ? new Date(rows[0].at).getTime() : 0;
  const stamp = (at: string) => {
    const s = Math.max(0, Math.round((new Date(at).getTime() - t0) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const LANES: { k: Lane; label: string; icon: typeof Phone }[] = [
    { k: "voice", label: "Voice", icon: Phone },
    { k: "rules", label: "Rules", icon: ShieldCheck },
    { k: "money", label: "Money", icon: Wallet },
  ];
  return (
    <div className="overflow-hidden rounded-[14px] border border-line bg-surface" data-tour="call-score">
      <div className="hidden grid-cols-[3.5rem_1.25fr_1fr_1fr] border-b border-line bg-surface-2 text-xs font-semibold uppercase tracking-wide text-ink-2 md:grid" aria-hidden="true">
        <div className="px-3 py-2">{t("Time")}</div>
        {LANES.map((l) => (
          <div key={l.k} className="flex items-center gap-1.5 border-l border-line px-3 py-2" data-tour={l.k === "money" ? "money-lane" : undefined}><l.icon className="size-3.5" />{l.label}</div>
        ))}
      </div>
      {rows.length === 0 ? (
        <div className="p-5 text-sm text-ink-2">{empty ?? t("Nothing has happened on this call yet.")}</div>
      ) : (
        <ol className="divide-y divide-line" aria-label={t("Call score: voice, rules and money, in time order")}>
          {rows.map((r) => (
            <li key={r.key} className="grid grid-cols-[3rem_1fr] md:grid-cols-[3.5rem_1.25fr_1fr_1fr]">
              <div className="px-3 py-3 font-mono text-xs text-ink-2 num">{stamp(r.at)}</div>
              {LANES.map((l) => (
                <div key={l.k} className={cn("min-w-0 px-3 py-3 md:border-l md:border-line", l.k !== r.lane && "hidden md:block")}>
                  {l.k === r.lane ? (
                    <>
                      <span className="mb-1 inline-block text-[0.68rem] font-semibold uppercase tracking-wide text-ink-2 md:hidden">{l.label}</span>
                      {r.node}
                    </>
                  ) : null}
                </div>
              ))}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
