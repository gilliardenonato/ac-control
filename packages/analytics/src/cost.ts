import type { Basis } from "@acc/domain";
import { addDays, addMonths, daysInMonth, localDate, monthOf, startOfLocalDay } from "./time.ts";

export interface TariffEntry { validFrom: string; priceMicro: number } // R$/kWh × 1e6
/** Tarifa vigente na data (a de maior validFrom <= date). */
export function tariffAt(tariffs: TariffEntry[], date: string): number | undefined {
  let best: TariffEntry | undefined;
  for (const t of tariffs) if (t.validFrom <= date && (!best || t.validFrom > best.validFrom)) best = t;
  return best?.priceMicro;
}
/** Custo em micro-reais: Wh/1000 × (R$/kWh × 1e6). */
export const costMicro = (wh: number, priceMicro: number) => Math.round((wh / 1000) * priceMicro);
export const microToBrl = (m: number) => m / 1e6;

export interface DayEnergy { date: string; wh: number; final: boolean }
export interface CostSummary { wh: number; costMicro: number | null; basis: Basis; days: number; daysWithData: number; missingTariff: boolean; provisional: boolean }

/** Soma energia medida e custo (com a tarifa de cada dia) no intervalo [from,to]. */
export function summarize(energy: DayEnergy[], tariffs: TariffEntry[], from: string, to: string): CostSummary {
  const byDate = new Map(energy.map((e) => [e.date, e]));
  let wh = 0, cost = 0, n = 0, have = 0, missing = false, provisional = false;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    n++;
    const e = byDate.get(d);
    if (!e) continue;
    have++; wh += e.wh; if (!e.final) provisional = true;
    const p = tariffAt(tariffs, d);
    if (p === undefined) missing = true; else cost += costMicro(e.wh, p);
  }
  return { wh, costMicro: missing ? null : cost, basis: "measured", days: n, daysWithData: have, missingTariff: missing, provisional };
}

export interface Projection {
  month: string; basis: "estimated"; sampleDays: number; monthToDateWh: number; avgDailyWh: number | null;
  projectedWh: number | null; projectedCostMicro: number | null; lowCostMicro: number | null; highCostMicro: number | null;
  goalCents: number | null; diffToGoalMicro: number | null; previousMonthWh: number | null; previousMonthCostMicro: number | null;
}
/**
 * Projeção do mês: consumo até agora + média diária × dias restantes.
 * Média usa os dias fechados do mês corrente (até 14 mais recentes); faixa = p25..p75 dos dias.
 * Estimativa, não medição: depende de poucos dias e do clima.
 */
export function projectMonth(o: { energy: DayEnergy[]; tariffs: TariffEntry[]; today: string; goalCents?: number; previousMonth?: { wh: number; costMicro: number | null } }): Projection {
  const month = monthOf(o.today);
  const inMonth = o.energy.filter((e) => monthOf(e.date) === month && e.date <= o.today);
  const mtd = inMonth.reduce((a, e) => a + e.wh, 0);
  const closed = inMonth.filter((e) => e.date < o.today).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 14).map((e) => e.wh);
  const remainingDays = daysInMonth(month) - Number(o.today.slice(8)); // dias após hoje
  const price = tariffAt(o.tariffs, o.today);
  let avg: number | null = null, proj: number | null = null, projCost: number | null = null, low: number | null = null, high: number | null = null;
  if (closed.length > 0) {
    avg = closed.reduce((a, b) => a + b, 0) / closed.length;
    // hoje ainda está em curso: conta ao menos o já medido de hoje e estima o resto do dia pela média
    const todayWh = inMonth.find((e) => e.date === o.today)?.wh ?? 0;
    const todayPart = Math.max(todayWh, avg);
    const rest = avg * remainingDays;
    proj = mtd - todayWh + todayPart + rest;
    const sorted = [...closed].sort((a, b) => a - b);
    const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
    const base = mtd - todayWh + todayPart;
    if (price !== undefined) {
      projCost = costMicro(proj, price);
      low = costMicro(base + Math.min(avg, q(0.25)) * remainingDays, price); high = costMicro(base + Math.max(avg, q(0.75)) * remainingDays, price); // a faixa sempre envolve a média
    }
  }
  const goalMicro = o.goalCents === undefined ? null : o.goalCents * 10_000;
  return {
    month, basis: "estimated", sampleDays: closed.length, monthToDateWh: mtd, avgDailyWh: avg, projectedWh: proj, projectedCostMicro: projCost,
    lowCostMicro: low, highCostMicro: high, goalCents: o.goalCents ?? null, diffToGoalMicro: goalMicro !== null && projCost !== null ? projCost - goalMicro : null,
    previousMonthWh: o.previousMonth?.wh ?? null, previousMonthCostMicro: o.previousMonth?.costMicro ?? null,
  };
}
void addMonths; void localDate; void startOfLocalDay;
