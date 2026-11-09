/** Wall-clock helpers: local hour and weekday in a customer's or business's time zone, ISO wall strings. */

export function localParts(at: Date, tz: string): { hour: number; minute: number; weekday: number; date: string } {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "numeric", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour12: false });
  const parts = Object.fromEntries(f.formatToParts(at).map((p) => [p.type, p.value]));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return { hour: Number(parts.hour) % 24, minute: Number(parts.minute), weekday: wd, date: `${parts.year}-${parts.month}-${parts.day}` };
}

export const hhmm = (h: number, m = 0) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

export function parseHHMM(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function fmtLocal(at: Date | string, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(at));
}

export function addHours(d: Date, h: number): Date {
  return new Date(d.getTime() + h * 3600_000);
}
export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86400_000);
}
