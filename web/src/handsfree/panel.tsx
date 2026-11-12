/** Hands-free settings in Display and help (spec A1). Everything here stays on this device. */
import { Link } from "react-router-dom";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { setHandsFreeActive, useHandsFreeActive } from "./confirm";
import { lastCalibration, setHf, useHf, type HfMode, type HfVoice } from "./settings";
import { voiceSupported } from "./voice";

function Choice<V extends string>({ label, value, options, onChange }: { label: string; value: V; options: { v: V; label: string }[]; onChange: (v: V) => void }) {
  return (
    <div className="mt-3">
      <div className="mb-1 text-sm text-ink-2" id={`hf-${label}`}>{label}</div>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-labelledby={`hf-${label}`}>
        {options.map((o) => (
          <button key={o.v} type="button" role="radio" aria-checked={value === o.v} onClick={() => onChange(o.v)} className={cn("min-h-11 rounded-[10px] border border-line bg-paper px-3 text-sm", value === o.v && "border-brand bg-brand-soft font-medium")}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function HandsFreeSettings() {
  const on = useHandsFreeActive();
  const s = useHf();
  const cal = lastCalibration();
  return (
    <fieldset className="py-3">
      <legend className="mb-2 text-[0.95rem] font-medium">{t("Hands-free: look and say")}</legend>
      <p className="text-sm text-ink-2">{t("Point with your eyes or head, press by looking (a ring fills), and speak commands. The camera picture is read on this device and never sent. Shortcut: Alt+Shift+H. Esc or “stop” turns it off.")}</p>
      <button type="button" data-risk="none" onClick={() => setHandsFreeActive(!on)} aria-pressed={on} className={cn("mt-3 min-h-11 w-full rounded-[10px] px-4 font-medium", on ? "border border-line bg-paper" : "bg-ink text-paper")}>
        {on ? t("Stop hands-free") : t("Start hands-free")}
      </button>
      <Choice<HfMode> label={t("Point with")} value={s.mode} onChange={(v) => setHf({ mode: v })} options={[{ v: "gaze", label: t("Eyes (calibrate first)") }, { v: "head", label: t("Head") }, { v: "scan", label: t("Keyboard scan, no camera") }]} />
      <Choice<string> label={t("Press after looking for")} value={String(s.dwellMs)} onChange={(v) => setHf({ dwellMs: Number(v) })} options={[{ v: "700", label: t("0.7 s") }, { v: "1100", label: t("1.1 s") }, { v: "1600", label: t("1.6 s") }, { v: "2200", label: t("2.2 s") }]} />
      <Choice<HfVoice> label={t("Voice commands")} value={s.voice} onChange={(v) => setHf({ voice: v })} options={[{ v: "off", label: t("Off") }, { v: "wake", label: t("After saying “Callback”") }, { v: "ptt", label: t("Press Talk first") }]} />
      {s.voice !== "off" && !voiceSupported() ? <p className="mt-2 text-xs text-ink-2">{t("This browser has no speech recognition, so voice commands won't work here.")}</p> : null}
      {s.voice !== "off" ? <p className="mt-2 text-xs text-ink-2">{t("Voice uses your browser's speech recognition (in Chrome, Google's service hears the audio). Callback gets the words only.")}</p> : null}
      <label className="mt-3 flex min-h-11 items-center gap-2 text-sm">
        <input type="checkbox" className="size-5" checked={s.wink} onChange={(e) => setHf({ wink: e.target.checked })} />
        {t("A wink presses too")}
      </label>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input type="checkbox" className="size-5" checked={s.speakBack} onChange={(e) => setHf({ speakBack: e.target.checked })} />
        {t("Say what happened out loud")}
      </label>
      <p className="mt-2 text-xs text-ink-2">
        {cal ? t("This device's last calibration: about {0} px on average.", [cal.meanPx]) : t("Not calibrated on this device yet.")}{" "}
        <Link to="/accessibility#hands-free" className="underline">{t("How it works and how well")}</Link>
      </p>
    </fieldset>
  );
}
