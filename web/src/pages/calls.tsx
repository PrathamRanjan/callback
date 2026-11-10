import { useMemo, useState } from "react";
import { Empty, ErrorState, PageHead, Rows, Segmented } from "@/components/app/bits";
import { CallList, type CallRow } from "@/components/app/call-row";
import { Input } from "@/components/ui/input";
import { useData, useTitle } from "@/lib/hooks";
import { plural } from "@/lib/format";

const FILTERS = [
  { v: "all", label: "All" },
  { v: "planned", label: "Ready" },
  { v: "live", label: "On the line" },
  { v: "blocked", label: "Not calling" },
  { v: "ended", label: "Finished" },
];

export default function CallsPage() {
  useTitle("Calls");
  const { data, error, loading, reload } = useData<CallRow[]>("/api/app/calls", { poll: 15000 });
  const [f, setF] = useState("all");
  const [q, setQ] = useState("");
  const rows = useMemo(() => {
    const all = data ?? [];
    return all.filter((c) => (f === "all" ? true : f === "live" ? ["ringing", "in_progress"].includes(c.status) : c.status === f)).filter((c) => !q || (c.customer?.name ?? "").toLowerCase().includes(q.toLowerCase()));
  }, [data, f, q]);
  const counts = (v: string) => (data ?? []).filter((c) => (v === "all" ? true : v === "live" ? ["ringing", "in_progress"].includes(c.status) : c.status === v)).length;
  return (
    <>
      <PageHead
        title="Calls"
        happened={data ? `${plural(counts("ended"), "call")} finished.` : undefined}
        needs={data && counts("blocked") ? `${plural(counts("blocked"), "call")} not calling; each says which rule stopped it.` : undefined}
        next={data ? `${plural(counts("planned"), "call")} ready. Open one to start it.` : undefined}
      />
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center">
        <Segmented label="Show calls" value={f} onChange={setF} options={FILTERS.map((x) => ({ v: x.v, label: <>{x.label} <span className="ml-1 text-xs num">{counts(x.v)}</span></> }))} />
        <Input type="search" placeholder="Find a customer" aria-label="Find a customer" value={q} onChange={(e) => setQ(e.target.value)} className="h-11 md:ml-auto md:max-w-[260px]" />
      </div>
      <div data-tour="calls-list">
        {error && !data ? <ErrorState error={error} retry={reload} /> : loading && !data ? <Rows n={6} /> : rows.length ? <CallList rows={rows} label="Calls" /> : <Empty title="No calls here">{f === "all" ? "Add a customer and a charge, then re-plan from Today." : "Try another filter."}</Empty>}
      </div>
    </>
  );
}
