export const money = (cents: number | null | undefined) =>
  cents === null || cents === undefined ? "—" : `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const PURPOSE: Record<string, string> = { confirm_deposit: "Deposit", chase_invoice: "Overdue invoice", cancel_class: "Cancelled class" };
export const PURPOSE_VERB: Record<string, string> = { confirm_deposit: "Confirm the deposit", chase_invoice: "Settle the invoice", cancel_class: "Refund or credit" };

export type LampState = "ready" | "live" | "hold" | "done" | "off" | "idle";
export const LAMP_LABEL: Record<LampState, string> = { ready: "Ready", live: "On the line", hold: "Needs you", done: "Settled", off: "Not calling", idle: "Waiting" };

export function callLamp(status: string, outcome?: string | null): LampState {
  if (status === "planned") return "ready";
  if (status === "in_progress" || status === "ringing") return "live";
  if (status === "blocked") return "off";
  if (status === "skipped") return "idle";
  if (status === "ended") return outcome === "declined" || outcome === "do_not_call" || outcome === "wrong_person" || outcome === "no_answer" ? "idle" : "done";
  return "idle";
}

export function moneyLamp(status: string): LampState {
  if (["paid", "completed", "active", "credited", "refunded", "allowed", "approved"].includes(status)) return "done";
  if (["held", "pending", "unknown", "by_hand"].includes(status)) return "hold";
  if (["sent", "awaiting_approval", "planned", "link_sent", "invoiced", "open", "creating"].includes(status)) return "ready";
  if (["failed", "denied", "declined", "dry_run_refused", "cancelled", "void"].includes(status)) return "off";
  return "idle";
}

export const STATUS_WORD: Record<string, string> = {
  open: "Open", link_sent: "Link sent", invoiced: "Invoiced", planned: "Plan sent", paid: "Paid", credited: "Credited", refunded: "Refunded", void: "Void",
  sent: "Sent, waiting to be paid", creating: "Creating", failed: "Failed", unknown: "Unknown: checking PayPal", awaiting_approval: "Waiting for the customer", active: "Active", cancelled: "Cancelled", by_hand: "Pay back by hand", completed: "Completed", pending: "Waiting for you",
  allowed: "Allowed", held: "Held for you", denied: "Refused", dry_run_refused: "Refused before PayPal", approved: "Approved", declined: "Declined",
};
export const word = (s: string | null | undefined) => (s ? STATUS_WORD[s] ?? s.replace(/_/g, " ") : "");
const OUTCOME: Record<string, string> = { paid_link: "Pay link sent", plan_agreed: "Plan agreed", invoice_sent: "Invoice sent", callback: "Call back booked", credit: "Credited", refund: "Refunded", declined: "Declined", no_answer: "No answer", wrong_person: "Wrong person", do_not_call: "Asked not to be called", held: "Waiting for you" };
export const outcomeWord = (o: string | null | undefined) => (o ? OUTCOME[o] ?? o.replace(/_/g, " ") : "");

export function when(iso: string | null | undefined) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}
export const initials = (n?: string | null) =>
  (n ?? "?").split(/\s+/).map((w) => w[0] ?? "").join("").replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase();
export const city = (tz: string) => tz.split("/").pop()?.replace(/_/g, " ") ?? tz;
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
