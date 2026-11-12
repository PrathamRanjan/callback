import { confirmAction } from "@/handsfree/confirm";
import { useState, type ReactNode } from "react";
import { AlertTriangle, Loader2, RefreshCw, WifiOff } from "lucide-react";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { act, ApiError } from "@/lib/api";
import { LAMP_LABEL, money, type LampState } from "@/lib/format";
import { useOnline } from "@/lib/hooks";
import { cn } from "@/lib/utils";

import { t } from "@/i18n";
/** A switchboard lamp. Always paired with a text label (visible or for screen readers): never colour alone. */
export function Lamp({ s, label, showLabel = false, className }: { s: LampState; label?: string; showLabel?: boolean; className?: string }) {
  const text = label ?? LAMP_LABEL[s];
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span className="lamp" data-s={s} aria-hidden="true" />
      {showLabel ? <span className="text-sm font-medium">{text}</span> : <span className="sr-only">{text}</span>}
    </span>
  );
}

export function StateChip({ s, children }: { s: LampState; children?: ReactNode }) {
  const bg: Record<LampState, string> = { ready: "bg-ready-soft", live: "bg-live-soft", hold: "bg-hold-soft", done: "bg-done-soft", off: "bg-off-soft", idle: "bg-surface-2" };
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium text-ink whitespace-nowrap num", bg[s])}>
      <span className="lamp scale-75" data-s={s} aria-hidden="true" />
      {children ?? LAMP_LABEL[s]}
    </span>
  );
}

export const Money = ({ cents, className }: { cents: number | null | undefined; className?: string }) => <span className={cn("num font-medium", className)}>{money(cents)}</span>;

/** Every screen answers: what happened, what needs me, what happens next. */
export function PageHead({ title, kicker, happened, needs, next, actions }: { title: string; kicker?: ReactNode; happened?: ReactNode; needs?: ReactNode; next?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0">
        {kicker ? <div className="mb-1 text-sm text-ink-2 num">{kicker}</div> : null}
        <h1 className="text-[1.75rem] font-[750] md:text-h1">{title}</h1>
        {happened || needs || next ? (
          <dl className="mt-3 grid gap-1 text-[0.95rem] text-ink-2 sm:grid-cols-[auto_1fr] sm:gap-x-3">
            {happened ? (<><dt className="font-medium text-ink">{t("What happened")}</dt><dd>{happened}</dd></>) : null}
            {needs ? (<><dt className="font-medium text-ink">{t("Needs you")}</dt><dd>{needs}</dd></>) : null}
            {next ? (<><dt className="font-medium text-ink">{t("Next")}</dt><dd>{next}</dd></>) : null}
          </dl>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

export function Section({ title, hint, children, actions, id, className }: { title: string; hint?: ReactNode; children: ReactNode; actions?: ReactNode; id?: string; className?: string }) {
  return (
    <section id={id} className={cn("mb-8", className)} aria-labelledby={id ? `${id}-h` : undefined}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id={id ? `${id}-h` : undefined} className="text-lg font-[700] md:text-xl">{title}</h2>
          {hint ? <p className="text-sm text-ink-2">{hint}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Panel({ children, className, ...rest }: { children?: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("rounded-[10px] border border-line bg-surface", className)} {...rest}>
      {children}
    </div>
  );
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <Panel className="flex flex-col items-start gap-2 border-dashed p-6">
      <div className="flex items-center gap-2 font-medium">
        {icon ?? <span className="lamp" data-s="idle" aria-hidden="true" />}
        {title}
      </div>
      {children ? <div className="text-sm text-ink-2">{children}</div> : null}
    </Panel>
  );
}

export function ErrorState({ error, retry }: { error: ApiError | Error; retry?: () => void }) {
  const offline = error instanceof ApiError && error.status === 0;
  return (
    <Panel role="alert" className="flex flex-col items-start gap-3 border-off/40 bg-off-soft p-5">
      <div className="flex items-center gap-2 font-medium">
        {offline ? <WifiOff className="size-4" /> : <AlertTriangle className="size-4" />}
        {offline ? t("You're offline") : t("This didn't load")}
      </div>
      <p className="text-sm">{error.message}{" "}{t("Nothing was changed.")}</p>
      {retry ? (
        <Button variant="outline" size="sm" onClick={retry}>
          <RefreshCw />{" "}{t("Try again")}
        </Button>
      ) : null}
    </Panel>
  );
}

export function Rows({ n = 4 }: { n?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label={t("Loading")}>
      {Array.from({ length: n }, (_, i) => (
        <Skeleton key={i} className="h-16 w-full rounded-[10px] bg-surface-2" />
      ))}
    </div>
  );
}

export function OfflineBar() {
  const on = useOnline();
  if (on) return null;
  return (
    <div role="status" className="sticky top-0 z-50 flex items-center justify-center gap-2 bg-hold px-4 py-2 text-sm font-medium text-white">
      <WifiOff className="size-4" />{" "}{t("You're offline. You can read what's here; nothing will be sent until you're back.")}
    </div>
  );
}

/**
 * A button that posts to an action route, shows a toast with the server's own words, then reloads data or
 * follows the server's redirect. Money buttons say what they move ("Send $420.00 link").
 */
export function ActButton({ path, fields, children, onDone, follow = false, variant, size, className, confirmText, disabled, icon }: {
  path: string;
  fields?: Record<string, string | number | boolean | null | undefined>;
  children: ReactNode;
  onDone?: (r: { message: string; to?: string }) => void;
  follow?: boolean;
  variant?: React.ComponentProps<typeof Button>["variant"];
  size?: React.ComponentProps<typeof Button>["size"];
  className?: string;
  confirmText?: string;
  disabled?: boolean;
  icon?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  return (
    <Button
      variant={variant}
      size={size}
      className={className}
      disabled={busy || disabled}
      aria-busy={busy}
      data-act={path}
      data-confirm={confirmText}
      onClick={async (e) => {
        // Hands-free asks on its own confirm card (a native dialog can't be pressed by gaze); otherwise the browser's.
        if (confirmText && !(await confirmAction(confirmText, e.currentTarget))) return;
        setBusy(true);
        try {
          const r = await act(path, fields);
          if (r.external && r.to) {
            window.location.href = r.to;
            return;
          }
          if (r.message) toast.success(r.message);
          onDone?.(r);
          if (follow && r.to) nav(r.to.split("?")[0]);
        } catch (e) {
          toast.error((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Loader2 className="animate-spin" /> : icon}
      {children}
    </Button>
  );
}

export function Kpi({ label, value, hint, s }: { label: string; value: ReactNode; hint?: ReactNode; s?: LampState }) {
  return (
    <Panel className="flex min-w-0 flex-col gap-1 p-4">
      <div className="flex items-center gap-2 text-sm text-ink-2">
        {s ? <span className="lamp scale-75" data-s={s} aria-hidden="true" /> : null}
        {label}
      </div>
      <div className="kpi-value font-display text-[1.75rem] font-[750] leading-none num">{value}</div>
      {hint ? <div className="text-xs text-ink-2">{hint}</div> : null}
    </Panel>
  );
}

export function Avatar({ name, s }: { name?: string | null; s?: LampState }) {
  const init = (name ?? "?").split(/\s+/).map((w) => w[0] ?? "").join("").replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase();
  return (
    <span className="relative inline-flex size-10 flex-none items-center justify-center rounded-full border border-line bg-surface-2 text-sm font-semibold" aria-hidden="true">
      {init}
      {s ? <span className="lamp absolute -right-0.5 -bottom-0.5 scale-90 ring-2 ring-surface" data-s={s} /> : null}
    </span>
  );
}

/**
 * A row of filter buttons. These pages filter one list rather than switch panels, so they are a labelled group of
 * pressed/unpressed buttons, not ARIA tabs (axe flagged tabs whose aria-controls pointed at panels that never exist).
 * Unpressed labels use the body ink colour so they keep AA contrast in both themes.
 */
export function Segmented<T extends string>({ value, onChange, label, options, className }: { value: T; onChange: (v: T) => void; label: string; options: { v: T; label: ReactNode }[]; className?: string }) {
  return (
    <div role="group" aria-label={label} className={cn("inline-flex w-fit flex-wrap items-center gap-1 rounded-lg bg-surface-2 p-[3px]", className)}>
      {options.map((o) => (
        <button key={o.v} type="button" aria-pressed={o.v === value} onClick={() => onChange(o.v)} className={cn("inline-flex min-h-10 items-center rounded-md px-3 text-sm font-medium text-ink transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand", o.v === value ? "bg-surface font-semibold shadow-sm" : "hover:bg-surface/60")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
