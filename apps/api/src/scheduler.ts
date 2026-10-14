import { ProviderError } from "@acc/domain";
import type { Clock } from "@acc/domain";
import type { AutomationEngine } from "@acc/automation";
import { localDate } from "@acc/analytics";
import type { Store } from "@acc/storage";
import type { Core } from "./core.ts";
import type { EnergySync } from "./energy.ts";
import type { Sessions } from "./auth.ts";
import type { SensorHub } from "./sensors.ts";

export const POLL = { baseMs: 10 * 60_000, healthyMs: 15 * 60_000, fastMs: 2 * 60_000, maxMs: 30 * 60_000 } as const;

/** Intervalo de poll de estado: rápido com regra armada/rodando; lento quando o push está saudável; backoff em rate limit. */
export function pollInterval(o: { fast: boolean; healthy: boolean; backoff: number }): number {
  const base = o.fast ? POLL.fastMs : o.healthy ? POLL.healthyMs : POLL.baseMs;
  return Math.min(POLL.maxMs, base * 2 ** o.backoff);
}

/** Um único laço "runDue" (chamado a cada ~15 s) decide o que está na hora. Sem timers próprios: testável com relógio falso. */
export class Scheduler {
  private lastTick = 0;
  private lastPoll = new Map<string, number>();
  private backoff = new Map<string, number>();
  private lastEnergyToday = new Map<string, number>();
  private wasOn = new Map<string, boolean>();
  private tailAt = new Map<string, number>();
  private lastHousekeeping = "";
  private running = false;

  constructor(private o: { core: Core; engine: AutomationEngine; energy: EnergySync; store: Store; clock: Clock; tz: string; sensors?: SensorHub; sessions?: Sessions; retention?: () => void }) {}

  /** Horário fixo (aleatório 01:00–05:59) da coleta diária de energia, persistido para espalhar carga. */
  energyMinuteOfDay(): number {
    let m = this.o.store.getSetting<number | null>("energy:minuteOfDay", null);
    if (m === null) { m = 60 + Math.floor(Math.random() * 300); this.o.store.setSetting("energy:minuteOfDay", m); }
    return m;
  }

  async runDue(): Promise<void> {
    if (this.running) return; // evita sobreposição se um ciclo demorar
    this.running = true;
    try {
      const { core, engine, clock, tz, store } = this.o;
      const now = clock.now();
      await this.o.sensors?.pollDue(); // sensores externos (ESP32): consulta a cada 30 s e já reavalia as automações
      if (now - this.lastTick >= 60_000) { this.lastTick = now; engine.tick(); }

      for (const d of store.devices()) {
        const interval = pollInterval({ fast: engine.needsFastPoll(d.id), healthy: core.health.status === "connected", backoff: this.backoff.get(d.id) ?? 0 });
        if (now - (this.lastPoll.get(d.id) ?? 0) < interval) continue;
        this.lastPoll.set(d.id, now);
        try { await core.refreshState(d.id, "poll"); this.backoff.set(d.id, 0); }
        catch (e) {
          const pe = e instanceof ProviderError ? e : null;
          if (pe?.kind === "rateLimited") this.backoff.set(d.id, Math.min(3, (this.backoff.get(d.id) ?? 0) + 1));
          else if (pe?.kind === "offline") core.markOffline(d);
        }
      }

      // energia: hoje de hora em hora; últimos dias/meses 1x/dia no horário sorteado (e no primeiro ciclo)
      const local = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
      const minuteOfDay = Number(local.find((p) => p.type === "hour")!.value) * 60 + Number(local.find((p) => p.type === "minute")!.value);
      const today = localDate(now, tz);
      const doneKey = `energy:recentDone:${today}`;
      const recentDue = minuteOfDay >= this.energyMinuteOfDay() && !store.getSetting<boolean>(doneKey, false);
      // contador de hoje: a cada 10 min com o aparelho ligado (a LG atualiza em degraus de ~5–10 min), de hora em hora desligado,
      // e uma leitura final ~11 min depois de desligar (para fechar a energia da sessão)
      for (const d of store.devices()) {
        const on = core.states.get(d.id).values.power === true;
        if (this.wasOn.get(d.id) && !on) this.tailAt.set(d.id, now + 11 * 60_000);
        this.wasOn.set(d.id, on);
        const last = this.lastEnergyToday.get(d.id);
        const tail = this.tailAt.get(d.id);
        const due = last === undefined || now - last >= (on ? 10 * 60_000 : 3600_000) || (tail !== undefined && now >= tail);
        const full = recentDue || last === undefined;
        if (!due && !recentDue) continue;
        this.lastEnergyToday.set(d.id, now);
        if (tail !== undefined && now >= tail) this.tailAt.delete(d.id);
        const ok = await this.o.energy.sync(d.id, full ? "recent" : "today");
        if (recentDue && ok) store.setSetting(doneKey, true);
      }

      // manutenção diária (04:00 local)
      if (minuteOfDay >= 240 && this.lastHousekeeping !== today) { this.lastHousekeeping = today; this.o.sessions?.purgeExpired(); this.o.retention?.(); }
    } finally { this.running = false; }
  }
}
