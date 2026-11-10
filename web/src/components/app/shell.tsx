import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  Accessibility, BadgeCheck, BookOpenCheck, CircleDollarSign, Compass, FlaskConical, Inbox, LayoutDashboard, LogOut, Menu, MessagesSquare,  PhoneCall, RotateCcw, Scale, Search, ShieldAlert, Users,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { act } from "@/lib/api";
import { useSession } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { DisplayHelp } from "./display-help";
import { ThemeMenu, Wordmark } from "./public-shell";
import { OfflineBar } from "./bits";
import { startTour } from "@/tour/tours";

interface NavItem { to: string; label: string; icon: typeof Inbox; owner?: boolean; tour?: string }
export const NAV: NavItem[] = [
  { to: "/today", label: "Today", icon: LayoutDashboard, tour: "nav-today" },
  { to: "/calls", label: "Calls", icon: PhoneCall, tour: "nav-calls" },
  { to: "/approvals", label: "Needs you", icon: Inbox, owner: true, tour: "nav-approvals" },
  { to: "/customers", label: "Customers", icon: Users },
  { to: "/money", label: "Money", icon: CircleDollarSign, owner: true, tour: "nav-money" },
  { to: "/rules", label: "Rules", icon: Scale, owner: true },
  { to: "/safety", label: "Scam guard", icon: ShieldAlert, owner: true },
  { to: "/messages", label: "Messages", icon: MessagesSquare, owner: true },
  { to: "/proof", label: "Proof", icon: BadgeCheck, tour: "nav-proof" },
  { to: "/demo", label: "Demo controls", icon: FlaskConical },
];

/** Small, honest, always visible in demo mode: which parts are real sandbox calls and which are simulated. */
export function DemoRibbon() {
  const { session, reload } = useSession();
  const nav = useNavigate();
  if (!session?.demo) return null;
  const i = session.integrations;
  const live = [i.paypal ? `PayPal ${i.paypal}` : null, i.brain === "model" ? "AI model" : null].filter(Boolean).join(" · ");
  // Demo numbers are fictional, so calls and texts to them stay in the simulator even when Twilio is connected.
  const sim = [i.phone ? "calls to demo numbers" : "phone calls", i.sms ? "texts to demo numbers" : "SMS"];
  return (
    <div className="border-b border-line bg-surface-2 text-[0.8rem] text-ink" role="note" aria-label="Demo status">
      <div className="mx-auto flex max-w-[1240px] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5">
        <span className="font-semibold">Demo studio</span>
        <span className="inline-flex items-center gap-1.5"><span className="lamp scale-75" data-s="live" aria-hidden="true" />Live: {live || "nothing external"}</span>
        <span className="inline-flex items-center gap-1.5"><span className="lamp scale-75" data-s="idle" aria-hidden="true" />Simulated: {sim.join(", ")}{session.business?.pinned ? ", the clock" : ""}</span>
        {session.business ? <span className="num text-ink-2">Studio time {session.business.clock_local}</span> : null}
        <span className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" className="h-8 px-2 text-[0.8rem]" onClick={() => startTour("judge", nav, true)}>
            <Compass /> Judge tour
          </Button>
          {session.me?.role === "owner" ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-[0.8rem]"
              onClick={async () => {
                if (!window.confirm("Reset the demo studio to fresh data? Every demo call and payment record is wiped and the clock is pinned to the demo morning.")) return;
                try {
                  const r = await act("/demo/reset", { pin: "1" });
                  toast.success(r.message || "Demo reset.");
                  await reload();
                  nav("/today");
                } catch (e) {
                  toast.error((e as Error).message);
                }
              }}
            >
              <RotateCcw /> Reset
            </Button>
          ) : null}
        </span>
      </div>
    </div>
  );
}

function SideLink({ item, pending, onClick }: { item: NavItem; pending: number; onClick?: () => void }) {
  return (
    <NavLink
      to={item.to}
      onClick={onClick}
      data-tour={item.tour}
      className={({ isActive }) =>
        cn(
          "flex min-h-11 items-center gap-3 rounded-[8px] px-3 text-[0.95rem] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink md:min-h-10",
          isActive && "bg-brand-soft text-ink",
        )
      }
    >
      <item.icon className="size-[18px]" aria-hidden="true" />
      {item.label}
      {item.to === "/approvals" && pending > 0 ? (
        <span className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-hold-soft px-2 text-xs font-semibold text-ink num">
          <span className="lamp scale-75" data-s="hold" aria-hidden="true" />
          {pending}
          <span className="sr-only">waiting</span>
        </span>
      ) : null}
    </NavLink>
  );
}

function Palette({ open, setOpen, items }: { open: boolean; setOpen: (b: boolean) => void; items: NavItem[] }) {
  const nav = useNavigate();
  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Go to" description="Jump to a page">
      <CommandInput placeholder="Go to a page…" />
      <CommandList>
        <CommandEmpty>No page by that name.</CommandEmpty>
        <CommandGroup heading="Pages">
          {items.map((i) => (
            <CommandItem key={i.to} onSelect={() => { setOpen(false); nav(i.to); }}>
              <i.icon /> {i.label}
            </CommandItem>
          ))}
          <CommandItem onSelect={() => { setOpen(false); startTour("judge", nav, true); }}>
            <Compass /> Start the judge tour
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

export function AppShell() {
  const { session, reload } = useSession();
  const loc = useLocation();
  const nav = useNavigate();
  const [more, setMore] = useState(false);
  const [help, setHelp] = useState(false);
  const [pal, setPal] = useState(false);
  const role = session?.me?.role ?? "staff";
  const items = NAV.filter((i) => !i.owner || role === "owner");
  const pending = session?.pending ?? 0;

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPal((v) => !v);
      }
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, []);
  useEffect(() => {
    void reload();
    document.getElementById("main")?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.pathname]);

  const bottom = items.filter((i) => ["/today", "/calls", "/approvals", "/customers"].includes(i.to));
  const signOut = async () => {
    try {
      await act("/logout");
    } catch {
      /* the cookie is cleared either way */
    }
    await reload();
    nav("/");
  };

  return (
    <div className="min-h-dvh bg-paper text-ink">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-md focus:bg-surface focus:px-3 focus:py-2">Skip to content</a>
      <OfflineBar />
      <DemoRibbon />
      <div className="mx-auto flex max-w-[1240px]">
        <aside className="sticky top-0 hidden h-dvh w-[232px] flex-none flex-col gap-1 border-r border-line px-3 py-4 lg:flex" aria-label="Main">
          <Link to="/today" className="mb-4 px-2"><Wordmark /></Link>
          <button type="button" onClick={() => setPal(true)} className="mb-3 flex h-10 items-center gap-2 rounded-[8px] border border-line bg-surface px-3 text-sm text-ink-2 hover:text-ink">
            <Search className="size-4" /> Go to… <kbd className="ml-auto font-mono text-xs">⌘K</kbd>
          </button>
          <nav className="flex flex-col gap-0.5">
            {items.map((i) => <SideLink key={i.to} item={i} pending={pending} />)}
          </nav>
          <div className="mt-auto space-y-2 border-t border-line pt-3 text-sm">
            <div className="px-2">
              <div className="font-medium">{session?.me?.name}</div>
              <div className="text-ink-2">{session?.me?.role === "owner" ? "Owner" : "Front desk"} · {session?.me?.business}</div>
            </div>
            <div className="flex items-center gap-1">
              <ThemeMenu />
              <Button variant="ghost" size="icon" aria-label="Display and help" onClick={() => setHelp(true)} data-tour="display-help"><Accessibility /></Button>
              <Button variant="ghost" size="icon" aria-label="Take the tour" onClick={() => startTour(role === "owner" ? "owner" : "staff", nav, true)} data-tour="take-tour"><BookOpenCheck /></Button>
              <Button variant="ghost" size="icon" aria-label="Sign out" onClick={signOut}><LogOut /></Button>
            </div>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-line bg-paper/95 px-4 backdrop-blur lg:hidden">
            <Link to="/today" aria-label="Callback, Today"><Wordmark /></Link>
            <span className="ml-auto flex items-center">
              <Button variant="ghost" size="icon" aria-label="Take the tour" onClick={() => startTour(role === "owner" ? "owner" : "staff", nav, true)} data-tour="take-tour-m"><BookOpenCheck /></Button>
              <Button variant="ghost" size="icon" aria-label="Display and help" onClick={() => setHelp(true)}><Accessibility /></Button>
              <ThemeMenu />
            </span>
          </header>
          <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-4 pb-28 pt-5 outline-none md:px-8 md:pt-8 lg:pb-12">
            <Outlet />
          </main>
        </div>
      </div>

      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/97 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
        <ul className="mx-auto grid max-w-[560px] grid-cols-5">
          {bottom.map((i) => (
            <li key={i.to}>
              <NavLink to={i.to} data-tour={i.tour ? `${i.tour}-m` : undefined} className={({ isActive }) => cn("relative flex h-16 flex-col items-center justify-center gap-1 text-[0.7rem] font-medium text-ink-2", isActive && "text-ink")}>
                {({ isActive }) => (
                  <>
                    <span className={cn("flex h-7 w-12 items-center justify-center rounded-full", isActive && "bg-brand-soft")}><i.icon className="size-5" aria-hidden="true" /></span>
                    {i.label}
                    {i.to === "/approvals" && pending > 0 ? <span className="absolute right-[18%] top-2 rounded-full bg-hold px-1.5 text-[0.65rem] font-bold text-white num" aria-label={`${pending} waiting`}>{pending}</span> : null}
                  </>
                )}
              </NavLink>
            </li>
          ))}
          {role !== "owner" ? <li /> : null}
          <li>
            <button type="button" onClick={() => setMore(true)} className="flex h-16 w-full flex-col items-center justify-center gap-1 text-[0.7rem] font-medium text-ink-2" data-tour="nav-more-m">
              <span className="flex h-7 w-12 items-center justify-center rounded-full"><Menu className="size-5" aria-hidden="true" /></span>
              More
            </button>
          </li>
        </ul>
      </nav>

      <Sheet open={more} onOpenChange={setMore}>
        <SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto rounded-t-[14px] bg-surface">
          <SheetHeader>
            <SheetTitle>More</SheetTitle>
            <SheetDescription>{session?.me?.name} · {session?.me?.role === "owner" ? "Owner" : "Front desk"}</SheetDescription>
          </SheetHeader>
          <nav className="grid gap-0.5 px-4 pb-6">
            {items.filter((i) => !bottom.includes(i)).map((i) => <SideLink key={i.to} item={i} pending={pending} onClick={() => setMore(false)} />)}
            <button type="button" className="flex min-h-11 items-center gap-3 rounded-[8px] px-3 text-[0.95rem] font-medium text-ink-2" onClick={() => { setMore(false); setHelp(true); }}><Accessibility className="size-[18px]" />Display and help</button>
            <button type="button" className="flex min-h-11 items-center gap-3 rounded-[8px] px-3 text-[0.95rem] font-medium text-ink-2" onClick={() => { setMore(false); void signOut(); }}><LogOut className="size-[18px]" />Sign out</button>
          </nav>
        </SheetContent>
      </Sheet>
      <DisplayHelp open={help} onOpenChange={setHelp} />
      <Palette open={pal} setOpen={setPal} items={items} />
    </div>
  );
}

