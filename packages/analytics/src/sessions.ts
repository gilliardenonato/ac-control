import type { Basis } from "@acc/domain";
import { costMicro, tariffAt, type DayEnergy, type TariffEntry } from "./cost.ts";
import { addDays, localDate, startOfLocalDay } from "./time.ts";

export interface SessionSpan { id?: string; startTs: number; endTs: number | null; origin?: string | null }

/** Teto de potência média plausível para um split residencial; acima disso a estimativa é descartada em vez de exibida. */
export const MAX_PLAUSIBLE_WATTS = 3500;
export interface EstimateOpts { monitoredSince?: number | null; maxWatts?: number }
const none = (reason: string, perDay: SessionEstimate["perDay"] = []): SessionEstimate => ({ wh: null, costMicro: null, basis: "estimated", method: "none", provisional: true, reason, perDay });
const hm = (ms: number, tz: string) => new Intl.DateTimeFormat("pt-BR", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(ms);

/** Minutos ligados por dia local (sessões que cruzam a meia-noite são fatiadas). `now` fecha sessões abertas. */
export function minutesByDay(sessions: SessionSpan[], tz: string, now: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of sessions) {
    const end = s.endTs ?? now;
    if (end <= s.startTs) continue;
    for (let day = localDate(s.startTs, tz); ; day = addDays(day, 1)) {
      const a = Math.max(s.startTs, startOfLocalDay(day, tz)), b = Math.min(end, startOfLocalDay(addDays(day, 1), tz));
      if (b > a) out.set(day, (out.get(day) ?? 0) + (b - a) / 60000);
      if (startOfLocalDay(addDays(day, 1), tz) >= end) break;
    }
  }
  return out;
}

export interface SessionEstimate {
  wh: number | null; costMicro: number | null; basis: Basis; method: "proportional" | "snapshot_delta" | "none";
  provisional: boolean; reason?: string; perDay: { date: string; wh: number; minutes: number }[];
}
/**
 * Estima energia/custo de uma sessão: Wh medido do dia × fração do tempo ligado (do dia) que a sessão ocupou.
 * É SEMPRE estimativa (a LG só informa total por dia). Sem energia medida do dia → sem valor (não inventa).
 */
export function estimateSession(session: SessionSpan, allSessions: SessionSpan[], energy: DayEnergy[], tariffs: TariffEntry[], tz: string, now: number, opts: EstimateOpts = {}): SessionEstimate {
  const mine = minutesByDay([session], tz, now);
  const total = minutesByDay(allSessions, tz, now);
  const eByDate = new Map(energy.map((e) => [e.date, e]));
  let wh = 0, cost = 0, provisional = false, any = false, missingTariff = false;
  const perDay: SessionEstimate["perDay"] = [];
  for (const [date, minutes] of mine) {
    const e = eByDate.get(date);
    const day = total.get(date) ?? 0;
    if (!e || day <= 0) continue;
    // O total do dia só pode ser repartido entre sessões se TODAS as sessões do dia foram observadas.
    // Se o app começou a monitorar depois do início do dia, ou a sessão já estava ligada ao começar, parte do consumo é de tempo que não vimos.
    const dayStart = startOfLocalDay(date, tz);
    if (opts.monitoredSince !== undefined && opts.monitoredSince !== null && opts.monitoredSince > dayStart + 30 * 60_000)
      return none(`o dia ${date.slice(8)}/${date.slice(5, 7)} só foi monitorado a partir das ${hm(opts.monitoredSince, tz)}; o consumo do dia inclui horas que o app não viu`, perDay);
    if (allSessions.some((s) => s.origin === "unknown" && localDate(s.startTs, tz) === date))
      return none("o aparelho já estava ligado quando o app começou a monitorar; não dá para repartir o consumo do dia", perDay);
    any = true; if (!e.final) provisional = true;
    const part = e.wh * (minutes / day);
    wh += part; perDay.push({ date, wh: part, minutes });
    const p = tariffAt(tariffs, date);
    if (p === undefined) missingTariff = true; else cost += costMicro(part, p);
  }
  if (!any) return none("sem energia medida para o dia da sessão", perDay);
  const hours = Math.max((((session.endTs ?? now) - session.startTs) / 3_600_000), 1 / 60);
  if (wh / hours > (opts.maxWatts ?? MAX_PLAUSIBLE_WATTS)) return none(`estimativa implausível (${Math.round(wh / hours)} W médios); descartada`, perDay);
  return { wh, costMicro: missingTariff ? null : cost, basis: "estimated", method: "proportional", provisional, perDay };
}

export interface Snap { ts: number; wh: number }
const MAX_GAP_MS = 20 * 60_000;

/**
 * Acumulado do dia (Wh) no instante `ts`, por interpolação entre leituras do contador da LG.
 * Retorna null quando não há leituras próximas o bastante (nunca chuta). Contador reinicia na meia-noite local.
 */
export function cumulativeAt(ts: number, dayStart: number, dayEnd: number, snaps: Snap[], finalTotal: number | null, now: number): number | null {
  if (ts <= dayStart) return 0;
  if (ts >= dayEnd) return finalTotal;
  let prev: Snap | undefined, next: Snap | undefined;
  for (const s of snaps) { if (s.ts <= ts) prev = s; else { next = s; break; } }
  if (prev && next) {
    if (prev.wh === next.wh) return prev.wh; // contador não andou entre as leituras
    if (next.ts - prev.ts > MAX_GAP_MS) return null;
    return prev.wh + ((next.wh - prev.wh) * (ts - prev.ts)) / (next.ts - prev.ts);
  }
  if (prev && !next) return ts - prev.ts <= MAX_GAP_MS || now - prev.ts <= MAX_GAP_MS && ts >= now ? prev.wh : null;
  // início logo antes da primeira leitura (ex.: o app acabou de subir): a leitura seguinte é a melhor aproximação
  if (!prev && next && next.ts - ts <= 5 * 60_000) return next.wh;
  return null;
}

/** Energia da sessão pela diferença do contador diário (precisão ≈ intervalo de atualização da LG, ~5–10 min). */
export function estimateSessionBySnapshots(session: SessionSpan, energy: DayEnergy[], snapsByDate: Map<string, Snap[]>, tariffs: TariffEntry[], tz: string, now: number, opts: EstimateOpts = {}): SessionEstimate | null {
  const end = session.endTs ?? now;
  if (end <= session.startTs) return null;
  const eBy = new Map(energy.map((e) => [e.date, e]));
  let wh = 0, cost = 0, missingTariff = false, provisional = false;
  const perDay: SessionEstimate["perDay"] = [];
  for (let day = localDate(session.startTs, tz); ; day = addDays(day, 1)) {
    const ds = startOfLocalDay(day, tz), de = startOfLocalDay(addDays(day, 1), tz);
    const a = Math.max(session.startTs, ds), b = Math.min(end, de);
    if (b > a) {
      const e = eBy.get(day);
      const snaps = snapsByDate.get(day) ?? [];
      const final = e?.final ? e.wh : null;
      const c1 = cumulativeAt(a, ds, de, snaps, final, now), c2 = cumulativeAt(b, ds, de, snaps, final, now);
      if (c1 === null || c2 === null) return null;
      const part = Math.max(0, c2 - c1);
      wh += part; perDay.push({ date: day, wh: part, minutes: (b - a) / 60000 });
      if (!e?.final) provisional = true;
      const p = tariffAt(tariffs, day);
      if (p === undefined) missingTariff = true; else cost += costMicro(part, p);
    }
    if (de >= end) break;
  }
  const hours = Math.max((end - session.startTs) / 3_600_000, 1 / 60);
  if (wh / hours > (opts.maxWatts ?? MAX_PLAUSIBLE_WATTS)) return null; // leituras inconsistentes: cai para o próximo método (que também checa)
  return { wh, costMicro: missingTariff ? null : cost, basis: "estimated", method: "snapshot_delta", provisional, perDay };
}

/** Melhor estimativa disponível: diferença do contador; senão proporcional ao tempo ligado. */
export function estimateSessionBest(session: SessionSpan, all: SessionSpan[], energy: DayEnergy[], snapsByDate: Map<string, Snap[]>, tariffs: TariffEntry[], tz: string, now: number, opts: EstimateOpts = {}): SessionEstimate {
  return estimateSessionBySnapshots(session, energy, snapsByDate, tariffs, tz, now, opts) ?? estimateSession(session, all, energy, tariffs, tz, now, opts);
}
