import { Languages } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { LANGS, langInfo, setLang, t, useLang, type Lang } from "@/i18n";
import { cn } from "@/lib/utils";

/** On a phone the header has room for a short code only; the full name shows from tablet width up. */
const SHORT: Record<string, string> = { en: "EN", "hi-IN": "हिं", "id-ID": "ID", "pt-BR": "PT" };

/** The language picker. Each name is written in its own language, so anyone can find theirs. */
export function LangMenu({ showName = false }: { showName?: boolean }) {
  const lang = useLang();
  const cur = langInfo(lang === "pseudo" ? "en" : lang);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size={showName ? "sm" : "icon"} aria-label={`${t("Language")}: ${cur.name}`} data-hf="lang">
          <Languages />
          {showName ? <><span className="text-sm sm:hidden" aria-hidden="true">{SHORT[cur.code]}</span><span className="hidden text-sm sm:inline">{cur.name}</span></> : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-[18rem]">
        <DropdownMenuLabel>{t("Language")}</DropdownMenuLabel>
        {LANGS.map((l) => (
          <DropdownMenuItem key={l.code} lang={l.code} onSelect={() => void setLang(l.code)} role="menuitemradio" aria-checked={lang === l.code}>
            <span className={cn(lang === l.code && "font-semibold")}>{l.name}</span>
            {lang === l.code ? <span className="ml-auto text-xs text-ink-2">{t("on")}</span> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <p className="px-2 py-1.5 text-xs text-ink-2">{t("Hindi, Indonesian and Portuguese were translated by AI and not yet checked by a person.")}</p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The same choice as big buttons, for the first screen and Display and help. */
export function LangButtons() {
  const lang = useLang();
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("Language")}>
      {LANGS.map((l) => (
        <button
          key={l.code}
          type="button"
          role="radio"
          lang={l.code}
          aria-checked={lang === l.code}
          onClick={() => void setLang(l.code as Lang)}
          className={cn("min-h-11 rounded-[8px] border border-line bg-paper px-3 text-[0.95rem] font-medium", lang === l.code && "border-brand bg-brand-soft")}
        >
          {l.name}
        </button>
      ))}
    </div>
  );
}

/** A small label for payment, consent and legal text shown in a language a person hasn't checked (spec B2.4). */
export function MachineTranslated({ className }: { className?: string }) {
  const lang = useLang();
  if (lang === "en" || lang === "pseudo") return null;
  return <span className={cn("inline-block rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[0.7rem] font-medium text-ink-2", className)}>{t("Machine-translated")}</span>;
}
