import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useTitle } from "@/lib/hooks";

import { t } from "@/i18n";
export default function NotFound() {
  useTitle(t("Not found"));
  return (
    <div className="max-w-[520px] py-10">
      <div className="mb-3 flex items-center gap-2 text-ink-2"><span className="lamp" data-s="off" aria-hidden="true" />{t("No line here")}</div>
      <h1 className="font-display text-h1 font-[800]">{t("That page doesn't exist.")}</h1>
      <p className="mt-2 text-ink-2">{t("The link may be old. Everything is reachable from Today.")}</p>
      <Button className="mt-5" asChild><Link to="/today">{t("Go to Today")}</Link></Button>
    </div>
  );
}
