import { ProviderError } from "@acc/domain";
import type { AttributePatch, Capabilities, Clock, DeviceEvent, EnergyCapabilities, EnergyPoint, EnergyQuery, Mode, NormalizedState, ProviderHealth, StateField } from "@acc/domain";
import { STATE_FIELDS, systemClock } from "@acc/domain";
import type { ACProvider, ProviderDevice, Unsubscribe } from "@acc/provider-api";

export interface FakeOptions {
  clock?: Clock;
  energy?: boolean;          // simula aparelho com/sem energia
  ambientC?: number;         // temperatura externa/ambiente base
  failNext?: ProviderError[]; // falhas injetadas em setAttributes (consumidas em ordem)
  tz?: string;               // fuso usado para "dia local" da energia simulada
}

const CAPS = (energy: boolean): Capabilities => ({
  power: true,
  temperature: { min: 18, max: 30, step: 1 },
  modes: ["cool", "dry", "fan", "auto", "heat"],
  fan: { values: ["low", "mid", "high", "auto"] },
  swing: { vertical: true, horizontal: false },
  powerSave: true,
  humiditySensor: false,
  energy: { supported: energy, granularities: energy ? ["day", "month"] : [], unit: "Wh", properties: energy ? ["energyUsage"] : [] },
});

/** Provider simulado: física térmica simples (1 °C a cada ~6 min ligado em cool) e injeção de falhas. */
export class FakeProvider implements ACProvider {
  readonly id = "fake";
  private clock: Clock;
  private state: NormalizedState;
  private lastTick: number;
  private handlers = new Set<(e: DeviceEvent | ProviderHealth) => void>();
  private ambient: number;
  public failNext: ProviderError[];
  public commands: AttributePatch[] = [];
  public offline = false;
  private caps: Capabilities;
  private temp: number;
  /** Wh acumulados por dia local simulados (para getEnergyUsage). */
  private whByDay = new Map<string, number>();
  private tz: string;

  constructor(opts: FakeOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.tz = opts.tz ?? "America/Sao_Paulo";
    this.ambient = opts.ambientC ?? 29;
    this.temp = this.ambient;
    this.failNext = opts.failNext ?? [];
    this.caps = CAPS(opts.energy ?? true);
    this.lastTick = this.clock.now();
    this.state = { power: false, mode: "cool", targetTemp: 24, currentTemp: this.temp, fan: "auto", online: true };
  }

  async getDevices(): Promise<ProviderDevice[]> { return [{ externalId: "fake-ac-1", name: "Ar da sala (fake)", model: "FAKE_001" }]; }
  async getCapabilities(): Promise<Capabilities> { return this.caps; }
  async getState(): Promise<NormalizedState> { this.guardOnline(); this.advance(); return { ...this.state, currentTemp: round1(this.temp) }; }

  async setAttributes(_id: string, patch: AttributePatch): Promise<void> {
    this.guardOnline();
    const fail = this.failNext.shift();
    if (fail) throw fail;
    const t = this.caps.temperature!;
    if (patch.targetTemp !== undefined && (patch.targetTemp < t.min || patch.targetTemp > t.max || (patch.targetTemp - t.min) % t.step !== 0))
      throw new ProviderError("invalidCommand", `targetTemp ${patch.targetTemp} fora de ${t.min}-${t.max}/${t.step}`, { code: "2207" });
    if (patch.mode && !this.caps.modes.includes(patch.mode)) throw new ProviderError("invalidCommand", `modo ${patch.mode} não suportado`, { code: "2207" });
    if (patch.fan && !this.caps.fan!.values.includes(patch.fan)) throw new ProviderError("invalidCommand", `fan ${patch.fan} não suportado`, { code: "2207" });
    if (this.state.power === false && patch.power !== true && (patch.targetTemp !== undefined || patch.mode || patch.fan))
      throw new ProviderError("notSupportedInState", "comando não suportado com o aparelho desligado", { code: "2304" });
    if (patch.power !== undefined && patch.power === this.state.power)
      throw new ProviderError("notSupportedInState", "aparelho já está nesse estado", { code: patch.power ? "2302" : "2304" });
    this.advance();
    this.commands.push(patch);
    const changed: StateField[] = [];
    const set = <K extends StateField>(k: K, v: NormalizedState[K] | undefined) => { if (v !== undefined && this.state[k] !== v) { this.state[k] = v; changed.push(k); } };
    set("power", patch.power); set("mode", patch.mode as Mode | undefined); set("targetTemp", patch.targetTemp); set("fan", patch.fan);
    if (changed.length) this.emit(changed, "mqtt");
  }

  async getEnergyCapabilities(): Promise<EnergyCapabilities> { return this.caps.energy; }
  async getEnergyUsage(_id: string, q: EnergyQuery): Promise<EnergyPoint[]> {
    if (!this.caps.energy.supported) throw new ProviderError("unsupported", "sem energia", { code: "1221" });
    this.advance();
    const collectedAt = this.clock.now();
    // como a LG real: o dia corrente sempre aparece (mesmo com 0 Wh)
    const todayKey = new Intl.DateTimeFormat("en-CA", { timeZone: this.tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(collectedAt);
    if (!this.whByDay.has(todayKey)) this.whByDay.set(todayKey, 0);
    if (q.granularity === "day") return [...this.whByDay].filter(([d]) => d >= q.from && d <= q.to).sort().map(([key, wh]) => ({ key, granularity: "day" as const, wh, collectedAt }));
    const months = new Map<string, number>();
    for (const [d, wh] of this.whByDay) months.set(d.slice(0, 7), (months.get(d.slice(0, 7)) ?? 0) + wh);
    return [...months].filter(([m]) => m >= q.from && m <= q.to).sort().map(([key, wh]) => ({ key, granularity: "month" as const, wh, collectedAt }));
  }

  async subscribeEvents(h: (e: DeviceEvent | ProviderHealth) => void): Promise<Unsubscribe> {
    this.handlers.add(h);
    h({ type: "health", status: "connected", at: this.clock.now() });
    return () => { this.handlers.delete(h); };
  }

  // --- controles de teste ---
  /** Avança a simulação e emite um evento parcial com a temperatura (como o push real). */
  tick(emit = true) { this.advance(); if (emit && !this.offline) this.emit(["currentTemp"], "mqtt"); }
  /** Simula mudança feita fora do app (controle remoto/ThinQ). */
  externalChange(patch: AttributePatch) {
    this.advance();
    const changed: StateField[] = [];
    for (const [k, v] of Object.entries(patch)) { const key = ({ power: "power", mode: "mode", targetTemp: "targetTemp", fan: "fan" } as Record<string, StateField>)[k]; if (key && (this.state as any)[key] !== v) { (this.state as any)[key] = v; changed.push(key); } }
    if (changed.length) this.emit(changed, "mqtt");
  }
  setAmbient(c: number) { this.advance(); this.ambient = c; }
  setHealth(status: ProviderHealth["status"]) { this.handlers.forEach((h) => h({ type: "health", status, at: this.clock.now() })); }
  /** Emite um evento com campos arbitrários (para testar payload parcial). */
  emitPartial(fields: NormalizedState) { this.emit(Object.keys(fields) as StateField[], "mqtt", fields); }

  private guardOnline() { if (this.offline) throw new ProviderError("offline", "aparelho offline", { code: "1222" }); }
  private emit(fields: StateField[], source: DeviceEvent["source"], override?: NormalizedState) {
    const src = override ?? { ...this.state, currentTemp: round1(this.temp) };
    const normalizedState: NormalizedState = {};
    for (const f of STATE_FIELDS) if (fields.includes(f) && src[f] !== undefined) (normalizedState as any)[f] = src[f];
    const ev: DeviceEvent = { type: "state", deviceId: "fake-ac-1", receivedAt: this.clock.now(), source, fieldsPresent: fields, normalizedState };
    this.handlers.forEach((h) => h(ev));
  }
  /** Física: ligado em cool/auto esfria até o alvo (−1 °C / 6 min, assintótico); desligado sobe até ambiente (+1 °C / 20 min). Wh ~ 600 W em regime ligado. */
  private advance() {
    const now = this.clock.now();
    const dt = (now - this.lastTick) / 60000; // minutos
    this.lastTick = now;
    if (dt <= 0) return;
    if (this.state.power) {
      const target = this.state.targetTemp ?? 24;
      if (this.state.mode === "cool" || this.state.mode === "auto") this.temp = Math.max(target, this.temp - dt / 6);
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: this.tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
      this.whByDay.set(day, (this.whByDay.get(day) ?? 0) + (600 * dt) / 60);
    } else {
      this.temp = Math.min(this.ambient, this.temp + dt / 20);
    }
  }
}
const round1 = (n: number) => Math.round(n * 10) / 10;
