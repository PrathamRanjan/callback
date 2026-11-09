import { useEffect, useState } from "react";
import { store } from "./hooks";

export type ThemePref = "system" | "light" | "dark";
const KEY = "cb-theme";
const listeners = new Set<() => void>();

function systemDark() {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches;
}
export function currentPref(): ThemePref {
  const v = store.get(KEY);
  return v === "light" || v === "dark" ? v : "system";
}
export function applyTheme(pref: ThemePref = currentPref()) {
  const dark = pref === "dark" || (pref === "system" && systemDark());
  document.documentElement.classList.toggle("dark", dark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#111311" : "#f4f1ea");
}
export function setTheme(pref: ThemePref) {
  store.set(KEY, pref);
  applyTheme(pref);
  listeners.forEach((l) => l());
}

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(currentPref());
  const [resolved, setResolved] = useState<"light" | "dark">(document.documentElement.classList.contains("dark") ? "dark" : "light");
  useEffect(() => {
    const sync = () => {
      setPref(currentPref());
      setResolved(document.documentElement.classList.contains("dark") ? "dark" : "light");
    };
    listeners.add(sync);
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onSys = () => {
      if (currentPref() === "system") applyTheme("system");
      sync();
    };
    mq.addEventListener("change", onSys);
    return () => {
      listeners.delete(sync);
      mq.removeEventListener("change", onSys);
    };
  }, []);
  return { pref, resolved, setTheme };
}
