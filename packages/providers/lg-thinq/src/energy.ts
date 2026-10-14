import type { EnergyPoint, EnergyQuery } from "@acc/domain";
import { addDaysStr, addMonthsStr } from "./dates.ts";

export const ymd = (d: string) => d.replace(/-/g, "");
export const fromUsedDate = (u: string): { key: string; granularity: EnergyPoint["granularity"] } | null => {
  if (/^\d{8}$/.test(u)) return { key: `${u.slice(0, 4)}-${u.slice(4, 6)}-${u.slice(6, 8)}`, granularity: "day" };
  if (/^\d{6}$/.test(u)) return { key: `${u.slice(0, 4)}-${u.slice(4, 6)}`, granularity: "month" };
  if (/^\d{10}$/.test(u)) return { key: `${u.slice(0, 4)}-${u.slice(4, 6)}-${u.slice(6, 8)}T${u.slice(8, 10)}`, granularity: "hour" };
  return null;
};

/** Janelas aceitas pela API: DAILY até 31 dias, MONTHLY até 12 meses. */
export function chunk(q: EnergyQuery): { period: "DAILY" | "MONTHLY"; start: string; end: string }[] {
  const out: { period: "DAILY" | "MONTHLY"; start: string; end: string }[] = [];
  if (q.granularity === "day") {
    for (let s = q.from; s <= q.to; s = addDaysStr(s, 31)) { const e = addDaysStr(s, 30); out.push({ period: "DAILY", start: ymd(s), end: ymd(e > q.to ? q.to : e) }); }
  } else {
    for (let s = q.from; s <= q.to; s = addMonthsStr(s, 12)) { const e = addMonthsStr(s, 11); out.push({ period: "MONTHLY", start: s.replace("-", ""), end: (e > q.to ? q.to : e).replace("-", "") }); }
  }
  return out;
}

/** Aceita `useAmount` (doc oficial) e `energyUsage` (SDK/HA). `unitFactor` converte para Wh (1 = já em Wh). */
export function parseUsage(resp: any, unitFactor: number, collectedAt: number): EnergyPoint[] {
  const list: any[] = resp?.result?.dataList ?? resp?.dataList ?? [];
  const pts: EnergyPoint[] = [];
  for (const it of list) {
    const k = fromUsedDate(String(it.usedDate ?? ""));
    const v = it.useAmount ?? it.energyUsage;
    if (k && typeof v === "number") pts.push({ key: k.key, granularity: k.granularity, wh: v * unitFactor, collectedAt });
  }
  return pts;
}
