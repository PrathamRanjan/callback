/**
 * Push-to-talk on a text box (spec C, "push-to-talk on every main input"): the same listen-only gpt-live-1 session as
 * Ask. What you say is typed into the box; you check it and press the box's own button. Nothing is sent by talking.
 */
import { Loader2, Mic, MicOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { useDictation } from "@/lib/voice";

export function DictateButton({ onText, action, id }: { onText: (text: string) => void; action: string; id: string }) {
  const d = useDictation(onText, { action });
  return (
    <>
      <Button type="button" variant="outline" onClick={() => void d.toggle()} aria-pressed={d.state === "on"} aria-describedby={`${id}-note`} disabled={d.state === "starting"} data-risk="none">
        {d.state === "on" ? <MicOff /> : d.state === "starting" ? <Loader2 className="animate-spin" /> : <Mic />}
        {d.state === "on" ? t("Stop talking") : t("Talk")}
      </Button>
      <p id={`${id}-note`} role="status" className="basis-full text-xs text-ink-2">{d.note}</p>
    </>
  );
}
