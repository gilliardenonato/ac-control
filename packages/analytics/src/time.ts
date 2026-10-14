/** Deslocamento (ms) do fuso `tz` em relação ao UTC no instante `ms`. */
export function tzOffsetMs(ms: number, tz: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(ms).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return asUtc - Math.floor(ms / 1000) * 1000;
}
/** Instante UTC da meia-noite local de `date` (YYYY-MM-DD) em `tz`. */
export function startOfLocalDay(date: string, tz: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - tzOffsetMs(guess, tz);
  t = guess - tzOffsetMs(t, tz); // segunda passada cobre mudança de horário
  return t;
}
export const localDate = (ms: number, tz: string): string => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
export const addDays = (date: string, n: number): string => { const [y, m, d] = date.split("-").map(Number) as [number, number, number]; return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
export const monthOf = (date: string) => date.slice(0, 7);
export const daysInMonth = (month: string): number => { const [y, m] = month.split("-").map(Number) as [number, number]; return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
export const addMonths = (month: string, n: number): string => { const [y, m] = month.split("-").map(Number) as [number, number]; const d = new Date(Date.UTC(y, m - 1 + n, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };
