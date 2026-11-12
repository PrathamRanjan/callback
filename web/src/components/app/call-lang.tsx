import { useState } from "react";
import { Languages, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { postJson } from "@/lib/api";
import { LANGS, langInfo, t, useLang, type Lang } from "@/i18n";
import { MachineTranslated } from "./lang-menu";

interface Tr { lines: { at: string; who: string; text: string }[]; model: string; at: string; from: string }

const nameOf = (code: string | null | undefined) => LANGS.find((l) => l.code === code)?.name ?? null;

/** "Spoken in Português (Brasil)": the language the call was in, detected from the customer's first words. */
export function CallLangChip({ lang }: { lang: string | null | undefined }) {
  const n = nameOf(lang);
  if (!n) return null;
  return <span className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs text-ink-2"><Languages className="size-3.5" aria-hidden="true" />{t("Spoken in {0}", [n])}</span>;
}

/**
 * The transcript in the reader's language (spec item 5.2). The original stays above as spoken; this is a machine
 * translation made on request and kept on the call.
 */
export function CallTranslation({ callId, callLang, lines, cached }: { callId: string; callLang: string | null; lines: number; cached: Record<string, Tr> }) {
  const ui = useLang();
  const to: Exclude<Lang, "pseudo"> = ui === "pseudo" ? "en" : ui;
  const [tr, setTr] = useState<Tr | null>(cached?.[to] && cached[to].lines.length === lines ? cached[to] : null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const from = callLang ?? "en";
  if (!lines || from === to) return null;
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      setTr((await postJson<{ translation: Tr }>(`/api/app/calls/${callId}/translate`, { lang: to })).translation);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-3 rounded-[14px] border border-line p-3" lang={to}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{t("In {0}", [langInfo(to).name])}</h3>
        <MachineTranslated />
        {!tr ? (
          <Button size="sm" variant="outline" className="ml-auto" onClick={go} disabled={busy} data-hf-action="translate">
            {busy ? <Loader2 className="animate-spin" /> : <Languages />} {t("Translate this call into {0}", [langInfo(to).name])}
          </Button>
        ) : null}
      </div>
      <p className="mt-1 text-sm text-ink-2">{t("The call is kept exactly as it was spoken, in {0}. This translation is for reading only.", [nameOf(from) ?? from])}</p>
      {err ? <p role="alert" className="mt-2 text-sm text-off">{err}</p> : null}
      {tr ? (
        <ol className="mt-2 space-y-1.5">
          {tr.lines.map((l, i) => (
            <li key={i} className="text-[0.95rem]"><b className="mr-1">{l.who === "agent" ? t("Callback") : t("Customer")}:</b>{l.text}</li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
