import "@fontsource-variable/archivo/standard.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./index.css";
import { StrictMode, Suspense, lazy, useCallback, useEffect, useState, type ReactNode, useContext } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Rows } from "@/components/app/bits";
import { applyDisplay } from "@/components/app/display-help";
import { getJson } from "@/lib/api";
import { SessionCtx, type Session } from "@/lib/hooks";
import { applyTheme } from "@/lib/theme";
import Landing from "@/pages/landing";
import Try from "@/pages/try";

const AppShell = lazy(() => import("@/components/app/shell").then((m) => ({ default: m.AppShell })));
const Today = lazy(() => import("@/pages/today"));
const Calls = lazy(() => import("@/pages/calls"));
const Call = lazy(() => import("@/pages/call"));
const Customers = lazy(() => import("@/pages/customers"));
const Customer = lazy(() => import("@/pages/customer"));
const Approvals = lazy(() => import("@/pages/approvals"));
const Money = lazy(() => import("@/pages/money"));
const Rules = lazy(() => import("@/pages/rules"));
const Safety = lazy(() => import("@/pages/safety"));
const Messages = lazy(() => import("@/pages/messages"));
const Proof = lazy(() => import("@/pages/proof"));
const Ask = lazy(() => import("@/pages/ask"));
const Trace = lazy(() => import("@/pages/trace"));
const Demo = lazy(() => import("@/pages/demo"));
const Portal = lazy(() => import("@/pages/portal"));
const Judge = lazy(() => import("@/pages/judge"));
const PublicProof = lazy(() => import("@/pages/public").then((m) => ({ default: m.PublicProof })));
const PublicAi = lazy(() => import("@/pages/public").then((m) => ({ default: m.PublicAi })));
const PublicPayPal = lazy(() => import("@/pages/public").then((m) => ({ default: m.PublicPayPal })));
const WhoCanMoveMoney = lazy(() => import("@/pages/public").then((m) => ({ default: m.WhoCanMoveMoney })));
const AccessibilityPage = lazy(() => import("@/pages/public").then((m) => ({ default: m.AccessibilityPage })));
const Agents = lazy(() => import("@/pages/public").then((m) => ({ default: m.Agents })));
const NotFound = lazy(() => import("@/pages/not-found"));

applyTheme();
applyDisplay();

function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    try {
      setSession(await getJson<Session>("/api/app/session"));
    } catch {
      /* offline: keep what we had */
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => void reload(), [reload]);
  return <SessionCtx.Provider value={{ session, loading, reload }}>{children}</SessionCtx.Provider>;
}

/** Signed-in pages. Without a session the visitor goes to the persona picker, then back here. */
// Uses the one session the provider loaded (spec B2 C1: it used to fetch it again on every page). Before sending
// a visitor to /try it checks once more, so a sign-in made a moment ago in another tab is not lost.
function RequireSession({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const { session, loading, reload } = useContext(SessionCtx);
  const [rechecked, setRechecked] = useState(false);
  const [checking, setChecking] = useState(false);
  const signedOut = Boolean(session) && !session?.me;
  useEffect(() => {
    if (loading || !signedOut || rechecked) return;
    setRechecked(true);
    setChecking(true);
    void reload().finally(() => setChecking(false));
  }, [loading, signedOut, rechecked, reload]);
  if (loading || checking || (signedOut && !rechecked)) return <div className="mx-auto max-w-[900px] p-6"><Rows n={3} /></div>;
  if (signedOut) return <Navigate to={`/try?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <>{children}</>;
}

/** Tours start only from a button (which opens the tour's page with state.tour set) and end on any route change. */
function Tours() {
  const loc = useLocation();
  useEffect(() => {
    const kind = (loc.state as { tour?: "owner" | "staff" } | null)?.tour;
    if (!kind) {
      if (document.querySelector(".driver-popover")) void import("@/tour/tours").then((t) => t.endTour());
      return;
    }
    void import("@/tour/tours").then((t) => t.startTour(kind));
    return () => void import("@/tour/tours").then((t) => t.endTour());
  }, [loc.key]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

const Fallback = () => <div className="mx-auto max-w-[900px] p-6"><Rows n={4} /></div>;

function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <TooltipProvider delayDuration={300}>
          <Tours />
          <Suspense fallback={<Fallback />}>
            <Routes>
              <Route path="/" element={<Landing />} />
              <Route path="/try" element={<Try />} />
              <Route path="/login" element={<Try />} />
              <Route path="/c/:token" element={<Portal />} />
              <Route path="/judge" element={<Judge />} />
              <Route path="/proof" element={<PublicProof />} />
              <Route path="/ai" element={<PublicAi />} />
              <Route path="/paypal" element={<PublicPayPal />} />
              <Route path="/who-can-move-money" element={<WhoCanMoveMoney />} />
              <Route path="/accessibility" element={<AccessibilityPage />} />
              <Route path="/agents" element={<Agents />} />
              <Route element={<RequireSession><AppShell /></RequireSession>}>
                <Route path="/today" element={<Today />} />
                <Route path="/ask" element={<Ask />} />
                <Route path="/calls" element={<Calls />} />
                <Route path="/calls/:id" element={<Call />} />
                <Route path="/customers" element={<Customers />} />
                <Route path="/customers/:id" element={<Customer />} />
                <Route path="/approvals" element={<Approvals />} />
                <Route path="/money" element={<Money />} />
                <Route path="/rules" element={<Rules />} />
                <Route path="/safety" element={<Safety />} />
                <Route path="/messages" element={<Messages />} />
                <Route path="/evidence" element={<Proof />} />
                <Route path="/trace/:id" element={<Trace />} />
                <Route path="/demo" element={<Demo />} />
                <Route path="/ops/guard" element={<Navigate to="/approvals" replace />} />
                <Route path="/ops/money" element={<Navigate to="/money" replace />} />
                <Route path="/ops/channels" element={<Navigate to="/messages" replace />} />
                <Route path="/ops/evidence" element={<Navigate to="/evidence" replace />} />
                <Route path="/ops/eval" element={<Navigate to="/evidence" replace />} />
                <Route path="/ops/traces" element={<Navigate to="/evidence" replace />} />
                <Route path="/policy" element={<Navigate to="/rules" replace />} />
                <Route path="/ops/mcp" element={<Navigate to="/agents" replace />} />
                <Route path="*" element={<NotFound />} />
              </Route>
            </Routes>
          </Suspense>
          {/* The one polite live region for payment status changes (spec A7); see lib/announce.ts. */}
          <div id="cb-status-live" role="status" aria-live="polite" aria-atomic="true" className="sr-only" />
          <Toaster />
        </TooltipProvider>
      </SessionProvider>
    </BrowserRouter>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
