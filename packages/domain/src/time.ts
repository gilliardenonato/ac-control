/** Minutos desde 00:00 no fuso `tz` para o instante `ms`. */
export function minutesOfDay(ms: number, tz: string): number {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(ms);
  return Number(p.find((x) => x.type === "hour")!.value) * 60 + Number(p.find((x) => x.type === "minute")!.value);
}
/** 1=segunda … 7=domingo no fuso `tz`. */
export function isoWeekday(ms: number, tz: string): number {
  const d = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(ms);
  return ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 } as Record<string, number>)[d]!;
}
const hm = (s: string) => { const [h, m] = s.split(":").map(Number); return h! * 60 + (m ?? 0); };
/** Janela [from,to) que pode atravessar a meia-noite. */
export function inTimeWindow(ms: number, from: string, to: string, tz: string): boolean {
  const n = minutesOfDay(ms, tz), a = hm(from), b = hm(to);
  return a === b ? true : a < b ? n >= a && n < b : n >= a || n < b;
}
/** Data local YYYY-MM-DD no fuso `tz`. */
export function localDate(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}
