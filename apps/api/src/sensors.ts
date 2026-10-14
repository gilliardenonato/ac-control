import type { Clock } from "@acc/domain";
import type { SensorRow, Store } from "@acc/storage";
import type { Bus } from "./bus.ts";

const STORE_EVERY_MS = 60_000;
export const POLL_EVERY_MS = 30_000;
export const SENSOR_ONLINE_MS = 5 * 60_000;
const MAX_BODY = 8 * 1024;

export interface SensorDto { id: string; name: string; pollUrl: string; deviceId: string | null; lastSeenAt: number | null; temperature: number | null; humidity: number | null; online: boolean; lastError: string | null }
export interface SensorReading { temperature?: number; humidity?: number }

/** Aceita os nomes usados pelo ESP32 do dono (`temperature_c`, `humidity_pct`) e variações comuns. Valores fora da faixa física viram erro. */
export function parseSensorPayload(j: unknown): SensorReading {
  const o = (j ?? {}) as Record<string, unknown>;
  if (typeof o.status === "string" && o.status.toLowerCase() !== "ok") throw new Error(`sensor reportou status "${o.status}"`);
  const num = (...keys: string[]) => { for (const k of keys) if (typeof o[k] === "number" && Number.isFinite(o[k])) return o[k] as number; return undefined; };
  const temperature = num("temperature_c", "temperature", "temp", "t");
  const humidity = num("humidity_pct", "humidity", "hum", "h");
  if (temperature === undefined && humidity === undefined) throw new Error("resposta sem temperature_c/humidity_pct");
  if (temperature !== undefined && (temperature < -40 || temperature > 85)) throw new Error(`temperatura fora da faixa (${temperature})`);
  if (humidity !== undefined && (humidity < 0 || humidity > 100)) throw new Error(`umidade fora da faixa (${humidity})`);
  return { temperature, humidity };
}

/** Consulta a URL do sensor: timeout curto, sem seguir redirecionamentos, corpo limitado. */
export async function fetchSensor(url: string, f: typeof fetch = fetch): Promise<SensorReading> {
  const res = await f(url, { signal: AbortSignal.timeout(5000), redirect: "manual", headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BODY) throw new Error("resposta grande demais");
  let j: unknown; try { j = JSON.parse(text); } catch { throw new Error("resposta não é JSON"); }
  return parseSensorPayload(j);
}

/** Sensores externos (ex.: ESP32): o AC Control consulta a URL de cada sensor periodicamente. */
export class SensorHub {
  private lastStored = new Map<string, number>();
  private lastPoll = new Map<string, number>();
  private listeners: (() => void)[] = [];
  constructor(private store: Store, private bus: Bus, private clock: Clock, private f: typeof fetch = fetch) {}

  onReading(fn: () => void) { this.listeners.push(fn); }
  test(url: string): Promise<SensorReading> { return fetchSensor(url, this.f); }

  /** Consulta um sensor agora; erros ficam registrados (e o sensor passa a "sem dados" quando a última leitura envelhece). */
  async poll(s: SensorRow): Promise<boolean> {
    this.lastPoll.set(s.id, this.clock.now());
    try { this.record(s, await fetchSensor(s.pollUrl, this.f)); return true; }
    catch (e) { this.store.setSensorError(s.id, e instanceof Error ? e.message : String(e)); return false; }
  }
  /** Consulta os sensores que estão no prazo (chamado pelo agendador). */
  async pollDue(): Promise<void> {
    const now = this.clock.now();
    await Promise.all(this.store.sensors().filter((s) => now - (this.lastPoll.get(s.id) ?? 0) >= POLL_EVERY_MS).map((s) => this.poll(s)));
  }

  record(s: SensorRow, r: SensorReading) {
    const now = this.clock.now();
    this.store.setSensorReading(s.id, now, r.temperature ?? null, r.humidity ?? null);
    if (now - (this.lastStored.get(s.id) ?? 0) >= STORE_EVERY_MS) {
      const cur = this.store.sensor(s.id)!;
      this.store.insertSensorReading(s.id, now, cur.lastTemp, cur.lastHum);
      this.lastStored.set(s.id, now);
    }
    this.bus.publish({ type: "sensor.reading", sensorId: s.id });
    for (const l of this.listeners) { try { l(); } catch { /* ouvinte não derruba a coleta */ } }
  }

  /** Última temperatura do sensor (para automações). */
  tempOf(id: string): { value: number; at: number } | undefined {
    const s = this.store.sensor(id);
    return s && s.lastTemp !== null && s.lastTs !== null ? { value: s.lastTemp, at: s.lastTs } : undefined;
  }
  dto(s: SensorRow): SensorDto {
    return { id: s.id, name: s.name, pollUrl: s.pollUrl, deviceId: s.deviceId, lastSeenAt: s.lastTs, temperature: s.lastTemp, humidity: s.lastHum, online: s.lastTs !== null && this.clock.now() - s.lastTs <= SENSOR_ONLINE_MS, lastError: s.lastError };
  }
  list(): SensorDto[] { return this.store.sensors().map((s) => this.dto(s)); }
}
