import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Accessibility, Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useTheme, type ThemePref } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { DisplayHelp } from "./display-help";
import { OfflineBar } from "./bits";
import { LangMenu } from "./lang-menu";

import { t } from "@/i18n";
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-display text-[1.2rem] font-[800] tracking-tight", className)} style={{ fontStretch: "120%" }}>
      <svg viewBox="0 0 24 24" className="size-6" aria-hidden="true">
        <rect x="1" y="1" width="22" height="22" rx="6" fill="var(--brand)" />
        <circle cx="8" cy="12" r="2.6" fill="var(--brand-ink)" />
        <circle cx="16" cy="12" r="2.6" fill="none" stroke="var(--brand-ink)" strokeWidth="2" />
        <path d="M10.6 12h2.8" stroke="var(--brand-ink)" strokeWidth="2" strokeLinecap="round" />
      </svg>
      {t("Callback")}
    </span>
  );
}

export function ThemeMenu() {
  const { pref, setTheme } = useTheme();
  const Icon = pref === "dark" ? Moon : pref === "light" ? Sun : Monitor;
  const opts: { v: ThemePref; label: string; icon: typeof Sun }[] = [
    { v: "system", label: t("Match my device"), icon: Monitor },
    { v: "light", label: t("Light"), icon: Sun },
    { v: "dark", label: t("Dark"), icon: Moon },
  ];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t("Theme: {0}", [pref])}>
          <Icon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t("Theme")}</DropdownMenuLabel>
        {opts.map((o) => (
          <DropdownMenuItem key={o.v} onSelect={() => setTheme(o.v)} aria-checked={pref === o.v} role="menuitemradio">
            <o.icon /> {o.label} {pref === o.v ? <span className="ml-auto text-xs text-ink-2">{t("on")}</span> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Pages a visitor sees without signing in: landing, try, sign-in, the customer's own page. */
export function PublicShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  const [help, setHelp] = useState(false);
  return (
    <div className="min-h-dvh bg-paper text-ink">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-md focus:bg-surface focus:px-3 focus:py-2">{t("Skip to content")}</a>
      <OfflineBar />
      <header className="border-b border-line">
        {/* Wraps instead of scrolling sideways at 320 px with the Largest text setting (spec A7 reflow). */}
        <div className={cn("mx-auto flex min-h-16 flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2", wide ? "max-w-[1180px]" : "max-w-[720px]")}>
          <Link to="/" aria-label={t("Callback home")}><Wordmark /></Link>
          <span className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
            <Button asChild variant="ghost" size="sm"><Link to="/judge">{t("For judges")}</Link></Button>
            <LangMenu showName />
            <Button variant="ghost" size="icon" aria-label={t("Display and help")} onClick={() => setHelp(true)}><Accessibility /></Button>
            <ThemeMenu />
          </span>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="outline-none">{children}</main>
      <DisplayHelp open={help} onOpenChange={setHelp} />
    </div>
  );
}
