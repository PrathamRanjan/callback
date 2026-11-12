/**
 * The always-loaded switch for hands-free (spec A1.1): a toggle button, the Alt+Shift+H shortcut, and a lazy load of
 * the controller (camera, model, overlay) only when someone turns it on. Off, it costs nothing and changes nothing.
 */
import { Suspense, lazy, useEffect } from "react";
import { Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { setHandsFreeActive, useHandsFreeActive, handsFreeOn } from "./confirm";

const Controller = lazy(() => import("./controller"));

export const toggleHandsFree = () => setHandsFreeActive(!handsFreeOn());

export function HandsFreeHost() {
  const on = useHandsFreeActive();
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.altKey && e.shiftKey && e.code === "KeyH") {
        e.preventDefault();
        toggleHandsFree();
      }
    };
    addEventListener("keydown", k);
    // ?hf=on starts it (a link from /accessibility); ?hf=sim starts it on simulated gaze (tests and the demo).
    const q = new URLSearchParams(location.search).get("hf");
    if (q === "on" || q === "sim") setHandsFreeActive(true);
    return () => removeEventListener("keydown", k);
  }, []);
  if (!on) return null;
  return (
    <Suspense fallback={<div role="status" className="fixed bottom-24 left-3 z-[70] rounded-[10px] border border-line bg-surface px-3 py-2 text-sm shadow lg:bottom-4">{t("Loading hands-free…")}</div>}>
      <Controller onOff={() => setHandsFreeActive(false)} />
    </Suspense>
  );
}

export function HandsFreeToggle({ className }: { className?: string }) {
  const on = useHandsFreeActive();
  return (
    <Button variant={on ? "default" : "ghost"} size="icon" className={className} aria-pressed={on} aria-label={on ? t("Hands-free is on (Alt+Shift+H to stop)") : t("Hands-free: look and say (Alt+Shift+H)")} title={t("Hands-free: look and say (Alt+Shift+H)")} onClick={toggleHandsFree} data-risk="none">
      <Eye />
    </Button>
  );
}
