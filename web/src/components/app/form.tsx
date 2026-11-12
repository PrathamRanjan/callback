import { useState, type FormEvent, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { act } from "@/lib/api";

import { t } from "@/i18n";
/** A dialog form that posts to an action route. Errors from the server stay in the dialog, next to the fields. */
export function ActionDialog({ trigger, title, description, path, submit, children, onDone, follow = false, transform }: {
  trigger: ReactNode; title: string; description?: string; path: string; submit: string; children: ReactNode; onDone?: () => void; follow?: boolean;
  transform?: (f: Record<string, string>) => Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nav = useNavigate();
  const go = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const fields: Record<string, string> = {};
    fd.forEach((v, k) => (fields[k] = String(v)));
    setBusy(true);
    setErr(null);
    try {
      const r = await act(path, transform ? transform(fields) : fields);
      toast.success(r.message || t("Saved."));
      setOpen(false);
      onDone?.();
      if (follow && r.to) nav(r.to.split("?")[0]);
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); setErr(null); }}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[92dvh] overflow-y-auto bg-surface sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <form onSubmit={go} className="grid gap-4" noValidate={false}>
          {children}
          {err ? <p role="alert" className="rounded-[10px] bg-off-soft px-3 py-2 text-sm">{err}</p> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>{t("Cancel")}</Button>
            <Button type="submit" disabled={busy} aria-busy={busy}>{busy ? <Loader2 className="animate-spin" /> : null}{submit}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function Field({ id, label, hint, ...rest }: { id: string; label: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={id} className="h-11 text-base md:text-sm" aria-describedby={hint ? `${id}-hint` : undefined} {...rest} />
      {hint ? <p id={`${id}-hint`} className="text-xs text-ink-2">{hint}</p> : null}
    </div>
  );
}

export function NativeSelect({ id, label, children, ...rest }: { id: string; label: string; children: ReactNode } & React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select id={id} name={id} className="h-11 w-full min-w-0 max-w-full truncate rounded-md border border-line bg-surface px-3 text-base md:text-sm" {...rest}>{children}</select>
    </div>
  );
}
