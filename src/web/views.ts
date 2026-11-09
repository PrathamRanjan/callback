import type { Request } from "express";
import { getDb } from "../db.js";
import { fmtLocal } from "../core/time.js";
import { nowOf } from "../store.js";
import type { Me } from "./auth.js";
import { flashOf } from "./common.js";
import { html, layout, type Raw } from "./html.js";

export async function ownerPage(req: Request, p: Me, title: string, body: Raw, extra: { head?: Raw; scripts?: Raw } = {}): Promise<string> {
  const db = await getDb();
  const biz = (await db.query<{ tz: string }>("SELECT tz FROM businesses WHERE id = $1", [p.business_id])).rows[0];
  const now = await nowOf(db, p.business_id);
  return layout({ title, who: { name: p.name, business: p.business_name, role: p.role, clock: fmtLocal(now, biz?.tz ?? "UTC") }, flash: flashOf(req), ...extra }, body);
}

export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
export const purposeLabel: Record<string, string> = { confirm_deposit: "Confirm deposit", chase_invoice: "Chase invoice", cancel_class: "Cancelled class" };
export const stat = (label: string, value: unknown, note?: string) => html`<div class="stat"><span class="muted small">${label}</span><b>${value}</b>${note ? html`<span class="small muted">${note}</span>` : ""}</div>`;
