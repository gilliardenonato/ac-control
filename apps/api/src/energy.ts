import { ProviderError } from "@acc/domain";
import type { Clock, EnergyPoint } from "@acc/domain";
import type { ACProvider } from "@acc/provider-api";
import type { Store } from "@acc/storage";
import { addDays, addMonths, localDate, monthOf, startOfLocalDay } from "@acc/analytics";
import type { Bus } from "./bus.ts";

const UNSUPPORTED_RETRY_MS = 24 * 3600_000;

export interface EnergyStatus { supported: boolean | null; lastSyncAt: number | null; lastError: string | null; needsScope: boolean }

/** Coleta energia medida (Wh) da LG e grava; nunca inventa valores quando o aparelho não informa. */
export class EnergySync {
  constructor(private store: Store, private provider: ACProvider, private bus: Bus, private clock: Clock, private tz: string, private externalId: (deviceId: string) => string) {}

  status(deviceId: string): EnergyStatus { return this.store.getSetting<EnergyStatus>(`energy:status:${deviceId}`, { supported: null, lastSyncAt: null, lastError: null, needsScope: false }); }
  private setStatus(deviceId: string, patch: Partial<EnergyStatus>) { this.store.setSetting(`energy:status:${deviceId}`, { ...this.status(deviceId), ...patch }); }

  /** mode "today": só hoje (barato, de hora em hora). "recent": últimos 3 dias + mês atual e anterior. */
  async sync(deviceId: string, mode: "today" | "recent"): Promise<boolean> {
    const now = this.clock.now();
    const st = this.status(deviceId);
    if (st.supported === false && st.lastSyncAt !== null && now - st.lastSyncAt < UNSUPPORTED_RETRY_MS) return false;
    const today = localDate(now, this.tz);
    try {
      const ext = this.externalId(deviceId);
      if (st.supported === null) {
        const caps = await this.provider.getEnergyCapabilities(ext);
        if (!caps.supported) { this.setStatus(deviceId, { supported: false, lastSyncAt: now, lastError: "aparelho não informa energia" }); return false; }
      }
      // primeira coleta completa: busca ~4 meses de histórico diário (a LG guarda; janelas de 31 dias são tratadas no provider)
      const backfilled = this.store.getSetting<boolean>(`energy:backfilled:${deviceId}`, false);
      const from = mode === "today" ? today : addDays(today, backfilled ? -3 : -120);
      this.ingest(deviceId, await this.provider.getEnergyUsage(ext, { granularity: "day", from, to: today }), today);
      if (mode === "recent") {
        const m = monthOf(today);
        const monthsDone = this.store.getSetting<boolean>(`energy:backfilledMonths:${deviceId}`, false);
        this.ingest(deviceId, await this.provider.getEnergyUsage(ext, { granularity: "month", from: addMonths(m, monthsDone ? -1 : -12), to: m }), today); // 12 meses na primeira vez
        this.store.setSetting(`energy:backfilledMonths:${deviceId}`, true);
      }
      if (mode === "recent") this.store.setSetting(`energy:backfilled:${deviceId}`, true);
      this.setStatus(deviceId, { supported: true, lastSyncAt: now, lastError: null, needsScope: false });
      this.bus.publish({ type: "energy.updated", deviceId });
      return true;
    } catch (e) {
      const pe = e instanceof ProviderError ? e : new ProviderError("fatal", String(e));
      if (pe.kind === "unsupported") this.setStatus(deviceId, { supported: false, lastSyncAt: now, lastError: "energia não suportada por este aparelho" });
      else if (pe.kind === "scope") this.setStatus(deviceId, { needsScope: true, lastError: "PAT sem escopo de energia: gere um novo token marcando todos os escopos" });
      else this.setStatus(deviceId, { lastError: pe.message });
      return false;
    }
  }

  private ingest(deviceId: string, points: EnergyPoint[], today: string) {
    for (const p of points) {
      if (p.granularity === "day") {
        this.store.upsertEnergyDaily(deviceId, p.key, p.wh, p.key < today, p.collectedAt);
        if (p.key === today) this.store.addEnergySnapshot(deviceId, p.collectedAt, p.key, p.wh); // contador do dia, p/ energia por sessão
      }
      else if (p.granularity === "month") this.store.upsertEnergyMonthly(deviceId, p.key, p.wh, p.collectedAt);
      else { // "YYYY-MM-DDTHH" local
        const [d, h] = p.key.split("T") as [string, string];
        this.store.upsertEnergyHourly(deviceId, startOfLocalDay(d, this.tz) + Number(h) * 3600_000, p.wh, p.collectedAt);
      }
    }
  }
}
