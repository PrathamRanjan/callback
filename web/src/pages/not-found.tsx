import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useTitle } from "@/lib/hooks";

export default function NotFound() {
  useTitle("Not found");
  return (
    <div className="max-w-[520px] py-10">
      <div className="mb-3 flex items-center gap-2 text-ink-2"><span className="lamp" data-s="off" aria-hidden="true" />No line here</div>
      <h1 className="font-display text-h1 font-[800]">That page doesn't exist.</h1>
      <p className="mt-2 text-ink-2">The link may be old. Everything is reachable from Today.</p>
      <Button className="mt-5" asChild><Link to="/today">Go to Today</Link></Button>
    </div>
  );
}
