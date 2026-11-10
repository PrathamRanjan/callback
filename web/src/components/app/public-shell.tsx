import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Accessibility, Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useTheme, type ThemePref } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { DisplayHelp } from "./display-help";
import { OfflineBar } from "./bits";

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-display text-[1.2rem] font-[800] tracking-tight", className)} style={{ fontStretch: "120%" }}>
      <svg viewBox="0 0 24 24" className="size-6" aria-hidden="true">
        <rect x="1" y="1" width="22" height="22" rx="6" fill="var(--brand)" />
        <circle cx="8" cy="12" r="2.6" fill="var(--brand-ink)" />
        <circle cx="16" cy="12" r="2.6" fill="none" stroke="var(--brand-ink)" strokeWidth="2" />
        <path d="M10.6 12h2.8" stroke="var(--brand-ink)" strokeWidth="2" strokeLinecap="round" />
      </svg>
      Callback
    </span>
  );
}

export function ThemeMenu() {
  const { pref, setTheme } = useTheme();
  const Icon = pref === "dark" ? Moon : pref === "light" ? Sun : Monitor;
  const opts: { v: ThemePref; label: string; icon: typeof Sun }[] = [
    { v: "system", label: "Match my device", icon: Monitor },
    { v: "light", label: "Light", icon: Sun },
    { v: "dark", label: "Dark", icon: Moon },
  ];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Theme: ${pref}`}>
          <Icon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        {opts.map((o) => (
          <DropdownMenuItem key={o.v} onSelect={() => setTheme(o.v)} aria-checked={pref === o.v} role="menuitemradio">
            <o.icon /> {o.label} {pref === o.v ? <span className="ml-auto text-xs text-ink-2">on</span> : null}
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
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-md focus:bg-surface focus:px-3 focus:py-2">Skip to content</a>
      <OfflineBar />
      <header className="border-b border-line">
        <div className={cn("mx-auto flex h-16 items-center gap-2 px-4", wide ? "max-w-[1180px]" : "max-w-[720px]")}>
          <Link to="/" aria-label="Callback home"><Wordmark /></Link>
          <span className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="icon" aria-label="Display and help" onClick={() => setHelp(true)}><Accessibility /></Button>
            <ThemeMenu />
          </span>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="outline-none">{children}</main>
      <DisplayHelp open={help} onOpenChange={setHelp} />
    </div>
  );
}
