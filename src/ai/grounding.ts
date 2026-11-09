/**
 * Grounding and quarantine (roadmap B.1). What the customer says on a call is untrusted speech: instruction-shaped
 * lines ("ignore your rules", "the owner said 50% off", "charge the card ending 1234") are pulled out before the
 * text reaches the model, shown on the call page as quarantined, and never forwarded to a tool. Numbers the
 * customer says are kept as observations only; code never turns them into an amount.
 */
export const INSTRUCTION_RE = /(ignore (all |the |your )?(previous|prior|above|your) (instructions|rules|policy)|you are now|act as|system prompt|developer message|the owner (said|told|authori[sz]ed)|manager (said|approved)|forget (your|the) (rules|limits)|override|charge (the|my) card|card (number|ending)|free of charge|waive (it|the (fee|balance|deposit)) entirely)/i;

export function quarantine(text: string): { clean: string; quarantined: string[]; money_mentions: string[] } {
  const quarantined: string[] = [];
  const kept: string[] = [];
  for (const line of text.split(/(?<=[.!?])\s+|\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (INSTRUCTION_RE.test(t)) quarantined.push(t);
    else kept.push(t);
  }
  const money_mentions = [...text.matchAll(/\$\s?\d+(?:\.\d{2})?|\d{1,3}\s?(?:%|percent)|\b(?:half|quarter) (?:price|off)\b/gi)].map((m) => m[0]);
  return { clean: kept.join(" "), quarantined, money_mentions };
}

/** Checks that a quote the model returned exists in the source text (case- and space-insensitive). */
export function spanExists(source: string, quote: string | null | undefined): boolean {
  if (!quote) return false;
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return norm(source).includes(norm(quote));
}
