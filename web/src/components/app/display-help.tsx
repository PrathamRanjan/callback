import { useEffect, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { store } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { LangButtons } from "./lang-menu";

import { t } from "@/i18n";
/** "Display and help": the accessibility kit. Settings stay on this device; each one is a class on <html>. */
export interface Display { text: "normal" | "large" | "xl"; contrast: boolean; readable: boolean; calm: boolean; targets: boolean }
const KEY = "cb-display";
const DEF: Display = { text: "normal", contrast: false, readable: false, calm: false, targets: false };

export function loadDisplay(): Display {
  try {
    return { ...DEF, ...(JSON.parse(store.get(KEY) ?? "{}") as Partial<Display>) };
  } catch {
    return DEF;
  }
}
export function applyDisplay(d: Display = loadDisplay()) {
  const c = document.documentElement.classList;
  c.toggle("a11y-large", d.text === "large");
  c.toggle("a11y-xl", d.text === "xl");
  c.toggle("a11y-contrast", d.contrast);
  c.toggle("a11y-dyslexia", d.readable);
  c.toggle("a11y-calm", d.calm);
  c.toggle("a11y-targets", d.targets);
  if (d.readable && !document.getElementById("a11y-font")) {
    const l = document.createElement("link");
    l.id = "a11y-font";
    l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&display=swap";
    document.head.appendChild(l);
  }
}

function Toggle({ id, label, hint, on, set }: { id: string; label: string; hint: string; on: boolean; set: (b: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div>
        <Label id={`${id}-label`} htmlFor={id} className="text-[0.95rem] font-medium">{label}</Label>
        <p id={`${id}-hint`} className="text-sm text-ink-2">{hint}</p>
      </div>
      <Switch id={id} checked={on} onCheckedChange={set} className="mt-1" aria-labelledby={`${id}-label`} aria-describedby={`${id}-hint`} />
    </div>
  );
}

export function DisplayHelp({ open, onOpenChange }: { open: boolean; onOpenChange: (b: boolean) => void }) {
  const [d, setD] = useState<Display>(loadDisplay);
  const [speaking, setSpeaking] = useState(false);
  const canSpeak = typeof window !== "undefined" && "speechSynthesis" in window;
  useEffect(() => {
    applyDisplay(d);
    store.set(KEY, JSON.stringify(d));
  }, [d]);
  const set = <K extends keyof Display>(k: K, v: Display[K]) => setD((x) => ({ ...x, [k]: v }));
  const read = () => {
    if (!canSpeak) return;
    if (speaking) {
      speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }
    const text = (document.getElementById("main")?.innerText ?? "").replace(/\s+/g, " ").slice(0, 6000);
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.95;
    u.onend = () => setSpeaking(false);
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
    setSpeaking(true);
    onOpenChange(false);
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" closeLabel={t("Close display and help")} className="w-full overflow-y-auto bg-surface sm:max-w-[420px]">
        <SheetHeader>
          <SheetTitle>{t("Display and help")}</SheetTitle>
          <SheetDescription>{t("These settings stay on this device. Nothing is sent anywhere.")}</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-8">
          <fieldset className="py-3">
            <legend className="mb-2 text-[0.95rem] font-medium">{t("Language")}</legend>
            <LangButtons />
          </fieldset>
          <fieldset className="py-3">
            <legend className="mb-2 text-[0.95rem] font-medium">{t("Text size")}</legend>
            <div className="grid grid-cols-3 gap-2" role="radiogroup">
              {(["normal", "large", "xl"] as const).map((sz) => (
                <button
                  key={sz}
                  type="button"
                  role="radio"
                  aria-checked={d.text === sz}
                  onClick={() => set("text", sz)}
                  className={cn("h-12 rounded-[8px] border border-line bg-paper font-medium", d.text === sz && "border-brand bg-brand-soft")}
                  style={{ fontSize: sz === "normal" ? "0.95rem" : sz === "large" ? "1.1rem" : "1.25rem" }}
                >
                  {sz === "normal" ? t("Normal") : sz === "large" ? t("Large") : t("Largest")}
                </button>
              ))}
            </div>
          </fieldset>
          <div className="divide-y divide-line">
            <Toggle id="a-contrast" label={t("Stronger contrast")} hint={t("Darker secondary text and borders.")} on={d.contrast} set={(v) => set("contrast", v)} />
            <Toggle id="a-readable" label={t("Easier-to-read letters")} hint={t("Switches to Atkinson Hyperlegible, made for low vision.")} on={d.readable} set={(v) => set("readable", v)} />
            <Toggle id="a-calm" label={t("No movement")} hint={t("Stops the pulsing lamps and every animation.")} on={d.calm} set={(v) => set("calm", v)} />
            <Toggle id="a-targets" label={t("Bigger buttons")} hint={t("Every button and field at least 48 pixels tall.")} on={d.targets} set={(v) => set("targets", v)} />
          </div>
          {canSpeak ? (
            <Button variant="outline" className="mt-4 w-full" onClick={read} aria-pressed={speaking}>
              {speaking ? <VolumeX /> : <Volume2 />} {speaking ? t("Stop reading") : t("Read this page aloud")}
            </Button>
          ) : null}
          <div className="mt-6 rounded-[10px] bg-paper p-4 text-sm text-ink-2">
            <p className="mb-2 font-medium text-ink">{t("Reading the lamps")}</p>
            <ul className="space-y-1.5">
              <li className="flex items-center gap-2"><span className="lamp" data-s="ready" aria-hidden="true" />{t("Ready: a call is planned and allowed.")}</li>
              <li className="flex items-center gap-2"><span className="lamp" data-s="live" aria-hidden="true" />{t("On the line: a call is happening.")}</li>
              <li className="flex items-center gap-2"><span className="lamp" data-s="hold" aria-hidden="true" />{t("Needs you: held for your yes or no.")}</li>
              <li className="flex items-center gap-2"><span className="lamp" data-s="done" aria-hidden="true" />{t("Settled: paid, credited or agreed.")}</li>
              <li className="flex items-center gap-2"><span className="lamp" data-s="off" aria-hidden="true" />{t("Not calling: a rule says no.")}</li>
            </ul>
            <p className="mt-2">{t("Every lamp also has a word next to it, so colour is never the only signal.")}</p>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
